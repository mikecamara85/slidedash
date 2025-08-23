/**
 * Slideshow generator with OpenAI TTS narration.
 *
 * Pipeline overview:
 * 1) Generate narration via OpenAI TTS (prefer WAV to avoid lossy artifacts).
 * 2) Optionally retime narration speed while preserving pitch (ffmpeg atempo).
 * 3) Add a small lead-in silence so video doesn't start abruptly.
 * 4) Optionally mix background music with narration at a lower volume.
 * 5) Resize images to a target canvas (letterboxed or pillarboxed).
 * 6) Build a concat list with per-image durations so total = audio duration.
 * 7) Assemble final MP4 (H.264 video + AAC audio, faststart).
 *
 * Notes:
 * - Uses ffmpeg-static + ffprobe installer for portability.
 * - Keeps sample rate at 24 kHz mono throughout for TTS chain, then final AAC stereo for broad compatibility.
 * - Cleans up a per-request temp working directory at the end (best-effort).
 */

import "dotenv/config";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import os from "os";
import { OpenAI } from "openai";

// Force fluent-ffmpeg to use static binaries for portability/reproducibility.
// This avoids depending on system-installed ffmpeg/ffprobe versions.
ffmpeg.setFfmpegPath(ffmpegStatic as string);
ffmpeg.setFfprobePath(ffprobe.path);

type VoiceType = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

// ========== OpenAI TTS ==========
// Initialize a single OpenAI client for reuse. Reads key from env.
// Make sure OPENAI_API_KEY is set in your environment.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Default TTS model, overridable via env. gpt-4o-mini-tts is fast and natural.
const DEFAULT_TTS_MODEL =
  (process.env.TTS_MODEL as string) || "gpt-4o-mini-tts";

/**

Sort image paths "smartly":
If any filenames (ignoring a leading "0000-" index prefix) contain digits,
put those numeric-named files first, ordered by that number.
Files without digits go last (e.g., "zz.jpg", "zzz.jpg").
Ties are broken by natural string compare, then by the original index prefix ("0000-"),
and finally by the original array index to keep the sort stable.
If no files have digits at all, fall back to the index prefix order (or natural name). */
function smartSortImages(paths: string[], clientLocale?: string): string[] {
  // Natural/locale-aware comparator that understands numeric fragments ("10" > "2").

  const collator = new Intl.Collator(clientLocale || "en", {
    numeric: true,
    sensitivity: "base",
  });

  // Preprocess each path into sortable fields
  const items = paths.map((p, idx) => {
    const base = path.basename(p);

    // Detect and parse a leading zero-padded index prefix we add upstream, e.g. "0003-"
    // If no prefix, use +Infinity so non-prefixed names sort after prefixed ones in that mode.
    const mPrefix = base.match(/^(\d{2,})-/);
    const prefixIdx = mPrefix
      ? parseInt(mPrefix[1], 10)
      : Number.POSITIVE_INFINITY;

    // Remove the index prefix for "real" filename comparisons
    const nameNoPrefix = base.replace(/^\d{2,}-/, "");

    // Extract the "best" numeric token from the filename (no prefix):
    // - choose the longest run of digits
    // - if there are ties, choose the last occurrence
    // This works for patterns like IMG_1015.jpg, DSC01234.png, PXL_20240102_123456.jpg, etc.
    let bestNum: number | undefined;
    let bestLen = -1;
    let bestPos = -1;
    for (const m of nameNoPrefix.matchAll(/\d+/g)) {
      const s = m[0];
      const len = s.length;
      const pos = m.index ?? 0;
      if (len > bestLen || (len === bestLen && pos > bestPos)) {
        bestLen = len;
        bestPos = pos;
        bestNum = parseInt(s, 10);
      }
    }

    // idx keeps original input order as a last-resort stable tiebreaker
    return { p, idx, base, prefixIdx, nameNoPrefix, num: bestNum };
  });

  // If any file has a numeric token, we enable "numeric mode"
  const withNums = items.filter((x) => typeof x.num === "number");
  const numericMode = withNums.length > 0;

  items.sort((a, b) => {
    if (numericMode) {
      // Numeric files first; non-numeric files (e.g., zz.jpg) go to the end
      const aHas = typeof a.num === "number";
      const bHas = typeof b.num === "number";

      if (aHas && bHas) {
        // Both numeric: sort by the extracted number
        if (a.num! !== b.num!) return a.num! - b.num!;
        // Tie: natural compare of names without the prefix
        const c = collator.compare(a.nameNoPrefix, b.nameNoPrefix);
        if (c !== 0) return c;
        // Next tie-breaker: the index prefix ("0000-", "0001-", …)
        if (a.prefixIdx !== b.prefixIdx) return a.prefixIdx - b.prefixIdx;
        // Final tie-breaker: original input order (stable)
        return a.idx - b.idx;
      }

      // Only one has number → numeric first
      if (aHas) return -1;
      if (bHas) return 1;

      // Neither has number: fall back to prefix index, then original order
      if (a.prefixIdx !== b.prefixIdx) return a.prefixIdx - b.prefixIdx;
      return a.idx - b.idx;
    } else {
      // No numeric info anywhere: preserve the prefixed order if present,
      // else natural compare on the full basename; then original order
      if (a.prefixIdx !== b.prefixIdx) return a.prefixIdx - b.prefixIdx;
      const c = collator.compare(a.base, b.base);
      if (c !== 0) return c;
      return a.idx - b.idx;
    }
  });

  // Return the paths in the new order
  return items.map((x) => x.p);
}

