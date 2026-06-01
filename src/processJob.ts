import fs from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";

import {
  createSlideshowWithTTS,
  probeMediaDurationSeconds,
} from "./createSlideshow";
import {
  heartbeatJobLease,
  markJobCompleted,
  markJobFailed,
  type SlideshowJobDocument,
} from "./jobRepo";
import { uploadVideoArtifactFromFile } from "./storage";

function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "slidedash-job-"));
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
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status}`);
  }

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
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status}`);
  }

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

function sanitizeFilenamePart(value?: string): string | undefined {
  if (!value) return undefined;

  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

  return cleaned || undefined;
}

function buildArtifactFilename(job: SlideshowJobDocument): string {
  const client = job.request.client;
  const parts = [
    sanitizeFilenamePart(client?.dealerSite),
    sanitizeFilenamePart(client?.vehicleVin),
    sanitizeFilenamePart(job._id),
  ].filter(Boolean);

  if (parts.length === 0) {
    return `slideshow-${job._id}.mp4`;
  }

  return `${parts.join("-")}.mp4`;
}

type ProcessFailure = {
  code: string;
  message: string;
};

function normalizeFailure(error: unknown): ProcessFailure {
  const message =
    error instanceof Error ? error.message : "Unknown slideshow job failure";

  const lower = message.toLowerCase();

  if (lower.includes("failed to download bgm")) {
    return {
      code: "bgm_download_failed",
      message,
    };
  }

  if (lower.includes("failed to download image")) {
    return {
      code: "image_download_failed",
      message,
    };
  }

  if (
    lower.includes("openai") ||
    lower.includes("tts") ||
    lower.includes("speech")
  ) {
    return {
      code: "tts_failed",
      message,
    };
  }

  if (
    lower.includes("s3") ||
    lower.includes("r2") ||
    lower.includes("putobject") ||
    lower.includes("signature") ||
    lower.includes("bucket")
  ) {
    return {
      code: "storage_failed",
      message,
    };
  }

  return {
    code: "render_failed",
    message,
  };
}

export async function processSlideshowJob(
  job: SlideshowJobDocument,
  leaseToken: string,
): Promise<void> {
  const work = makeWorkDir();
  const localImages: string[] = [];
  let localBgm: string | undefined;

  const heartbeat = setInterval(() => {
    heartbeatJobLease(job._id, leaseToken).catch((error) => {
      console.warn(`[worker] heartbeat failed for ${job._id}:`, error);
    });
  }, 30_000);

  try {
    for (let i = 0; i < job.request.imageUrls.length; i++) {
      const url = String(job.request.imageUrls[i]);

      try {
        localImages.push(await downloadToTemp(url, work, i));
      } catch (error: any) {
        throw new Error(
          `Failed to download image at index ${i}: ${error?.message || "download error"}`,
        );
      }
    }

    if (job.request.backgroundMusicUrl) {
      try {
        localBgm = await downloadToTempNamed(
          job.request.backgroundMusicUrl,
          work,
          "bgm",
        );
      } catch (error: any) {
        throw new Error(
          `Failed to download bgm: ${error?.message || "download error"}`,
        );
      }
    }

    const outPath = path.join(work, "out.mp4");

    await createSlideshowWithTTS(
      localImages,
      job.request.narrationText,
      outPath,
      job.request.width,
      job.request.height,
      job.request.voice,
      localBgm,
      job.request.musicVolume,
      job.request.speechRate,
      job.request.locale,
    );

    let durationSeconds: number | undefined;
    try {
      const probed = await probeMediaDurationSeconds(outPath);
      if (Number.isFinite(probed) && probed > 0) {
        durationSeconds = probed;
      }
    } catch (error) {
      console.warn(
        `[worker] failed to probe output duration for ${job._id}:`,
        error,
      );
    }

    const artifact = await uploadVideoArtifactFromFile({
      jobId: job._id,
      filePath: outPath,
      filename: buildArtifactFilename(job),
      durationSeconds,
    });

    await markJobCompleted(job._id, leaseToken, artifact);
  } catch (error) {
    const failure = normalizeFailure(error);
    console.error(`[worker] job ${job._id} failed:`, error);

    await markJobFailed(job._id, leaseToken, failure);
  } finally {
    clearInterval(heartbeat);

    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[worker] cleanup failed for ${job._id}:`, error);
    }
  }
}
