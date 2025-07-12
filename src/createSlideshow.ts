import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

// Utility to get audio duration (in seconds)
function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration ?? 0);
    });
  });
}

// Resize images same as before...
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
      .resize(width, height, {
        fit: "contain",
        background: "#000",
      })
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
    // Duration only for all except last image
    if (i < images.length - 1) lines.push(`duration ${duration}`);
  }
  // Repeat last image without duration
  lines.push(`file '${images[images.length - 1].replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join("\n"), "utf-8");
}

export async function createSlideshowWithAudio(
  images: string[],
  audioPath: string,
  output: string,
  width = 800,
  height = 600
): Promise<void> {
  const tmpDir = path.join(__dirname, "tmp_slides");
  const listFile = path.join(tmpDir, "input.txt");
  try {
    // 1. Get audio duration
    const audioDuration = await getAudioDuration(audioPath);
    const durationPerSlide = audioDuration / images.length;
    const resizedImages = await resizeImages(images, tmpDir, width, height);
    createConcatList(resizedImages, durationPerSlide, listFile);

    // 4. Create FFmpeg concat list file
    createConcatList(resizedImages, durationPerSlide, listFile);

    // 5. Combine video and audio, trim to audio duration
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listFile)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .input(audioPath)
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
  }
}

// Usage Example:
const imagesDirectory = path.join(__dirname, "images");
const images = fs
  .readdirSync(imagesDirectory)
  .map((f) => path.join(imagesDirectory, f));
const audioPath = path.join(__dirname, "audio", "red-camry-xse.mp3");

createSlideshowWithAudio(images, audioPath, "red-camry-xse.mp4")
  .then(() => console.log("Slideshow with audio created successfully!"))
  .catch((e) => console.error("Error:", e));