/**
 * Generate speech audio from text using OpenAI TTS.
 *
 * Why WAV? WAV avoids additional encoding artifacts when we later process speed,
 * mix, etc. If you need smaller intermediate files, use MP3 but expect compounding losses.
 *
 * @param text        The narration text (can be multiple sentences).
 * @param outputPath  Where to write the generated audio file.
 * @param voice       One of the supported voices.
 * @param model       TTS model to use (defaults to DEFAULT_TTS_MODEL).
 * @param format      Output format ("wav" recommended; "mp3" supported).
 *
 */
async function generateTTS(
  text: string,
  outputPath: string,
  voice: VoiceType = "shimmer",
  model: string = DEFAULT_TTS_MODEL,
  format: "wav" | "mp3" = "wav"
): Promise<void> {
  // If you anticipate very long text, consider chunking to respect TTS limits.
  const res = await openai.audio.speech.create({
    model,
    voice,
    input: text,
    // SDK supports specifying output format; WAV recommended here.
    // @ts-ignore: Some SDK versions may not type 'format' yet.
    format,
  });

  // Persist to disk as a Node Buffer.
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buf);
}

/**
 * Retimes audio while preserving pitch using ffmpeg's atempo filter.
 * atempo only supports 0.5–2.0, so we split outside that range into multiple steps.
 *
 * @param inputPath   Original audio file path.
 * @param outputPath  Where to write the retimed audio.
 * @param speed       Playback speed multiplier (> 0). 1 = unchanged, 0.8 = slower, 1.25 = faster.
 */
async function retimeAudio(
  inputPath: string,
  outputPath: string,
  speed = 1
): Promise<void> {
  if (!isFinite(speed) || speed <= 0) throw new Error("speechRate must be > 0");

  // Short-circuit if no speed change requested.
  if (Math.abs(speed - 1) < 1e-3) {
    if (inputPath !== outputPath) fs.copyFileSync(inputPath, outputPath);
    return;
  }

  // Build a chain of atempo filters so each step stays within [0.5, 2.0].
  const filters: string[] = [];
  let s = speed;
  while (s < 0.5) {
    filters.push("atempo=0.5");
    s /= 0.5;
  }
  while (s > 2.0) {
    filters.push("atempo=2.0");
    s /= 2.0;
  }
  filters.push(`atempo=${s.toFixed(3)}`);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(filters)
      // Normalize to mono 24 kHz to keep the TTS chain consistent and compact.
      .outputOptions(["-ar", "24000", "-ac", "1", "-y"])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

/**
 * Prepend leading silence to an audio file, using only ffmpeg (no external files).
 *
 * Useful to avoid abrupt start when video begins immediately.
 *
 * @param inputAudioPath   Path to the audio you want to pad.
 * @param outputAudioPath  Path to write the padded audio.
 * @param ms               Milliseconds of silence to prepend (default 500 ms).
 */
async function addLeadInSilence(
  inputAudioPath: string,
  outputAudioPath: string,
  ms = 500
): Promise<void> {
  // anullsrc generates a silent audio source.
  // We specify mono, 24 kHz for consistency with the rest of the pipeline.
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(`anullsrc=channel_layout=mono:sample_rate=24000`)
      .inputOptions(["-f", "lavfi", "-t", `${(ms / 1000).toFixed(3)}`]) // exact silence duration
      .input(inputAudioPath)
      // Concatenate silence [0:a] and input [1:a] into a single stream [a].
      .complexFilter("[0:a][1:a]concat=n=2:v=0:a=1[a]")
      .outputOptions(["-map", "[a]", "-ar", "24000", "-ac", "1", "-y"])
      .save(outputAudioPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

/**
 * Get audio duration in seconds using ffprobe metadata.
 *
 * @param audioPath Path to audio file.
 * @returns Number of seconds (float).
 */
function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format?.duration ?? 0);
    });
  });
}

