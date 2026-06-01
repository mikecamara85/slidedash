import "dotenv/config";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobe from "@ffprobe-installer/ffprobe";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import os from "os";

import { config, type VoiceType } from "./config";
import { openai } from "./openaiClient";

ffmpeg.setFfmpegPath(ffmpegStatic as string);
ffmpeg.setFfprobePath(ffprobe.path);

function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slideshow-"));
}

async function generateTTS(
  text: string,
  outputPath: string,
  voice: VoiceType = "shimmer",
  model: string = config.openai.ttsModel,
  format: "wav" | "mp3" = "wav",
): Promise<void> {
  const res = await openai.audio.speech.create({
    model,
    voice,
    input: text,
    // @ts-ignore
    format,
  });

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buf);
}

async function retimeAudio(
  inputPath: string,
  outputPath: string,
  speed = 1,
): Promise<void> {
  if (!isFinite(speed) || speed <= 0) {
    throw new Error("speechRate must be > 0");
  }

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

async function addLeadInSilence(
  inputAudioPath: string,
  outputAudioPath: string,
  ms = 500,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(`anullsrc=channel_layout=mono:sample_rate=24000`)
      .inputOptions(["-f", "lavfi", "-t", `${(ms / 1000).toFixed(3)}`])
      .input(inputAudioPath)
      .complexFilter("[0:a][1:a]concat=n=2:v=0:a=1[a]")
      .outputOptions(["-map", "[a]", "-ar", "24000", "-ac", "1", "-y"])
      .save(outputAudioPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

export function probeMediaDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format?.duration ?? 0);
    });
  });
}

async function resizeImages(
  inputPaths: string[],
  outputDir: string,
  width: number,
  height: number,
): Promise<string[]> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const tasks = inputPaths.map(async (src, idx) => {
    const dest = path.join(
      outputDir,
      `slide${idx.toString().padStart(3, "0")}.jpg`,
    );

    await sharp(src)
      .resize(width, height, { fit: "contain", background: "#000" })
      .jpeg({ quality: 90 })
      .toFile(dest);

    return dest;
  });

  return Promise.all(tasks);
}

function createConcatListFile(
  images: string[],
  duration: number,
  listPath: string,
) {
  const lines: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const safe = images[i].replace(/'/g, "'\\''");
    lines.push(`file '${safe}'`);

    if (i < images.length - 1) {
      lines.push(`duration ${duration}`);
    }
  }

  const lastSafe = images[images.length - 1].replace(/'/g, "'\\''");
  lines.push(`file '${lastSafe}'`);

  fs.writeFileSync(listPath, lines.join("\n"), "utf-8");
}

async function mixNarrationWithBackground(
  narrationPath: string,
  backgroundPath: string,
  outputPath: string,
  ttsLength: number,
  musicVolume: number,
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

/**
 * Important behavior:
 * - Images are used in the exact order provided.
 * - No filename-based re-sorting is performed.
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
  _clientLocale: string = "en",
): Promise<void> {
  const work = makeWorkDir();
  const audioDir = path.join(work, "audio");
  const framesDir = path.join(work, "frames");

  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const ttsRaw = path.join(audioDir, "tts_raw.wav");
  const ttsTimed = path.join(audioDir, "tts_timed.wav");
  const ttsPadded = path.join(audioDir, "tts_padded.wav");
  const mixedAudio = path.join(audioDir, "tts_mixed.wav");
  const concatList = path.join(work, "list.txt");

  const logFfmpeg = (cmd: string) => console.log("[ffmpeg]", cmd);

  try {
    await generateTTS(
      narrationText,
      ttsRaw,
      voice,
      config.openai.ttsModel,
      "wav",
    );
    await retimeAudio(ttsRaw, ttsTimed, speechRate);
    await addLeadInSilence(ttsTimed, ttsPadded, 500);

    const audioDuration = await probeMediaDurationSeconds(ttsPadded);

    let finalAudioPath = ttsPadded;
    if (backgroundMusicPath) {
      await mixNarrationWithBackground(
        ttsPadded,
        backgroundMusicPath,
        mixedAudio,
        audioDuration,
        musicVolume,
      );
      finalAudioPath = mixedAudio;
    }

    if (!images.length) {
      throw new Error("No images provided");
    }

    const resizedImages = await resizeImages(images, framesDir, width, height);

    if (!resizedImages.length) {
      throw new Error("No images provided");
    }

    const durationPerSlide = Math.max(
      0.5,
      audioDuration / resizedImages.length,
    );
    createConcatListFile(resizedImages, durationPerSlide, concatList);

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
          "2",
          "-shortest",
          "-y",
        ])
        .save(output)
        .on("end", () => resolve())
        .on("error", reject);
    });
  } finally {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (e) {
      console.warn("Temp cleanup failed:", e);
    }
  }
}
