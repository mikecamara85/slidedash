// ./src/jobResponses.ts

import type { SlideshowJobDocument } from "./jobRepo";
import { createSignedArtifactDownload } from "./storage";

function toIso(date?: Date): string | undefined {
  return date ? date.toISOString() : undefined;
}

export async function buildJobResponse(job: SlideshowJobDocument) {
  const base: Record<string, unknown> = {
    jobId: job._id,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
  };

  if (job.startedAt) {
    base.startedAt = toIso(job.startedAt);
  }

  if (job.status === "completed") {
    if (job.completedAt) {
      base.completedAt = toIso(job.completedAt);
    }

    if (job.artifact) {
      const artifact: Record<string, unknown> = {
        contentType: job.artifact.contentType,
        filename: job.artifact.filename,
        sizeBytes: job.artifact.sizeBytes,
        durationSeconds: job.artifact.durationSeconds,
      };

      try {
        const signed = await createSignedArtifactDownload(job.artifact);
        artifact.downloadUrl = signed.downloadUrl;
        artifact.expiresAt = signed.expiresAt.toISOString();
      } catch (error) {
        console.warn(
          `[jobResponses] failed to create signed download URL for job ${job._id}:`,
          error,
        );
      }

      base.artifact = artifact;
    }

    return base;
  }

  if (job.status === "failed") {
    if (job.failedAt) {
      base.failedAt = toIso(job.failedAt);
    }

    base.error = job.error ?? {
      code: "render_failed",
      message: "Job failed",
    };

    return base;
  }

  return base;
}