/**
 * Resize a list of images to a fixed canvas using Sharp.
 * We "contain" the image inside the target dimensions, letterboxing/pillarboxing with a black background.
 *
 * @param inputPaths Array of image file paths.
 * @param outputDir  Where resized output images will be written.
 * @param width      Target width (e.g., 800).
 * @param height     Target height (e.g., 600).
 * @returns          Array of paths to the generated JPEG slides.
 */
async function resizeImages(
  inputPaths: string[],
  outputDir: string,
  width: number,
  height: number
): Promise<string[]> {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const tasks = inputPaths.map(async (src, idx) => {
    const dest = path.join(
      outputDir,
      `slide${idx.toString().padStart(3, "0")}.jpg`
    );
    await sharp(src)
      .resize(width, height, { fit: "contain", background: "#000" }) // keep aspect ratio, fill remainder with black
      .jpeg({ quality: 90 }) // good balance between quality and size
      .toFile(dest);
    return dest;
  });

  return Promise.all(tasks);
}

/**
 * Create an ffmpeg concat demuxer list file with per-image durations.
 *
 * Important: In the concat demuxer, "duration X" applies to the previous "file" line.
 * We repeat the last "file" entry so that ffmpeg holds the last frame for its duration.
 *
 * @param images   Ordered list of image paths.
 * @param duration Duration in seconds for each image (except last entry which is enforced by repeat).
 * @param listPath Where to write the concat list file.
 */
