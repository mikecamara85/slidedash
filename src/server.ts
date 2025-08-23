// src/server.ts
/**
 * Minimal Express API that:
 * - Serves a static single-page app from ./public (from dist or src).
 * - Exposes two endpoints to create a narrated slideshow video:
 *   1) POST /v1/slideshow        -> JSON body with image URLs + options.
 *   2) POST /v1/slideshow/upload -> multipart/form-data with uploaded images + optional BGM.
 *
 * Internally:
 * - Downloads or accepts images and optional background music.
 * - Calls createSlideshowWithTTS() to synthesize narration and assemble an MP4.
 * - Streams the generated video back to the client, cleaning up temp files on close.
 *
 * Notes:
 * - Requires Node 18+ for global fetch and stream/promises.pipeline.
 * - Multer uses in-memory storage; consider disk storage for very large uploads.
 * - This example prefers clarity over advanced error handling and rate limiting.
 */

import "dotenv/config"; // load environment variables from .env, if present
import express, { type Request, type Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises"; // promisified stream pipeline
import { createSlideshowWithTTS } from "./createSlideshow"; // core slideshow builder

// Multer augments Express types. This helper makes access to req.files typed.
type MulterFiles = { [field: string]: Express.Multer.File[] };

const app = express();

// Parse JSON bodies with a conservative limit (tune as needed)
app.use(express.json({ limit: "2mb" }));

// Configure Multer to store files in memory (buffers).
// - memoryStorage simplifies cleanup but uses RAM; switch to diskStorage for large uploads.
// - limits control per-file size and total file count.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 60 },
});

// Static file serving:
// - Prefer ./dist/public when transpiled, otherwise ./public for ts-node/dev.
const distPublic = path.resolve(__dirname, "public");
const rootPublic = path.resolve(__dirname, "../public");
const publicDir = fs.existsSync(distPublic) ? distPublic : rootPublic;

// Log some diagnostics on startup regarding static assets.
console.log(
  "Serving static from:",
  publicDir,
  "exists:",
  fs.existsSync(publicDir),
  "index:",
  fs.existsSync(path.join(publicDir, "index.html"))
);

// Serve static assets with basic caching.
// - etag helps conditional requests.
// - maxAge 1h is safe for dev; bump in production.
app.use(
  express.static(publicDir, { index: "index.html", maxAge: "1h", etag: true })
);

// Root route serves the SPA index (in case the static middleware missed it)
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

/**
 * Create a unique temporary working directory for each API call.
 * Avoids file name collisions across concurrent requests.
 */
function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "api-run-"));
}

/**
 * Sanitize a filename by:
 * - Stripping directory components (basename only)
 * - Replacing non-word, non-dot, non-dash characters with underscores
 */
function safeBaseName(name: string): string {
  // keep only basename and sanitize to prevent weird chars/paths
  return path.basename(name).replace(/[^\w.-]/g, "_");
}

/**
 * Left-pad a number with zeros to a fixed width. Useful for ordering.
 * Example: zeroPad(5, 4) -> "0005"
 */
function zeroPad(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

/**
 * Guess a file extension from a Content-Type header (best-effort).
 * Returns empty string if unknown.
 */
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

/**
 * Download a remote URL to the temporary directory with an index-prefixed name.
 * This preserves input order and mitigates path traversal attacks.
 *
 * @param url   Remote URL to download (must be accessible by the server).
 * @param dir   Destination directory path.
 * @param index Numeric index to prefix the filename for ordering.
 * @returns     Full path to the downloaded file.
 */
async function downloadToTemp(
  url: string,
  dir: string,
  index: number
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);

  // Derive a base filename from the URL path, then sanitize it.
  const u = new URL(url);
  const urlBase = safeBaseName(path.basename(u.pathname));
  const urlExt = path.extname(urlBase);

  // If URL had no extension, try to infer from Content-Type.
  const ctExt = extFromContentType(
    res.headers.get("content-type") || undefined
  );
  const ext = urlExt || ctExt || "";

  // Base name without extension; fallback to a generic label
  const base = urlBase ? urlBase.replace(/\.[^.]*$/, "") : `image-${index}`;

  // Compose a final local filename: 0000-name.ext
  const finalName = `${zeroPad(index)}-${base}${ext}`;
  const outPath = path.join(dir, finalName);

  // Stream the response body to disk.
  await pipeline(res.body as any, fs.createWriteStream(outPath));
  return outPath;
}

