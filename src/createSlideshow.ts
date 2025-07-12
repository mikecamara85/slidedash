import "dotenv/config";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import { OpenAI } from "openai";

// === OpenAI TTS Setup ===
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Generate speech mp3 from text using OpenAI TTS
async function generateTTS(
  text: string,
  outputPath: string,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy"
) {
  const mp3Stream = await openai.audio.speech.create({
    model: "tts-1",
    voice: voice,
    input: text,
  });
  const buffer = Buffer.from(await mp3Stream.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
}

// Utility to get audio duration
function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration ?? 0);
    });
  });
}

// Resize images
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

function createConcatList(
  images: string[],
  duration: number,
  listPath: string
) {
  const lines = [];
  for (let i = 0; i < images.length; i++) {
    lines.push(`file '${images[i].replace(/'/g, "'\\''")}'`);
    if (i < images.length - 1) lines.push(`duration ${duration}`);
  }
  lines.push(`file '${images[images.length - 1].replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join("\n"), "utf-8");
}

// The main function: images, narration text, output file
export async function createSlideshowWithTTS(
  images: string[],
  narrationText: string,
  output: string,
  width = 800,
  height = 600,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy"
): Promise<void> {
  const tmpDir = path.join(__dirname, "tmp_slides");
  const audioDir = path.join(__dirname, "audio");
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir);
  const ttsAudioPath = path.join(audioDir, "tts.mp3");
  const listFile = path.join(tmpDir, "input.txt");
  try {
    // 1. Generate TTS audio
    await generateTTS(narrationText, ttsAudioPath, "shimmer");

    // 2. Get audio duration and prepare images
    const audioDuration = await getAudioDuration(ttsAudioPath);
    const durationPerSlide = audioDuration / images.length;
    const resizedImages = await resizeImages(images, tmpDir, width, height);
    createConcatList(resizedImages, durationPerSlide, listFile);

    // 3. Build video
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .input(ttsAudioPath)
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
        .on("start", (cmd) => console.log("ffmpeg command:", cmd))
        .on("end", () => resolve())
        .on("error", reject)
        .run();
    });
  } finally {
    if (fs.existsSync(tmpDir)) {
      fs.readdirSync(tmpDir).forEach((f) =>
        fs.unlinkSync(path.join(tmpDir, f))
      );
      fs.rmdirSync(tmpDir);
    }
    // Optionally: remove ttsAudioPath
    // fs.existsSync(ttsAudioPath) && fs.unlinkSync(ttsAudioPath);
  }
}

// === USAGE ===
const imagesDirectory = path.join(__dirname, "images");
const images = fs
  .readdirSync(imagesDirectory)
  .filter((f) => /\.(jpg|jpeg|png)$/i.test(f))
  .map((f) => path.join(imagesDirectory, f));

const narrationText =
  "Get ready for adventure with Auto Gals' 2021 Jeep Gladiator Sport S! This eye-catching grey 4x4 comes with a powerful 3.6-liter 6-cylinder engine, automatic transmission, and only 34,153 miles. Built for safety, it features active belts, airbags, and anti-lock brakes, while comfort and convenience come standard with air conditioning, premium audio, a tilt steering wheel, keyless entry, and an immobilizer. Whether you're heading off-road or driving through town, the spacious Sport S trim is ready for anything. Visit us at Auto Gals in Fall River or Swansea to test drive the Jeep Gladiator today!";

createSlideshowWithTTS(images, narrationText, "video-file.mp4")
  .then(() => console.log("Slideshow with AI-generated narration created!"))
  .catch((e) => console.error("Error:", e));