function createConcatListFile(
  images: string[],
  duration: number,
  listPath: string
) {
  const lines: string[] = [];

  for (let i = 0; i < images.length; i++) {
    // Escape single quotes for shell-safety in the concat file.
    const safe = images[i].replace(/'/g, "'\\''");
    lines.push(`file '${safe}'`);

    // "duration" pertains to the file line immediately above it; skip after final image.
    if (i < images.length - 1) lines.push(`duration ${duration}`);
  }

  // Repeat the last image line to ensure the final frame remains displayed.
  const lastSafe = images[images.length - 1].replace(/'/g, "'\\''");
  lines.push(`file '${lastSafe}'`);

  fs.writeFileSync(listPath, lines.join("\n"), "utf-8");
}

/**
 * Mix narration with background music.
 *
 * We lower the background volume, then use amix to combine the two.
 * duration=first ensures the output stops when the first input (narration) ends.
 * dropout_transition helps avoid clicks if one input ends before the other.
 *
 * @param narrationPath Path to the narration (foreground).
 * @param backgroundPath Path to background music audio.
 * @param outputPath Where to write the mixed result.
 * @param ttsLength Duration (seconds) to trim output to match narration.
 * @param musicVolume Linear volume multiplier for music (e.g., 0.15 = -16.5 dB).
 */
async function mixNarrationWithBackground(
  narrationPath: string,
  backgroundPath: string,
  outputPath: string,
  ttsLength: number,
  musicVolume: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(narrationPath)
      .input(backgroundPath)
      .complexFilter([
        // Scale background volume, then mix with narration.
        `[1:a]volume=${musicVolume}[bg]`,
        `[0:a][bg]amix=inputs=2:duration=first:dropout_transition=3[a]`,
      ])
      // Map mixed audio and hard-limit length to match narration precisely.
      .outputOptions(["-map", "[a]", "-t", ttsLength.toString(), "-y"])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

/**
 * Create a unique temp working directory for a single slideshow build.
 * Using OS temp dir helps prevent clutter and conflicts across runs.
 */
function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slideshow-"));
}

// --- Main function ---

/**
 * Build a narrated slideshow video from a set of images and text.
 *
 * @param images                Paths to images. They will be sorted by filename.
 * @param narrationText         Text to be synthesized by TTS for narration.
 * @param output                Output video path (e.g., out.mp4).
 * @param width                 Video width in pixels (default 800).
 * @param height                Video height in pixels (default 600).
 * @param voice                 TTS voice (default "shimmer").
 * @param backgroundMusicPath   Optional background music file path.
 * @param musicVolume           Background music volume (0–1). Default 0.15.
 * @param speechRate            TTS playback speed multiplier (> 0). Default 1.
 */
export async function createSlideshowWithTTS(
  images: string[],
  narrationText: string,
  output: string,
  width: number = 800,
  height: number = 600,
  voice: VoiceType = "shimmer",
  backgroundMusicPath?: string,
  musicVolume: number = 0.15,
  speechRate: number = 1,
  clientLocale: string = "en"
): Promise<void> {
  // Create isolated working directories for audio and frames.
  const work = makeWorkDir();
  const audioDir = path.join(work, "audio");
  const framesDir = path.join(work, "frames");
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });

  // Audio intermediates
  const ttsRaw = path.join(audioDir, "tts_raw.wav"); // pristine TTS output (lossless)
  const ttsTimed = path.join(audioDir, "tts_timed.wav"); // after retiming
  const ttsPadded = path.join(audioDir, "tts_padded.wav"); // with lead-in silence
  const mixedAudio = path.join(audioDir, "tts_mixed.wav"); // narration + music
  const concatList = path.join(work, "list.txt"); // ffmpeg concat list for images

  // Optional ffmpeg command logging to help debug complex filter graphs.
  const logFfmpeg = (cmd: string) => console.log("[ffmpeg]", cmd);

  try {
    // 1) Text-to-Speech
    // If text is large or you need multiple languages, consider splitting by sentences and stitching later.
    await generateTTS(narrationText, ttsRaw, voice, undefined, "wav");

    // 2) Retiming (speed change) while keeping pitch consistent.
    await retimeAudio(ttsRaw, ttsTimed, speechRate);

    // 3) Add a short silence to the start to avoid abrupt starts and allow first frame to be shown.
    await addLeadInSilence(ttsTimed, ttsPadded, 500);

    // 4) Probe final narration duration (after retime + padding).
    const audioDuration = await getAudioDuration(ttsPadded);

    // 5) Optionally mix in background music at a lower level.
    // The output is trimmed to narration length so video length remains consistent.
    let finalAudioPath = ttsPadded;
    if (backgroundMusicPath) {
      await mixNarrationWithBackground(
        ttsPadded,
        backgroundMusicPath,
        mixedAudio,
        audioDuration,
        musicVolume
      );
      finalAudioPath = mixedAudio;
    }

    // 6) Prepare frames (image ordering + resizing)
    // Sort by basename to keep a predictable sequence if input order isn't guaranteed.
    const orderedImages = smartSortImages(images, clientLocale);
    console.log(orderedImages);

    const resizedImages = await resizeImages(
      orderedImages,
      framesDir,
      width,
      height
    );
    if (!resizedImages.length) throw new Error("No images provided");

    // Distribute total audio duration across slides.
    // We enforce a minimum per-slide duration to avoid too-rapid transitions.
    const durationPerSlide = Math.max(
      0.5,
      audioDuration / resizedImages.length
    );
    createConcatListFile(resizedImages, durationPerSlide, concatList);

    // 7) Assemble video with audio:
    // - Use concat demuxer for still images with durations.
    // - 30 fps H.264 video, yuv420p pixel format for compatibility.
    // - AAC stereo audio at 192 kbps (broad compatibility).
    // - -shortest so we don't exceed audio length if something drifts.
    // - +faststart to move moov atom for immediate playback over HTTP.
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .on("start", logFfmpeg) // logs the full command line ffmpeg invokes
        .input(concatList)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .input(finalAudioPath)
        .outputOptions([
          "-r", // set the output frame rate flag
          "30", // 30 frames per second; common/web-friendly output cadence

          "-c:v", // choose the video codec
          "libx264", // use x264 (H.264) encoder for broad compatibility and efficiency

          "-pix_fmt", // set the pixel format of the encoded video
          "yuv420p", // 8-bit 4:2:0; required by many players (Safari, TVs) for compatibility

          "-movflags", // set MP4/MOV container flags
          "+faststart", // move 'moov' atom to beginning so video starts faster over HTTP (progressive)

          "-c:a", // choose the audio codec
          "aac", // AAC is the de-facto standard in MP4; widely supported

          "-b:a", // set the audio bitrate
          "192k", // 192 kbps; good quality default (128k often fine for speech)

          "-ac", // set the number of audio channels
          "2", // stereo output; maximizes compatibility (some platforms expect 2 ch)

          "-shortest", // stop encoding when the shortest input (usually audio) ends

          "-y", // overwrite the output file if it already exists (no prompt)
        ])
        .save(output)
        .on("end", () => resolve())
        .on("error", reject);
    });
  } finally {
    // Best-effort cleanup of temp files to avoid filling disk.
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (e) {
      console.warn("Temp cleanup failed:", e);
    }
  }
}