/**
 * Download a remote URL but force a known base name, preserving or inferring extension.
 * Good for background music (bgm) where the logical name is known in advance.
 */
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

  // Force the chosen base name, plus resolved extension.
  const finalName = `${safeBaseName(baseName)}${ext}`;
  const outPath = path.join(dir, finalName);

  await pipeline(res.body as any, fs.createWriteStream(outPath));
  return outPath;
}

function sanitizeLocaleTag(tag?: string): string | undefined {
  if (!tag) return undefined;
  try {
    const [canon] = Intl.getCanonicalLocales(tag);
    return canon; // returns undefined if empty
  } catch {
    return undefined; // invalid tag
  }
}

function preferredLocaleFromHeader(header?: string): string | undefined {
  // No header? No locale.
  if (!header) return undefined;

  // Split the header into language-range tokens by comma.
  // Example header: "en-US,en;q=0.9,fr;q=0.8,*;q=0.1"
  const parts = header.split(",");

  type Candidate = { tag: string; q: number; index: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].trim();
    if (!token) continue;

    // Each token can have parameters after semicolons; first piece is the tag
    // e.g., "en-US", "en", "fr", or "*" (wildcard)
    const pieces = token.split(";").map((s) => s.trim());
    const rawTag = pieces[0];

    // Ignore empty and wildcard tags
    if (!rawTag || rawTag === "*") continue;

    // Default q (quality/priority) is 1.0 unless specified
    let q = 1;

    // Find a "q=..." param if present and parse it
    const qParam = pieces.find((p) => /^q=/i.test(p));
    if (qParam) {
      const value = parseFloat(qParam.slice(2));
      if (!Number.isNaN(value)) {
        // Clamp q to [0, 1] to be safe
        q = Math.max(0, Math.min(1, value));
      }
    }

    // q=0 means “not acceptable”; skip
    if (q <= 0) continue;

    candidates.push({ tag: rawTag, q, index: i });
  }

  if (candidates.length === 0) return undefined;

  // Sort by descending q; tie-break by original position to keep it stable
  candidates.sort((a, b) => b.q - a.q || a.index - b.index);

  // Canonicalize the top tag so you get normalized BCP-47 (e.g., "pt-BR")
  const top = candidates[0].tag;
  try {
    const [canonical] = Intl.getCanonicalLocales(top);
    return canonical;
  } catch {
    // If Intl rejects it, just return the raw tag
    return top;
  }
}

// Simple liveness/readiness endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

/**
 * JSON API: Create a slideshow from remote image URLs.
 *
 * Body (application/json):
 * {
 *   "narrationText": "string",           // required
 *   "imageUrls": ["https://..."],        // required, non-empty
 *   "backgroundMusicUrl": "https://...", // optional
 *   "width": 1600,                       // optional
 *   "height": 1200,                      // optional
 *   "voice": "shimmer",                  // optional
 *   "musicVolume": 0.2,                  // optional (0..1)
 *   "speechRate": 1.0                    // optional (>0)
 * }
 *
 * Response: Streams video/mp4.
 */
app.post("/v1/slideshow", async (req: Request, res: Response) => {
  // Extract and validate inputs (with defaults).
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

  // Basic validation of required fields.
  if (!narrationText || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res
      .status(400)
      .json({ error: "narrationText and imageUrls[] are required" });
  }
  // Guardrails on input size.
  if (imageUrls.length > 200) {
    return res.status(400).json({ error: "Too many images" });
  }

  // Create a dedicated temp directory for this request's assets and output.
  const work = makeWorkDir();
  const localImages: string[] = [];
  let localBgm: string | undefined;

  try {
    // Download images to local temp dir.
    // Prefix filenames with an index to preserve the client's specified order.
    for (let i = 0; i < imageUrls.length; i++) {
      localImages.push(await downloadToTemp(String(imageUrls[i]), work, i));
    }

    // If BGM URL provided, download it under a known name.
    if (backgroundMusicUrl) {
      localBgm = await downloadToTempNamed(
        String(backgroundMusicUrl),
        work,
        "bgm"
      );
    }

    const explicitLocale = sanitizeLocaleTag(
      (req.body?.locale as string | undefined) ||
        (req.query?.locale as string | undefined)
    );
    const headerLocale = sanitizeLocaleTag(
      preferredLocaleFromHeader(req.get("accept-language") || undefined)
    );
    const locale = explicitLocale || headerLocale || "en";

    // Final video output path within the temp dir.
    const outPath = path.join(work, "out.mp4");

    // Build the slideshow video with narration and optional BGM.
    await createSlideshowWithTTS(
      localImages, // already in order; names have index prefixes if anything sorts later
      String(narrationText),
      outPath,
      Number(width),
      Number(height),
      String(voice) as any,
      localBgm,
      Number(musicVolume),
      Number(speechRate),
      locale
    );

    // Prepare streaming response headers for MP4.
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'inline; filename="slideshow.mp4"');

    // Set Content-Length to enable progress bars on clients.
    const stat = fs.statSync(outPath);
    res.setHeader("Content-Length", stat.size.toString());

    // Stream the file and clean up temp dir after the client finishes.
    fs.createReadStream(outPath)
      .pipe(res)
      .on("close", () => {
        try {
          fs.rmSync(work, { recursive: true, force: true });
        } catch {}
      });
  } catch (e: any) {
    // On error, attempt to cleanup and send a 500.
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch {}
    console.error(e);
    res.status(500).json({ error: e?.message || "Failed to create video" });
  }
});

