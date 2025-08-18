import "dotenv/config";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { OpenAI } from "openai";
import { randomUUID } from "crypto";

// Force fluent-ffmpeg to use static binaries (portable)
ffmpeg.setFfmpegPath(ffmpegStatic as string);
ffmpeg.setFfprobePath(ffprobe.path);

type VoiceType = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

// ========== OpenAI TTS ==========
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const DEFAULT_TTS_MODEL =
  (process.env.TTS_MODEL as string) || "gpt-4o-mini-tts";

// Generate speech audio. Prefer wav to avoid mp3 re-encode artifacts.
async function generateTTS(
  text: string,
  outputPath: string,
  voice: VoiceType = "shimmer",
  model: string = DEFAULT_TTS_MODEL,
  format: "wav" | "mp3" = "wav"
): Promise<void> {
  const res = await openai.audio.speech.create({
    model,
    voice,
    input: text,
    // format is supported by the SDK; fall back to mp3 if needed
    // @ts-ignore
    format,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buf);
}

// Pitch-preserving retime via atempo (splitting outside [0.5,2] into steps)
async function retimeAudio(
  inputPath: string,
  outputPath: string,
  speed = 1
): Promise<void> {
  if (!isFinite(speed) || speed <= 0) throw new Error("speechRate must be > 0");
  if (Math.abs(speed - 1) < 1e-3) {
    if (inputPath !== outputPath) fs.copyFileSync(inputPath, outputPath);
    return;
  }
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
      .outputOptions(["-ar", "24000", "-ac", "1", "-y"])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

// Generate 500ms leading silence via ffmpeg (no external files)
async function addLeadInSilence(
  inputAudioPath: string,
  outputAudioPath: string,
  ms = 500
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      // Mono 24kHz silence for ms duration
      .input(`anullsrc=channel_layout=mono:sample_rate=24000`)
      .inputOptions(["-f", "lavfi", `-t`, `${(ms / 1000).toFixed(3)}`])
      .input(inputAudioPath)
      .complexFilter("[0:a][1:a]concat=n=2:v=0:a=1[a]")
      .outputOptions(["-map", "[a]", "-ar", "24000", "-ac", "1", "-y"])
      .save(outputAudioPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

// Utility to get audio duration (seconds)
function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format?.duration ?? 0);
    });
  });
}

// Resize images to a target canvas
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
      .resize(width, height, { fit: "contain", background: "#000" })
      .jpeg({ quality: 90 })
      .toFile(dest);
    return dest;
  });
  return Promise.all(tasks);
}

// Create ffmpeg concat list file with per-image durations
function createConcatListFile(
  images: string[],
  duration: number,
  listPath: string
) {
  const lines: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const safe = images[i].replace(/'/g, "'\\''");
    lines.push(`file '${safe}'`);
    if (i < images.length - 1) lines.push(`duration ${duration}`);
  }
  // Repeat the last image to enforce final frame display
  const lastSafe = images[images.length - 1].replace(/'/g, "'\\''");
  lines.push(`file '${lastSafe}'`);
  fs.writeFileSync(listPath, lines.join("\n"), "utf-8");
}

// Mix narration and background; output is trimmed to narration length
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
        `[1:a]volume=${musicVolume}[bg]`,
        `[0:a][bg]amix=inputs=2:duration=first:dropout_transition=3[a]`,
      ])
      .outputOptions(["-map", "[a]", "-t", ttsLength.toString(), "-y"])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

// Helper: per-request temp dir
function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slideshow-"));
}

// --- Main function ---
export async function createSlideshowWithTTS(
  images: string[],
  narrationText: string,
  output: string,
  width: number = 800,
  height: number = 600,
  voice: VoiceType = "shimmer",
  backgroundMusicPath?: string,
  musicVolume: number = 0.15,
  speechRate: number = 1
): Promise<void> {
  const work = makeWorkDir();
  const audioDir = path.join(work, "audio");
  const framesDir = path.join(work, "frames");
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const ttsRaw = path.join(audioDir, "tts_raw.wav"); // lossless from TTS
  const ttsTimed = path.join(audioDir, "tts_timed.wav");
  const ttsPadded = path.join(audioDir, "tts_padded.wav");
  const mixedAudio = path.join(audioDir, "tts_mixed.wav");
  const concatList = path.join(work, "list.txt");

  // Optional logging for debugging ffmpeg issues:
  const logFfmpeg = (cmd: string) => console.log("[ffmpeg]", cmd);

  try {
    // 1) TTS
    await generateTTS(narrationText, ttsRaw, voice, undefined, "wav");

    // 2) Retiming
    await retimeAudio(ttsRaw, ttsTimed, speechRate);

    // 3) Lead-in silence
    await addLeadInSilence(ttsTimed, ttsPadded, 500);

    // 4) Duration
    const audioDuration = await getAudioDuration(ttsPadded);

    // 5) Background mix (optional)
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

    // 6) Frames
    console.log(images);
    const orderedImages = images.slice().sort((a, b) => {
      const A = path.basename(a);
      const B = path.basename(b);
      if (A < B) return -1;
      if (A > B) return 1;
      return 0;
    });

    console.log(orderedImages);

    const resizedImages = await resizeImages(
      orderedImages,
      framesDir,
      width,
      height
    );
    if (!resizedImages.length) throw new Error("No images provided");
    const durationPerSlide = Math.max(
      0.5,
      audioDuration / resizedImages.length
    ); // guard minimum
    createConcatListFile(resizedImages, durationPerSlide, concatList);

    // 7) Assemble video (H.264 + AAC stereo, faststart for streaming)
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .on("start", logFfmpeg)
        .input(concatList)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .input(finalAudioPath)
        .outputOptions([
          "-r",
          "30",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-c:a",
          "aac",
          "-b:a",
          "192k",
          "-ac",
          "2", // stereo for maximum compatibility
          "-shortest",
          "-y",
        ])
        .save(output)
        .on("end", () => resolve())
        .on("error", reject);
    });
  } finally {
    // Best-effort cleanup
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (e) {
      console.warn("Temp cleanup failed:", e);
    }
  }
}
