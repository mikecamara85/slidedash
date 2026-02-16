// src/server.ts
/**
 * Express API that:
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
 * - This prefers clarity over advanced error handling and rate limiting.
 */

import "dotenv/config";
import express, { type Request, type Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";

import { createSlideshowWithTTS } from "./createSlideshow";
import { openai } from "./openaiClient";

// Multer augments Express types. This helper makes access to req.files typed.
type MulterFiles = { [field: string]: Express.Multer.File[] };

type ModerationOutcome = {
  ok: boolean;
  categories: string[];
  raw?: any;
};

// =============================================================================
// Configuration & initialization
// =============================================================================

const app = express();

// Static file serving:
// - Prefer ./dist/public when transpiled, otherwise ./public for ts-node/dev.
const distPublic = path.resolve(__dirname, "public");
const rootPublic = path.resolve(__dirname, "../public");
const publicDir = fs.existsSync(distPublic) ? distPublic : rootPublic;

// Multer configuration (in-memory storage).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 60 },
});

const API_KEY = process.env.SLIDEDASH_API_KEY;

// Log some diagnostics on startup regarding static assets.
console.log(
  "Serving static from:",
  publicDir,
  "exists:",
  fs.existsSync(publicDir),
  "index:",
  fs.existsSync(path.join(publicDir, "index.html")),
);

// =============================================================================
// Utility functions
// =============================================================================

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
 */
async function downloadToTemp(
  url: string,
  dir: string,
  index: number,
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);

  const u = new URL(url);
  const urlBase = safeBaseName(path.basename(u.pathname));
  const urlExt = path.extname(urlBase);

  const ctExt = extFromContentType(
    res.headers.get("content-type") || undefined,
  );
  const ext = urlExt || ctExt || "";

  const base = urlBase ? urlBase.replace(/\.[^.]*$/, "") : `image-${index}`;
  const finalName = `${zeroPad(index)}-${base}${ext}`;
  const outPath = path.join(dir, finalName);

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
  baseName: string,
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);

  const u = new URL(url);
  const urlBase = safeBaseName(path.basename(u.pathname));
  const urlExt = path.extname(urlBase);
  const ctExt = extFromContentType(
    res.headers.get("content-type") || undefined,
  );
  const ext = urlExt || ctExt || "";

  const finalName = `${safeBaseName(baseName)}${ext}`;
  const outPath = path.join(dir, finalName);

  await pipeline(res.body as any, fs.createWriteStream(outPath));
  return outPath;
}

/**
 * Ensure a BCP-47 locale tag is valid; return undefined if invalid.
 */
function sanitizeLocaleTag(tag?: string): string | undefined {
  if (!tag) return undefined;
  try {
    const [canon] = Intl.getCanonicalLocales(tag);
    return canon;
  } catch {
    return undefined;
  }
}

/**
 * Parse an Accept-Language header and return the preferred locale tag, if any.
 */
function preferredLocaleFromHeader(header?: string): string | undefined {
  if (!header) return undefined;

  const parts = header.split(",");

  type Candidate = { tag: string; q: number; index: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].trim();
    if (!token) continue;

    const pieces = token.split(";").map((s) => s.trim());
    const rawTag = pieces[0];

    if (!rawTag || rawTag === "*") continue;

    let q = 1;
    const qParam = pieces.find((p) => /^q=/i.test(p));
    if (qParam) {
      const value = parseFloat(qParam.slice(2));
      if (!Number.isNaN(value)) {
        q = Math.max(0, Math.min(1, value));
      }
    }

    if (q <= 0) continue;
    candidates.push({ tag: rawTag, q, index: i });
  }

  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => b.q - a.q || a.index - b.index);

  const top = candidates[0].tag;
  try {
    const [canonical] = Intl.getCanonicalLocales(top);
    return canonical;
  } catch {
    return top;
  }
}

/**
 * Resolve the best locale for a request:
 * - explicit `locale` in body or query
 * - else Accept-Language header
 * - else "en"
 */