/**
 * Multipart upload API: Create a slideshow from uploaded image files.
 *
 * Form fields (multipart/form-data):
 *  - images[]: up to 200 image files (required)
 *  - bgm: optional audio file
 *  - narrationText: string (required)
 *  - width, height, voice, musicVolume, speechRate: optional settings
 *
 * Response: Streams video/mp4.
 */
app.post(
  "/v1/slideshow/upload",
  // Use Multer to parse incoming files. We store them in memory for simplicity.
  upload.fields([
    { name: "images", maxCount: 200 },
    { name: "bgm", maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    // Parse form fields (strings by default). Convert to correct types where needed.
    const narrationText = String((req.body?.narrationText ?? "").toString());
    const width = Number(req.body?.width ?? 1600);
    const height = Number(req.body?.height ?? 1200);
    const voice = (req.body?.voice ?? "shimmer") as any;
    const musicVolume = Number(req.body?.musicVolume ?? 0.2);
    const speechRate = Number(req.body?.speechRate ?? 1.0);

    // Access Multer's parsed files with our helper type.
    const files = (req as Request & { files?: MulterFiles }).files || {};
    const images = (files["images"] as Express.Multer.File[]) || [];

    // Validate inputs.
    if (!narrationText || images.length === 0) {
      return res
        .status(400)
        .json({ error: "narrationText and images[] are required" });
    }

    // Optional background music file (at most 1)
    const bgmFile = files["bgm"]?.[0] as Express.Multer.File | undefined;

    // Create temp working directory for this request.
    const work = makeWorkDir();
    const localImages: string[] = [];
    let localBgm: string | undefined;

    try {
      // Persist uploaded images to disk in upload order.
      // Use a zero-padded index to ensure stable ordering.
      images.forEach((f, i) => {
        // Prefer client-provided filename if available; fallback to image-<i>.
        const rawBase =
          f.originalname && f.originalname.trim().length > 0
            ? f.originalname
            : `image-${i}`;

        // Sanitize the base name and strip extension (we add our own after).
        const base = safeBaseName(rawBase).replace(/\.[^.]*$/, "");

        // Determine a safe extension: prefer actual extension, else MIME-derived, else empty.
        const ext =
          path.extname(rawBase) || extFromContentType(f.mimetype) || "";

        // Final filename e.g., "0001-my_photo.jpg"
        const filename = `${zeroPad(i)}-${base}${ext}`;
        const p = path.join(work, filename);

        // memoryStorage provides file buffer directly.
        fs.writeFileSync(p, f.buffer);
        localImages.push(p);
      });

      // If BGM provided, write it with a stable name and reasonable extension fallback.
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

      const explicitLocale = sanitizeLocaleTag(
        (req.body?.locale as string | undefined) ||
          (req.query?.locale as string | undefined)
      );
      const headerLocale = sanitizeLocaleTag(
        preferredLocaleFromHeader(req.get("accept-language") || undefined)
      );
      const locale = explicitLocale || headerLocale || "en";

      // Output path for the final video within the temp dir.
      const outPath = path.join(work, "out.mp4");

      // Build slideshow from local files.
      await createSlideshowWithTTS(
        localImages, // already in correct order
        narrationText,
        outPath,
        width,
        height,
        voice,
        localBgm,
        musicVolume,
        speechRate,
        locale
      );

      // Stream the resulting MP4 to the client.
      res.setHeader("Content-Type", "video/mp4");
      fs.createReadStream(outPath)
        .pipe(res)
        .on("close", () => {
          // Clean up temp files when the client disconnects or finishes.
          try {
            fs.rmSync(work, { recursive: true, force: true });
          } catch {}
        });
    } catch (e: any) {
      // Cleanup and report error.
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {}
      console.error(e);
      res.status(500).json({ error: e?.message || "Failed to create video" });
    }
  }
);

// Bind the HTTP server to a configurable port (default 8080).
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Slideshow API listening on :${port}`));
