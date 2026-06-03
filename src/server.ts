// ./src/server.ts

import "dotenv/config";
import express, { type Request, type Response } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";

import { createSlideshowWithTTS } from "./createSlideshow";
import { config, VOICES, type VoiceType } from "./config";
import { createQueuedJob, ensureJobIndexes, getJobById } from "./jobRepo";
import { buildJobResponse } from "./jobResponses";
import { openai } from "./openaiClient";
import { startWorkerLoop } from "./workerLoop";

type MulterFiles = { [field: string]: Express.Multer.File[] };

type ModerationOutcome = {
  ok: boolean;
  categories: string[];
  raw?: any;
};

type ValidatedJobRequest = {
  narrationText: string;
  imageUrls: string[];
  backgroundMusicUrl?: string;
  width: number;
  height: number;
  voice: VoiceType;
  musicVolume: number;
  speechRate: number;
  locale: string;
  client?: {
    source?: string;
    dealerSite?: string;
    vehicleVin?: string;
  };
};

const app = express();

const distPublic = path.resolve(__dirname, "public");
const rootPublic = path.resolve(__dirname, "../public");
const publicDir = fs.existsSync(distPublic) ? distPublic : rootPublic;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: config.limits.imageMaxCount + 1,
  },
});

console.log(
  "Serving static from:",
  publicDir,
  "exists:",
  fs.existsSync(publicDir),
  "index:",
  fs.existsSync(path.join(publicDir, "index.html")),
);

// =============================================================================
// Utility helpers
// =============================================================================

function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "api-run-"));
}

