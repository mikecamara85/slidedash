import ffmpeg from "fluent-ffmpeg";
import * as fs from "fs";
import * as path from "path";

function getFilenamesInDirectory(directoryPath: string): string[] {
  return fs
    .readdirSync(directoryPath)
    .map((fileName) => path.join(directoryPath, fileName));
}

async function createSlideshow(images: string[], output: string) {
  const duration = 30 / images.length; // Calculate duration per image

  return new Promise<void>((resolve, reject) => {
    const command = ffmpeg();

    images.forEach((img) => {
      command.addInput(img);
    });

    const filterComplexParts = images.map((_, index) => {
      return `[${index}:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,loop=${Math.ceil(
        duration * 25
      )}:1:0,setpts=PTS-STARTPTS[v${index}]`;
    });

    const filterComplex =
      `${filterComplexParts.join(";")};` +
      `${images.map((_, index) => `[v${index}]`).join("")}concat=n=${
        images.length
      }:v=1:a=0,format=yuv420p[v]`;

    command
      .complexFilter(filterComplex, "v")
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .outputOptions(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
      .output(output)
      .run();
  });
}

const imagesDirectory = path.join(__dirname, "images");
const imagePaths = getFilenamesInDirectory(imagesDirectory);

createSlideshow(imagePaths, "output.mp4")
  .then(() => console.log("Slideshow created successfully!"))
  .catch((error) => console.error("Error creating slideshow:", error));
