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

// Generate speech mp3 from text using OpenAI TTS
async function generateTTS(
  text: string,
  outputPath: string,
  voice: VoiceType = "shimmer"
): Promise<void> {
  const mp3Stream = await openai.audio.speech.create({
    model: "tts-1",
    voice: voice,
    input: text,
  });
  const buffer = Buffer.from(await mp3Stream.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
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
  // 1. Make a temporary concat list file
  const concatFile = path.join(path.dirname(outputAudioPath), "concat.txt");
  fs.writeFileSync(
    concatFile,
    `file '${silencePath.replace(
      /'/g,
      "'\\''"
    )}'\nfile '${inputAudioPath.replace(/'/g, "'\\''")}'\n`
  );

  // 2. Use ffmpeg to concatenate the files
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
      .outputOptions([
        "-t",
        ttsLength.toString(), // Trim to narration duration
      ])
      .output(outputPath)
      .on("start", (cmd: string) => console.log("Mixing bgm:", cmd))
      .on("end", (_stdout: string | null, _stderr: string | null) => resolve())
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
  musicVolume: number = 0.15
): Promise<void> {
  const tmpDir = path.join(__dirname, "tmp_slides");
  const audioDir = path.join(__dirname, "audio");
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);

  const ttsAudioPath = path.join(audioDir, "tts.mp3");
  const ttsPaddedAudioPath = path.join(audioDir, "tts_padded.mp3");
  const mixedAudioPath = path.join(audioDir, "tts_mixed.mp3");
  const listFile = path.join(tmpDir, "input.txt");

  try {
    // 1. Generate TTS audio
    await generateTTS(narrationText, ttsAudioPath, voice);

    // 2. Prepend your silence MP3 to TTS audio
    await prependSilence(ttsAudioPath, ttsPaddedAudioPath);

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
        .on("end", (_stdout: string | null, _stderr: string | null) =>
          resolve()
        )
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
    // [ttsAudioPath, ttsPaddedAudioPath, mixedAudioPath].forEach(p => { if(fs.existsSync(p)) fs.unlinkSync(p) });
  }
}

// ========== USAGE EXAMPLE ==========
if (require.main === module) {
  const imagesDirectory = path.join(__dirname, "images");
  const images = fs
    .readdirSync(imagesDirectory)
    .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
    .sort() // optional: slides are sorted alphabetically
    .map((f) => path.join(imagesDirectory, f));

  const narrationText =
    "Discover the elegance and performance of our 2015 Acura TLX Advance at Auto Gals! This stunning burgundy sedan features a powerful 3.5-liter V6 engine and super-handling all-wheel-drive for a truly exhilarating adventure. With just 80,689 miles, it comes loaded with luxury and advanced safety features, including Blind Spot and Lane Departure Warnings, a power sunroof, and keyless ignition. The stylish exterior turns heads, while the comfortable interior promises every journey is a pleasure. Visit us at Auto Gals in Fall River today and experience this exceptional Acura TLX for yourself!";

  // If you want background music, place 'background.mp3' in your project root (or update path)
  const backgroundMusicPath = path.join(__dirname, "audio", "background.mp3");
  // To disable music, use: undefined or ""

  createSlideshowWithTTS(
    images,
    narrationText,
    "video-file.mp4",
    1600,
    1200,
    "shimmer", // TTS voice
    fs.existsSync(backgroundMusicPath) ? backgroundMusicPath : undefined,
    0.2 // music volume (0.0 - 1.0)
  )
    .then(() => console.log("Slideshow with AI-generated narration created!"))
    .catch((e) => console.error("Error:", e));
}