function safeBaseName(name: string): string {
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

function sanitizeLocaleTag(tag?: string): string | undefined {
  if (!tag) return undefined;
  try {
    const [canon] = Intl.getCanonicalLocales(tag);
    return canon;
  } catch {
    return undefined;
  }
}

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

function resolveLocale(req: Request, explicitValue?: unknown): string {
  const explicitLocale = sanitizeLocaleTag(
    typeof explicitValue === "string" ? explicitValue : undefined,
  );
  const headerLocale = sanitizeLocaleTag(
    preferredLocaleFromHeader(req.get("accept-language") || undefined),
  );

  return explicitLocale || headerLocale || config.defaults.locale;
}

function isVoice(value: unknown): value is VoiceType {
  return (
    typeof value === "string" && (VOICES as readonly string[]).includes(value)
  );
}

function parseHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function sanitizeOptionalShortString(
  value: unknown,
  maxLength = 120,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function parseBoundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  const num =
    value === undefined || value === null || value === ""
      ? fallback
      : Number(value);

  if (!Number.isFinite(num)) return undefined;
  if (num < min || num > max) return undefined;
  return num;
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  const num = parseBoundedNumber(value, fallback, min, max);
  if (num === undefined) return undefined;
  if (!Number.isInteger(num)) return undefined;
  return num;
}

async function checkModeration(text: string): Promise<ModerationOutcome> {
  const resp = await openai.moderations.create({
    model: config.openai.moderationModel,
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
// Async API validation / error helpers
// =============================================================================

function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return res.status(status).json({
    error: {
      code,
      message,
      ...(extra ?? {}),
    },
  });
}

function validateCreateJobRequest(
  req: Request,
): { ok: true; value: ValidatedJobRequest } | { ok: false; message: string } {
  const body = (req.body ?? {}) as Record<string, unknown>;

  const narrationText =
    typeof body.narrationText === "string" ? body.narrationText.trim() : "";

  if (!narrationText) {
    return {
      ok: false,
      message: "narrationText is required",
    };
  }

  if (narrationText.length > config.limits.narrationMaxChars) {
    return {
      ok: false,
      message: `narrationText must be <= ${config.limits.narrationMaxChars} characters`,
    };
  }

  if (!Array.isArray(body.imageUrls) || body.imageUrls.length === 0) {
    return {
      ok: false,
      message: "imageUrls must be a non-empty array",
    };
  }

  if (body.imageUrls.length > config.limits.imageMaxCount) {
    return {
      ok: false,
      message: `imageUrls must contain at most ${config.limits.imageMaxCount} items`,
    };
  }

  const imageUrls: string[] = [];
  for (let i = 0; i < body.imageUrls.length; i++) {
    const parsed = parseHttpUrl(body.imageUrls[i]);
    if (!parsed) {
      return {
        ok: false,
        message: `imageUrls[${i}] must be a valid http/https URL`,
      };
    }
    imageUrls.push(parsed);
  }

  const backgroundMusicUrl =
    body.backgroundMusicUrl === undefined || body.backgroundMusicUrl === null
      ? undefined
      : parseHttpUrl(body.backgroundMusicUrl);

  if (
    body.backgroundMusicUrl !== undefined &&
    body.backgroundMusicUrl !== null &&
    !backgroundMusicUrl
  ) {
    return {
      ok: false,
      message: "backgroundMusicUrl must be a valid http/https URL",
    };
  }

  const width = parseBoundedInteger(
    body.width,
    config.defaults.width,
    config.limits.widthMin,
    config.limits.widthMax,
  );
  if (width === undefined) {
    return {
      ok: false,
      message: `width must be an integer between ${config.limits.widthMin} and ${config.limits.widthMax}`,
    };
  }

  const height = parseBoundedInteger(
    body.height,
    config.defaults.height,
    config.limits.heightMin,
    config.limits.heightMax,
  );
  if (height === undefined) {
    return {
      ok: false,
      message: `height must be an integer between ${config.limits.heightMin} and ${config.limits.heightMax}`,
    };
  }

  const voice = body.voice === undefined ? config.defaults.voice : body.voice;
  if (!isVoice(voice)) {
    return {
      ok: false,
      message: `voice must be one of: ${VOICES.join(", ")}`,
    };
  }

  const speechRate = parseBoundedNumber(
    body.speechRate,
    config.defaults.speechRate,
    config.limits.speechRateMin,
    config.limits.speechRateMax,
  );
  if (speechRate === undefined) {
    return {
      ok: false,
      message: `speechRate must be between ${config.limits.speechRateMin} and ${config.limits.speechRateMax}`,
    };
  }

  const musicVolume = parseBoundedNumber(
    body.musicVolume,
    config.defaults.musicVolume,
    config.limits.musicVolumeMin,
    config.limits.musicVolumeMax,
  );
  if (musicVolume === undefined) {
    return {
      ok: false,
      message: `musicVolume must be between ${config.limits.musicVolumeMin} and ${config.limits.musicVolumeMax}`,
    };
  }

  if (
    body.locale !== undefined &&
    body.locale !== null &&
    !sanitizeLocaleTag(String(body.locale))
  ) {
    return {
      ok: false,
      message: "locale must be a valid BCP-47 language tag",
    };
  }

  const locale = resolveLocale(req, body.locale);

  let client:
    | {
        source?: string;
        dealerSite?: string;
        vehicleVin?: string;
      }
    | undefined;

  if (body.client !== undefined && body.client !== null) {
    if (typeof body.client !== "object" || Array.isArray(body.client)) {
      return {
        ok: false,
        message: "client must be an object when provided",
      };
    }

    const clientInput = body.client as Record<string, unknown>;
    client = {
      source: sanitizeOptionalShortString(clientInput.source),
      dealerSite: sanitizeOptionalShortString(clientInput.dealerSite),
      vehicleVin: sanitizeOptionalShortString(clientInput.vehicleVin),
    };
  }

  return {
    ok: true,
    value: {
      narrationText,
      imageUrls,
      backgroundMusicUrl,
      width,
      height,
      voice,
      musicVolume,
      speechRate,
      locale,
      client,
    },
  };
}

// =============================================================================
// Middleware
// =============================================================================

app.use(express.json({ limit: "2mb" }));

app.use(
  express.static(publicDir, {
    index: "index.html",
    maxAge: "1h",
    etag: true,
  }),
);

app.use("/v1", (req, res, next) => {
  if (!config.api.key) return next();

  const key = req.get("x-api-key");
  if (key !== config.api.key) {
    return sendApiError(res, 401, "unauthorized", "Unauthorized");
  }

  next();
});

// =============================================================================
// Basic routes
// =============================================================================

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// =============================================================================
// New async job API
// =============================================================================

app.post("/v1/jobs/slideshow", async (req: Request, res: Response) => {
  const validated = validateCreateJobRequest(req);
  if (!validated.ok) {
    return sendApiError(res, 400, "invalid_request", validated.message);
  }

  try {
    const mod = await checkModeration(validated.value.narrationText);

    if (!mod.ok) {
      return sendApiError(
        res,
        400,
        "moderation_rejected",
        "Narration text rejected by content moderation",
        { categories: mod.categories },
      );
    }
  } catch (error) {
    console.error("Moderation error:", error);
    return sendApiError(
      res,
      503,
      "moderation_unavailable",
      "Moderation service unavailable",
    );
  }

  try {
    const job = await createQueuedJob(validated.value);

    return res.status(201).json({
      jobId: job._id,
      status: job.status,
      createdAt: job.createdAt.toISOString(),
    });
  } catch (error) {
    console.error("Create job error:", error);
    return sendApiError(
      res,
      500,
      "internal_error",
      "Failed to create slideshow job",
    );
  }
});

app.get("/v1/jobs/:jobId", async (req: Request, res: Response) => {
  try {
    const jobId = String(req.params.jobId || "").trim();
    if (!jobId) {
      return sendApiError(res, 400, "invalid_request", "jobId is required");
    }

    const job = await getJobById(jobId);
    if (!job) {
      return sendApiError(res, 404, "job_not_found", "Job not found");
    }

    const response = await buildJobResponse(job);
    return res.json(response);
  } catch (error) {
    console.error("Get job error:", error);
    return sendApiError(
      res,
      500,
      "internal_error",
      "Failed to fetch slideshow job",
    );
  }
});

// =============================================================================
// Legacy synchronous routes
// =============================================================================

if (config.legacy.syncRoutesEnabled) {
  app.post("/v1/slideshow", async (req: Request, res: Response) => {
    const {
      narrationText,
      imageUrls,
      backgroundMusicUrl,
      width = config.defaults.width,
      height = config.defaults.height,
      voice = config.defaults.voice,
      musicVolume = config.defaults.musicVolume,
      speechRate = config.defaults.speechRate,
      locale,
    } = (req.body ?? {}) as any;

    const trimmedNarration =
      typeof narrationText === "string" ? narrationText.trim() : "";

    if (
      !trimmedNarration ||
      !Array.isArray(imageUrls) ||
      imageUrls.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "narrationText and imageUrls[] are required" });
    }

    if (trimmedNarration.length > config.limits.narrationMaxChars) {
      return res.status(400).json({
        error: `narrationText must be <= ${config.limits.narrationMaxChars} characters`,
      });
    }

    if (imageUrls.length > config.limits.imageMaxCount) {
      return res.status(400).json({
        error: `Too many images (max ${config.limits.imageMaxCount})`,
      });
    }

    if (!isVoice(voice)) {
      return res
        .status(400)
        .json({ error: `voice must be one of: ${VOICES.join(", ")}` });
    }

    const widthNum = parseBoundedInteger(
      width,
      config.defaults.width,
      config.limits.widthMin,
      config.limits.widthMax,
    );
    const heightNum = parseBoundedInteger(
      height,
      config.defaults.height,
      config.limits.heightMin,
      config.limits.heightMax,
    );
    const speechRateNum = parseBoundedNumber(
      speechRate,
      config.defaults.speechRate,
      config.limits.speechRateMin,
      config.limits.speechRateMax,
    );
    const musicVolumeNum = parseBoundedNumber(
      musicVolume,
      config.defaults.musicVolume,
      config.limits.musicVolumeMin,
      config.limits.musicVolumeMax,
    );

    if (
      widthNum === undefined ||
      heightNum === undefined ||
      speechRateNum === undefined ||
      musicVolumeNum === undefined
    ) {
      return res.status(400).json({ error: "Invalid render settings" });
    }

    const normalizedImageUrls: string[] = [];
    for (let i = 0; i < imageUrls.length; i++) {
      const parsed = parseHttpUrl(imageUrls[i]);
      if (!parsed) {
        return res
          .status(400)
          .json({ error: `imageUrls[${i}] must be a valid URL` });
      }
      normalizedImageUrls.push(parsed);
    }

    let normalizedBgm: string | undefined;
    if (backgroundMusicUrl !== undefined && backgroundMusicUrl !== null) {
      normalizedBgm = parseHttpUrl(backgroundMusicUrl);
      if (!normalizedBgm) {
        return res
          .status(400)
          .json({ error: "backgroundMusicUrl must be a valid URL" });
      }
    }

    try {
      const mod = await checkModeration(trimmedNarration);
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

    const work = makeWorkDir();
    const localImages: string[] = [];
    let localBgm: string | undefined;

    try {
      for (let i = 0; i < normalizedImageUrls.length; i++) {
        localImages.push(await downloadToTemp(normalizedImageUrls[i], work, i));
      }

      if (normalizedBgm) {
        localBgm = await downloadToTempNamed(normalizedBgm, work, "bgm");
      }

      const resolvedLocale =
        locale !== undefined && locale !== null
          ? resolveLocale(req, locale)
          : resolveLocale(req);

      const outPath = path.join(work, "out.mp4");

      await createSlideshowWithTTS(
        localImages,
        trimmedNarration,
        outPath,
        widthNum,
        heightNum,
        voice,
        localBgm,
        musicVolumeNum,
        speechRateNum,
        resolvedLocale,
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
      { name: "images", maxCount: config.limits.imageMaxCount },
      { name: "bgm", maxCount: 1 },
    ]),
    async (req: Request, res: Response) => {
      const narrationText = String(
        (req.body?.narrationText ?? "").toString(),
      ).trim();
      const width = Number(req.body?.width ?? config.defaults.width);
      const height = Number(req.body?.height ?? config.defaults.height);
      const voice = req.body?.voice ?? config.defaults.voice;
      const musicVolume = Number(
        req.body?.musicVolume ?? config.defaults.musicVolume,
      );
      const speechRate = Number(
        req.body?.speechRate ?? config.defaults.speechRate,
      );
      const locale = req.body?.locale;

      const files = (req as Request & { files?: MulterFiles }).files || {};
      const images = (files["images"] as Express.Multer.File[]) || [];

      if (!narrationText || images.length === 0) {
        return res
          .status(400)
          .json({ error: "narrationText and images[] are required" });
      }

      if (narrationText.length > config.limits.narrationMaxChars) {
        return res.status(400).json({
          error: `narrationText must be <= ${config.limits.narrationMaxChars} characters`,
        });
      }

      if (!isVoice(voice)) {
        return res
          .status(400)
          .json({ error: `voice must be one of: ${VOICES.join(", ")}` });
      }

      const widthNum = parseBoundedInteger(
        width,
        config.defaults.width,
        config.limits.widthMin,
        config.limits.widthMax,
      );
      const heightNum = parseBoundedInteger(
        height,
        config.defaults.height,
        config.limits.heightMin,
        config.limits.heightMax,
      );
      const speechRateNum = parseBoundedNumber(
        speechRate,
        config.defaults.speechRate,
        config.limits.speechRateMin,
        config.limits.speechRateMax,
      );
      const musicVolumeNum = parseBoundedNumber(
        musicVolume,
        config.defaults.musicVolume,
        config.limits.musicVolumeMin,
        config.limits.musicVolumeMax,
      );

      if (
        widthNum === undefined ||
        heightNum === undefined ||
        speechRateNum === undefined ||
        musicVolumeNum === undefined
      ) {
        return res.status(400).json({ error: "Invalid render settings" });
      }

      try {
        const mod = await checkModeration(narrationText);
        if (!mod.ok) {
          return res.status(400).json({
            error: "Narration text rejected by content moderation",
            categories: mod.categories,
          });
        }
      } catch (err) {
        console.error("Moderation error:", err);
        return res
          .status(503)
          .json({ error: "Moderation service unavailable" });
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

        const resolvedLocale =
          locale !== undefined && locale !== null
            ? resolveLocale(req, locale)
            : resolveLocale(req);

        const outPath = path.join(work, "out.mp4");

        await createSlideshowWithTTS(
          localImages,
          narrationText,
          outPath,
          widthNum,
          heightNum,
          voice,
          localBgm,
          musicVolumeNum,
          speechRateNum,
          resolvedLocale,
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
}

// =============================================================================
// Startup
// =============================================================================

async function main() {
  await ensureJobIndexes();
  startWorkerLoop();

  app.listen(config.port, () => {
    console.log(`Slideshow API listening on :${config.port}`);
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