function resolveLocale(req: Request): string {
  const explicitLocale = sanitizeLocaleTag(
    (req.body?.locale as string | undefined) ||
      (req.query?.locale as string | undefined),
  );
  const headerLocale = sanitizeLocaleTag(
    preferredLocaleFromHeader(req.get("accept-language") || undefined),
  );
  return explicitLocale || headerLocale || "en";
}

/**
 * OpenAI moderation wrapper for narration text.
 */
async function checkModeration(text: string): Promise<ModerationOutcome> {
  const model = process.env.OPENAI_MODERATION_MODEL || "omni-moderation-latest";

  const resp = await openai.moderations.create({
    model,
    input: text,
  });

  const r = (resp as any)?.results?.[0];
  const flagged = Boolean(r?.flagged);
  const categories = r?.categories
    ? Object.entries(r.categories)
        .filter(([, v]) => v)
        .map(([k]) => String(k))
    : [];

  return { ok: !flagged, categories, raw: r };
}

// =============================================================================
// Middleware
// =============================================================================

// Parse JSON bodies with a conservative limit (tune as needed)
app.use(express.json({ limit: "2mb" }));

// Serve static assets with basic caching.
app.use(
  express.static(publicDir, {
    index: "index.html",
    maxAge: "1h",
    etag: true,
  }),
);

// Protect only the API prefix, not static assets.
app.use("/v1", (req, res, next) => {
  // If no key configured in env, auth is effectively disabled (useful for local dev).
  if (!API_KEY) return next();

  const key = req.get("x-api-key");
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// =============================================================================
// Basic routes
// =============================================================================

// Root route serves the SPA index (in case the static middleware missed it)
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Simple liveness/readiness endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// =============================================================================
// /v1/slideshow (JSON; URLs)
// =============================================================================

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

  // Moderation check
  try {
    const mod = await checkModeration(String(narrationText));
    if (!mod.ok) {
      return res.status(400).json({
        error: "Narration text rejected by content moderation",
        categories: mod.categories,
      });
    }
  } catch (err) {
    console.error("Moderation error:", err);
    return res.status(503).json({ error: "Moderation service unavailable" });
  }

  if (imageUrls.length > 200) {
    return res.status(400).json({ error: "Too many images" });
  }

  const work = makeWorkDir();
  const localImages: string[] = [];
  let localBgm: string | undefined;

  try {
    for (let i = 0; i < imageUrls.length; i++) {
      localImages.push(await downloadToTemp(String(imageUrls[i]), work, i));
    }

    if (backgroundMusicUrl) {
      localBgm = await downloadToTempNamed(
        String(backgroundMusicUrl),
        work,
        "bgm",
      );
    }

    const locale = resolveLocale(req);
    const outPath = path.join(work, "out.mp4");

    await createSlideshowWithTTS(
      localImages,
      String(narrationText),
      outPath,
      Number(width),
      Number(height),
      String(voice) as any,
      localBgm,
      Number(musicVolume),
      Number(speechRate),
      locale,
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

// =============================================================================
// /v1/slideshow/upload (multipart; file uploads)
// =============================================================================

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

    // Moderation check
    try {
      const mod = await checkModeration(String(narrationText));
      if (!mod.ok) {
        return res.status(400).json({
          error: "Narration text rejected by content moderation",
          categories: mod.categories,
        });
      }
    } catch (err) {
      console.error("Moderation error:", err);
      return res.status(503).json({ error: "Moderation service unavailable" });
    }

    const bgmFile = files["bgm"]?.[0] as Express.Multer.File | undefined;

    const work = makeWorkDir();
    const localImages: string[] = [];
    let localBgm: string | undefined;

    try {
      images.forEach((f, i) => {
        const rawBase =
          f.originalname && f.originalname.trim().length > 0
            ? f.originalname
            : `image-${i}`;

        const base = safeBaseName(rawBase).replace(/\.[^.]*$/, "");
        const ext =
          path.extname(rawBase) || extFromContentType(f.mimetype) || "";

        const filename = `${zeroPad(i)}-${base}${ext}`;
        const p = path.join(work, filename);

        fs.writeFileSync(p, f.buffer);
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

      const locale = resolveLocale(req);
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
        speechRate,
        locale,
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
  },
);

// =============================================================================
// Server startup
// =============================================================================

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`Slideshow API listening on :${port}`);
});
