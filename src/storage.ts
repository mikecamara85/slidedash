import { createReadStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { config } from "./config";
import type { SlideshowJobArtifact } from "./jobRepo";

const s3 = new S3Client({
  region: config.storage.region,
  endpoint: config.storage.endpoint,
  credentials: {
    accessKeyId: config.storage.accessKeyId,
    secretAccessKey: config.storage.secretAccessKey,
  },
  forcePathStyle: true,
});

function sanitizePathPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "") || "x"
  );
}

function splitAndSanitizePrefix(prefix: string): string[] {
  return prefix
    .split("/")
    .map((part) => sanitizePathPart(part))
    .filter(Boolean);
}

function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).trim() || "slideshow.mp4";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

  if (!cleaned) return "slideshow.mp4";
  return cleaned.toLowerCase().endsWith(".mp4") ? cleaned : `${cleaned}.mp4`;
}

function buildObjectKey(
  jobId: string,
  filename: string,
  now = new Date(),
): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");

  const parts = [
    ...splitAndSanitizePrefix(config.storage.keyPrefix),
    yyyy,
    mm,
    dd,
    sanitizePathPart(jobId),
    sanitizeFilename(filename),
  ];

  return parts.join("/");
}

export type UploadVideoArtifactInput = {
  jobId: string;
  filePath: string;
  filename: string;
  durationSeconds?: number;
};

export async function uploadVideoArtifactFromFile(
  input: UploadVideoArtifactInput,
): Promise<SlideshowJobArtifact> {
  const now = new Date();
  const filename = sanitizeFilename(input.filename);
  const objectKey = buildObjectKey(input.jobId, filename, now);
  const fileStat = await stat(input.filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: objectKey,
      Body: createReadStream(input.filePath),
      ContentType: "video/mp4",
      ContentLength: fileStat.size,
    }),
  );

  return {
    contentType: "video/mp4",
    filename,
    objectKey,
    sizeBytes: fileStat.size,
    durationSeconds: input.durationSeconds,
    createdAt: now,
  };
}

export type SignedArtifactDownload = {
  downloadUrl: string;
  expiresAt: Date;
};

export async function createSignedArtifactDownload(
  artifact: SlideshowJobArtifact,
): Promise<SignedArtifactDownload> {
  const expiresIn = config.storage.signedUrlTtlSeconds;
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  const command = new GetObjectCommand({
    Bucket: config.storage.bucket,
    Key: artifact.objectKey,
    ResponseContentType: artifact.contentType,
    ResponseContentDisposition: `attachment; filename="${artifact.filename}"`,
  });

  const downloadUrl = await getSignedUrl(s3, command, {
    expiresIn,
  });

  return {
    downloadUrl,
    expiresAt,
  };
}
