// src/server.ts
import "dotenv/config";
import express, { type Request, type Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { randomUUID } from "crypto";
import { createSlideshowWithTTS } from "./createSlideshow";

// Multer augments Express types. This helper makes access to req.files typed.
type MulterFiles = { [field: string]: Express.Multer.File[] };

const app = express();
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 60 },
});

function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "api-run-"));
}

async function downloadToTemp(url: string, dir: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const fileName = randomUUID() + path.extname(new URL(url).pathname || "");
  const outPath = path.join(dir, fileName);
  await pipeline(res.body as any, fs.createWriteStream(outPath));
  return outPath;
}

app.get("/health", (req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/v1/slideshow", async (req: Request, res: Response) => {
  const {
    narrationText,
    imageUrls,
    backgroundMusicUrl,
    width = 1600,
    height = 1200,
    voice = "shimmer",
    musicVolume = 0.2,
    speechRate = 1.0,
  } = (req.body ?? {}) as any;

  if (!narrationText || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res
      .status(400)
      .json({ error: "narrationText and imageUrls[] are required" });
  }
  if (imageUrls.length > 200) {
    return res.status(400).json({ error: "Too many images" });
  }

  const work = makeWorkDir();
  const localImages: string[] = [];
  let localBgm: string | undefined;

  try {
    for (const url of imageUrls) {
      localImages.push(await downloadToTemp(url, work));
    }
    if (backgroundMusicUrl) {
      localBgm = await downloadToTemp(backgroundMusicUrl, work);
    }

    const outPath = path.join(work, "out.mp4");
    await createSlideshowWithTTS(
      localImages,
      narrationText,
      outPath,
      Number(width),
      Number(height),
      voice as any,
      localBgm,
      Number(musicVolume),
      Number(speechRate)
    );

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="slideshow.mp4"');
    const stat = fs.statSync(outPath);
    res.setHeader("Content-Length", stat.size.toString());
    fs.createReadStream(outPath)
      .pipe(res)
      .on("close", () => {
        try {
          fs.rmSync(work, { recursive: true, force: true });
        } catch {}
      });
  } catch (e: any) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {}
    console.error(e);
    res.status(500).json({ error: e?.message || "Failed to create video" });
  }
});

app.post(
  "/v1/slideshow/upload",
  upload.fields([
    { name: "images", maxCount: 200 },
    { name: "bgm", maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const narrationText = String((req.body?.narrationText ?? "").toString());
    const width = Number(req.body?.width ?? 1600);
    const height = Number(req.body?.height ?? 1200);
    const voice = (req.body?.voice ?? "shimmer") as any;
    const musicVolume = Number(req.body?.musicVolume ?? 0.2);
    const speechRate = Number(req.body?.speechRate ?? 1.0);

    const files = (req as Request & { files?: MulterFiles }).files || {};
    const images = (files["images"] as Express.Multer.File[]) || [];
    if (!narrationText || images.length === 0) {
      return res
        .status(400)
        .json({ error: "narrationText and images[] are required" });
    }
    const bgmFile = files["bgm"]?.[0] as Express.Multer.File | undefined;

    const work = makeWorkDir();
    const localImages: string[] = [];
    let localBgm: string | undefined;

    try {
      for (const f of images) {
        const p = path.join(
          work,
          randomUUID() + path.extname(f.originalname || ".jpg")
        );
        fs.writeFileSync(p, f.buffer); // memoryStorage gives buffer
        localImages.push(p);
      }
      if (bgmFile) {
        const p = path.join(
          work,
          randomUUID() + path.extname(bgmFile.originalname || ".mp3")
        );
        fs.writeFileSync(p, bgmFile.buffer);
        localBgm = p;
      }

      const outPath = path.join(work, "out.mp4");
      await createSlideshowWithTTS(
        localImages,
        narrationText,
        outPath,
        width,
        height,
        voice,
        localBgm,
        musicVolume,
        speechRate
      );

      res.setHeader("Content-Type", "video/mp4");
      fs.createReadStream(outPath)
        .pipe(res)
        .on("close", () => {
          try {
            fs.rmSync(work, { recursive: true, force: true });
          } catch {}
        });
    } catch (e: any) {
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {}
      console.error(e);
      res.status(500).json({ error: e?.message || "Failed to create video" });
    }
  }
);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Slideshow API listening on :${port}`));
