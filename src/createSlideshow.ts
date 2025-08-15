import "dotenv/config";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import { OpenAI } from "openai";

// Type for voices
type VoiceType = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";

// ========== OpenAI TTS Setup ==========
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Choose newer TTS by default; override with TTS_MODEL env if needed.
const DEFAULT_TTS_MODEL =
  (process.env.TTS_MODEL as string) || "gpt-4o-mini-tts";

// Generate speech mp3 from text using OpenAI TTS
async function generateTTS(
  text: string,
  outputPath: string,
  voice: VoiceType = "shimmer",
  model: string = DEFAULT_TTS_MODEL
): Promise<void> {
  const mp3Stream = await openai.audio.speech.create({
    model,
    voice,
    input: text,
  });
  const buffer = Buffer.from(await mp3Stream.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
}

// Pitch-preserving retime via ffmpeg's atempo (0.5–2.0 per stage)
async function retimeAudio(
  inputPath: string,
  outputPath: string,
  speed: number = 1
): Promise<void> {
  if (!isFinite(speed) || speed <= 0) {
    throw new Error("speechRate must be a positive number");
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
      .outputOptions(["-ar", "24000", "-ac", "1", "-b:a", "128k", "-y"])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

// Add this helper to prepend your provided silence mp3 to the TTS file
async function prependSilence(
  inputAudioPath: string,
  outputAudioPath: string,
  silencePath: string = path.join(
    __dirname,
    "audio",
    "500-milliseconds-of-silence.mp3"
  )
): Promise<void> {
  const concatFile = path.join(path.dirname(outputAudioPath), "concat.txt");
  fs.writeFileSync(
    concatFile,
    `file '${silencePath.replace(
      /'/g,
      "'\\''"
    )}'\nfile '${inputAudioPath.replace(/'/g, "'\\''")}'\n`
  );

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(concatFile)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions([
        "-acodec",
        "mp3",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-b:a",
        "128k",
        "-y",
      ])
      .save(outputAudioPath)
      .on("end", () => {
        fs.unlinkSync(concatFile);
        resolve();
      })
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

// Resize images, output to outputDir, returns new paths
async function resizeImages(
  inputPaths: string[],
  outputDir: string,
  width: number,
  height: number
): Promise<string[]> {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  const tasks = inputPaths.map(async (src, idx) => {
    const dest = path.join(
      outputDir,
      `slide${idx.toString().padStart(3, "0")}.jpg`
    );
    await sharp(src)
      .resize(width, height, { fit: "contain", background: "#000" })
      .toFormat("jpeg")
      .toFile(dest);
    return dest;
  });
  return Promise.all(tasks);
}

// Create ffmpeg concat list file with durations
function createConcatListFile(
  images: string[],
  duration: number,
  listPath: string
) {
  const lines: string[] = [];
  for (let i = 0; i < images.length; i++) {
    lines.push(`file '${images[i].replace(/'/g, "'\\''")}'`);
    if (i < images.length - 1) lines.push(`duration ${duration}`);
  }
  lines.push(`file '${images[images.length - 1].replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join("\n"), "utf-8");
}

// Mix TTS and background music, trimming to ttsLength (seconds)
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
        `[1]volume=${musicVolume}[bg]`,
        `[0][bg]amix=inputs=2:duration=first:dropout_transition=3`,
      ])
      .outputOptions(["-t", ttsLength.toString()])
      .output(outputPath)
      .on("start", (cmd: string) => console.log("Mixing bgm:", cmd))
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
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
  speechRate: number = 1 // e.g., 0.9 for slower, 1.1 for faster
): Promise<void> {
  const tmpDir = path.join(__dirname, "tmp_slides");
  const audioDir = path.join(__dirname, "audio");
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

  const ttsAudioPath = path.join(audioDir, "tts.mp3");
  const ttsSlowedAudioPath = path.join(audioDir, "tts_slowed.mp3");
  const ttsPaddedAudioPath = path.join(audioDir, "tts_padded.mp3");
  const mixedAudioPath = path.join(audioDir, "tts_mixed.mp3");
  const listFile = path.join(tmpDir, "input.txt");

  try {
    // 1. Generate TTS audio (newer model by default, still accepts your chosen voice)
    await generateTTS(narrationText, ttsAudioPath, voice);

    // 1b. Adjust speaking rate (pitch-preserving). If speechRate === 1, it's just a copy.
    await retimeAudio(ttsAudioPath, ttsSlowedAudioPath, speechRate);

    // 2. Prepend your silence MP3 to the (potentially retimed) TTS audio
    await prependSilence(ttsSlowedAudioPath, ttsPaddedAudioPath);

    // 3. Get duration (based on padded TTS only)
    const audioDuration = await getAudioDuration(ttsPaddedAudioPath);

    // 4. Optionally, mix background music (trimmed to TTS)
    let finalAudioPath = ttsPaddedAudioPath;
    if (backgroundMusicPath) {
      await mixNarrationWithBackground(
        ttsPaddedAudioPath,
        backgroundMusicPath,
        mixedAudioPath,
        audioDuration,
        musicVolume
      );
      finalAudioPath = mixedAudioPath;
    }

    // 5. Prepare images
    const resizedImages = await resizeImages(images, tmpDir, width, height);
    const durationPerSlide = audioDuration / images.length;
    createConcatListFile(resizedImages, durationPerSlide, listFile);

    // 6. Build video
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .input(finalAudioPath)
        .outputOptions([
          "-r",
          "25",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-shortest",
        ])
        .output(output)
        .on("start", (cmd: string) => console.log("Assembling video:", cmd))
        .on("end", () => resolve())
        .on("error", reject)
        .run();
    });
  } finally {
    // Clean up temporary files!
    if (fs.existsSync(tmpDir)) {
      fs.readdirSync(tmpDir).forEach((f) =>
        fs.unlinkSync(path.join(tmpDir, f))
      );
      fs.rmdirSync(tmpDir);
    }
    // Optionally clean up audio files
    // [ttsAudioPath, ttsSlowedAudioPath, ttsPaddedAudioPath, mixedAudioPath].forEach(p => { if(fs.existsSync(p)) fs.unlinkSync(p) });
  }
}

// ========== USAGE EXAMPLE ==========
if (require.main === module) {
  const imagesDirectory = path.join(__dirname, "images");
  const images = fs
    .readdirSync(imagesDirectory)
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .sort()
    .map((f) => path.join(imagesDirectory, f));

  const narrationText =
    "Meet dependable style with Auto Gals Inc.'s 2014 Toyota RAV4 XLE, finished in timeless gray and showing just 60,646 miles. Its responsive 2.5-liter 4-cylinder teams with a smooth 6-speed automatic for confident, efficient driving. Slip inside to enjoy keyless entry, power windows and locks, and a high fidelity audio system. Thoughtful packaging delivers easy maneuverability, generous cargo room, and the everyday versatility compact SUV drivers love. Safety comes standard with active belts, anti-lock brakes, and Toyota's reputation for durability. Ready to go, this RAV4 XLE blends practicality and peace of mind. See it today in Fall River or Swansea!";

  const backgroundMusicPath = path.join(__dirname, "audio", "background.mp3");
  // To disable music, use: undefined or ""

  createSlideshowWithTTS(
    images,
    narrationText,
    "video-file.mp4",
    1600,
    1200,
    "shimmer", // Try "fable" or "alloy" for a different prosody
    fs.existsSync(backgroundMusicPath) ? backgroundMusicPath : undefined,
    0.2, // music volume (0.0 - 1.0)
    0.9 // speechRate: 0.85–0.95 often feels more natural
  )
    .then(() => console.log("Slideshow with AI-generated narration created!"))
    .catch((e) => console.error("Error:", e));
}
