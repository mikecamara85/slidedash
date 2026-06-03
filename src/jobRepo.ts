// ./src/jobRepo.ts

import { randomBytes } from "crypto";
import type { FindOneAndUpdateOptions, Collection } from "mongodb";
import { config, type VoiceType } from "./config";
import { getDb } from "./mongo";

export type SlideshowJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export type SlideshowJobClientMetadata = {
  source?: string;
  dealerSite?: string;
  vehicleVin?: string;
};

export type SlideshowJobRequest = {
  narrationText: string;
  imageUrls: string[];
  backgroundMusicUrl?: string;
  width: number;
  height: number;
  voice: VoiceType;
  musicVolume: number;
  speechRate: number;
  locale: string;
  client?: SlideshowJobClientMetadata;
};

export type SlideshowJobArtifact = {
  contentType: "video/mp4";
  filename: string;
  objectKey: string;
  sizeBytes: number;
  durationSeconds?: number;
  createdAt: Date;
};

export type SlideshowJobError = {
  code: string;
  message: string;
};

export type SlideshowJobDocument = {
  _id: string;
  status: SlideshowJobStatus;
  request: SlideshowJobRequest;

  artifact?: SlideshowJobArtifact;
  error?: SlideshowJobError;

  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;

  attempts: number;

  workerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: Date;
};

export type CreateQueuedJobInput = SlideshowJobRequest;

export type ClaimedJob = {
  job: SlideshowJobDocument;
  leaseToken: string;
};

function generateJobId(): string {
  return `sdj_${randomBytes(12).toString("hex")}`;
}

function generateLeaseToken(): string {
  return `lease_${randomBytes(12).toString("hex")}`;
}

async function getJobsCollection(): Promise<Collection<SlideshowJobDocument>> {
  const db = await getDb();
  return db.collection<SlideshowJobDocument>(config.mongo.jobsCollection);
}

export async function ensureJobIndexes(): Promise<void> {
  const jobs = await getJobsCollection();

  await Promise.all([
    jobs.createIndex({ createdAt: -1 }),
    jobs.createIndex({ status: 1, createdAt: 1 }),
    jobs.createIndex({ leaseExpiresAt: 1 }),
    jobs.createIndex({ "request.client.vehicleVin": 1 }),
  ]);
}

export async function createQueuedJob(
  input: CreateQueuedJobInput,
): Promise<SlideshowJobDocument> {
  const jobs = await getJobsCollection();
  const now = new Date();

  const doc: SlideshowJobDocument = {
    _id: generateJobId(),
    status: "queued",
    request: {
      narrationText: input.narrationText,
      imageUrls: [...input.imageUrls],
      backgroundMusicUrl: input.backgroundMusicUrl,
      width: input.width,
      height: input.height,
      voice: input.voice,
      musicVolume: input.musicVolume,
      speechRate: input.speechRate,
      locale: input.locale,
      client: input.client
        ? {
            source: input.client.source,
            dealerSite: input.client.dealerSite,
            vehicleVin: input.client.vehicleVin,
          }
        : undefined,
    },
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  };

  await jobs.insertOne(doc);
  return doc;
}

export async function getJobById(
  jobId: string,
): Promise<SlideshowJobDocument | null> {
  const jobs = await getJobsCollection();
  return jobs.findOne({ _id: jobId });
}

export async function claimNextJob(
  workerId: string,
): Promise<ClaimedJob | null> {
  const jobs = await getJobsCollection();
  const now = new Date();
  const leaseToken = generateLeaseToken();
  const leaseExpiresAt = new Date(now.getTime() + config.worker.leaseMs);

  const options: FindOneAndUpdateOptions = {
    sort: { createdAt: 1 },
    returnDocument: "after",
  };

  const result = await jobs.findOneAndUpdate(
    {
      $or: [
        { status: "queued" },
        {
          status: "processing",
          leaseExpiresAt: { $lte: now },
        },
      ],
    },
    {
      $set: {
        status: "processing",
        updatedAt: now,
        startedAt: now,
        workerId,
        leaseToken,
        leaseExpiresAt,
      },
      $unset: {
        error: "",
        failedAt: "",
      },
      $inc: {
        attempts: 1,
      },
    },
    options,
  );

  if (!result) {
    return null;
  }

  return {
    job: result,
    leaseToken,
  };
}

export async function heartbeatJobLease(
  jobId: string,
  leaseToken: string,
): Promise<boolean> {
  const jobs = await getJobsCollection();
  const now = new Date();
  const nextLeaseExpiresAt = new Date(now.getTime() + config.worker.leaseMs);

  const result = await jobs.updateOne(
    {
      _id: jobId,
      status: "processing",
      leaseToken,
    },
    {
      $set: {
        updatedAt: now,
        leaseExpiresAt: nextLeaseExpiresAt,
      },
    },
  );

  return result.modifiedCount === 1;
}

export async function markJobCompleted(
  jobId: string,
  leaseToken: string,
  artifact: SlideshowJobArtifact,
): Promise<SlideshowJobDocument | null> {
  const jobs = await getJobsCollection();
  const now = new Date();

  const result = await jobs.findOneAndUpdate(
    {
      _id: jobId,
      status: "processing",
      leaseToken,
    },
    {
      $set: {
        status: "completed",
        updatedAt: now,
        completedAt: now,
        artifact,
      },
      $unset: {
        error: "",
        failedAt: "",
        workerId: "",
        leaseToken: "",
        leaseExpiresAt: "",
      },
    },
    {
      returnDocument: "after",
    },
  );

  return result;
}

export async function markJobFailed(
  jobId: string,
  leaseToken: string,
  error: SlideshowJobError,
): Promise<SlideshowJobDocument | null> {
  const jobs = await getJobsCollection();
  const now = new Date();

  const result = await jobs.findOneAndUpdate(
    {
      _id: jobId,
      status: "processing",
      leaseToken,
    },
    {
      $set: {
        status: "failed",
        updatedAt: now,
        failedAt: now,
        error: {
          code: error.code,
          message: error.message,
        },
      },
      $unset: {
        artifact: "",
        completedAt: "",
        workerId: "",
        leaseToken: "",
        leaseExpiresAt: "",
      },
    },
    {
      returnDocument: "after",
    },
  );

  return result;
}
