// src/server.ts
import "dotenv/config";
import express, { type Request, type Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { createSlideshowWithTTS } from "./createSlideshow";

// Multer augments Express types. This helper makes access to req.files typed.
type MulterFiles = { [field: string]: Express.Multer.File[] };

const app = express();
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 60 },
});

const distPublic = path.resolve(__dirname, "public");
const rootPublic = path.resolve(__dirname, "../public");
const publicDir = fs.existsSync(distPublic) ? distPublic : rootPublic;
console.log(
  "Serving static from:",
  publicDir,
  "exists:",
  fs.existsSync(publicDir),
  "index:",
  fs.existsSync(path.join(publicDir, "index.html"))
);
app.use(
  express.static(publicDir, { index: "index.html", maxAge: "1h", etag: true })
);
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "api-run-"));
}

function safeBaseName(name: string): string {
  // keep only basename and sanitize to prevent weird chars/paths
  return path.basename(name).replace(/[^\w.-]/g, "_");
}

function zeroPad(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

function extFromContentType(ct?: string): string {
  if (!ct) return "";
  const [type] = ct.split(";").map((s) => s.trim().toLowerCase());
  switch (type) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/aac":
      return ".m4a";
    case "audio/wav":
      return ".wav";
    case "audio/ogg":
      return ".ogg";
    default:
      return "";
  }
}

async function downloadToTemp(
  url: string,
  dir: string,
  index: number
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const u = new URL(url);
  const urlBase = safeBaseName(path.basename(u.pathname));
  const urlExt = path.extname(urlBase);
  const ctExt = extFromContentType(
    res.headers.get("content-type") || undefined
  );
  const ext = urlExt || ctExt || "";
  const base = urlBase ? urlBase.replace(/\.[^.]*$/, "") : `image-${index}`;
  const finalName = `${zeroPad(index)}-${base}${ext}`;
  const outPath = path.join(dir, finalName);
  await pipeline(res.body as any, fs.createWriteStream(outPath));
  return outPath;
}

async function downloadToTempNamed(
  url: string,
  dir: string,
  baseName: string
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const u = new URL(url);
  const urlBase = safeBaseName(path.basename(u.pathname));
  const urlExt = path.extname(urlBase);
  const ctExt = extFromContentType(
    res.headers.get("content-type") || undefined
  );
  const ext = urlExt || ctExt || "";
  const finalName = `${safeBaseName(baseName)}${ext}`;
  const outPath = path.join(dir, finalName);
  await pipeline(res.body as any, fs.createWriteStream(outPath));
  return outPath;
}

app.get("/health", (_req: Request, res: Response) => {
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
    // Preserve URL order using index prefix in filenames
    for (let i = 0; i < imageUrls.length; i++) {
      localImages.push(await downloadToTemp(String(imageUrls[i]), work, i));
    }
    if (backgroundMusicUrl) {
      localBgm = await downloadToTempNamed(
        String(backgroundMusicUrl),
        work,
        "bgm"
      );
    }

    const outPath = path.join(work, "out.mp4");
    await createSlideshowWithTTS(
      localImages, // already in order; names have index prefixes if anything sorts later
      String(narrationText),
      outPath,
      Number(width),
      Number(height),
      String(voice) as any,
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
      // Write images using upload order with index prefixes + original filenames
      images.forEach((f, i) => {
        const rawBase =
          f.originalname && f.originalname.trim().length > 0
            ? f.originalname
            : `image-${i}`;
        const base = safeBaseName(rawBase).replace(/\.[^.]*$/, ""); // drop ext for now
        const ext =
          path.extname(rawBase) || extFromContentType(f.mimetype) || ""; // best-effort
        const filename = `${zeroPad(i)}-${base}${ext}`;
        const p = path.join(work, filename);
        fs.writeFileSync(p, f.buffer); // memoryStorage gives buffer
        localImages.push(p);
      });

      if (bgmFile) {
        const rawBase =
          bgmFile.originalname && bgmFile.originalname.trim().length > 0
            ? bgmFile.originalname
            : "bgm";
        const base = safeBaseName(rawBase).replace(/\.[^.]*$/, "");
        const ext =
          path.extname(rawBase) || extFromContentType(bgmFile.mimetype) || "";
        const p = path.join(work, `${base}${ext || ".mp3"}`);
        fs.writeFileSync(p, bgmFile.buffer);
        localBgm = p;
      }

      const outPath = path.join(work, "out.mp4");
      await createSlideshowWithTTS(
        localImages, // already in correct order
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
