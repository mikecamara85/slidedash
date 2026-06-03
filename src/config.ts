// ./src/config.ts

import "dotenv/config";

export const VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
] as const;

export type VoiceType = (typeof VOICES)[number];

type NumberOptions = {
  min?: number;
  max?: number;
  integer?: boolean;
};

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readRequiredEnv(name: string): string {
  const value = readOptionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = readOptionalEnv(name);
  if (raw === undefined) return fallback;

  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  throw new Error(
    `Environment variable ${name} must be a boolean-like value (true/false, 1/0, yes/no, on/off)`,
  );
}

function readNumberEnv(
  name: string,
  fallback: number,
  options: NumberOptions = {},
): number {
  const raw = readOptionalEnv(name);
  const value = raw === undefined ? fallback : Number(raw);

  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a valid number`);
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }

  if (options.min !== undefined && value < options.min) {
    throw new Error(`Environment variable ${name} must be >= ${options.min}`);
  }

  if (options.max !== undefined && value > options.max) {
    throw new Error(`Environment variable ${name} must be <= ${options.max}`);
  }

  return value;
}

function readVoiceEnv(name: string, fallback: VoiceType): VoiceType {
  const raw = readOptionalEnv(name);
  if (!raw) return fallback;

  if ((VOICES as readonly string[]).includes(raw)) {
    return raw as VoiceType;
  }

  throw new Error(
    `Environment variable ${name} must be one of: ${VOICES.join(", ")}`,
  );
}

const nodeEnv = readOptionalEnv("NODE_ENV") ?? "development";
const isProduction = nodeEnv === "production";

const apiKey = readOptionalEnv("SLIDEDASH_API_KEY");

if (isProduction && !apiKey) {
  throw new Error("SLIDEDASH_API_KEY is required in production");
}

export const config = {
  nodeEnv,
  isProduction,

  port: readNumberEnv("PORT", 8080, {
    min: 1,
    max: 65535,
    integer: true,
  }),

  api: {
    key: apiKey,
  },

  legacy: {
    syncRoutesEnabled: readBooleanEnv("LEGACY_SYNC_ROUTES_ENABLED", true),
  },

  mongo: {
    uri: readRequiredEnv("MONGODB_URI"),
    dbName: readOptionalEnv("MONGODB_DB_NAME") ?? "slidedash",
    jobsCollection:
      readOptionalEnv("MONGODB_JOBS_COLLECTION") ?? "slideshow_jobs",
  },

  storage: {
    endpoint: readRequiredEnv("R2_ENDPOINT"),
    region: readOptionalEnv("R2_REGION") ?? "auto",
    accessKeyId: readRequiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: readRequiredEnv("R2_SECRET_ACCESS_KEY"),
    bucket: readRequiredEnv("R2_BUCKET"),
    keyPrefix: readOptionalEnv("R2_KEY_PREFIX") ?? "slideshows",
    signedUrlTtlSeconds: readNumberEnv("R2_SIGNED_URL_TTL_SECONDS", 3600, {
      min: 60,
      max: 604800,
      integer: true,
    }),
    artifactRetentionDays: readNumberEnv("ARTIFACT_RETENTION_DAYS", 14, {
      min: 1,
      max: 365,
      integer: true,
    }),
  },

  worker: {
    enabled: readBooleanEnv("JOB_WORKER_ENABLED", true),
    pollIntervalMs: readNumberEnv("JOB_POLL_INTERVAL_MS", 4000, {
      min: 1000,
      max: 60000,
      integer: true,
    }),
    leaseMs: readNumberEnv("JOB_LEASE_MS", 45 * 60 * 1000, {
      min: 60_000,
      max: 24 * 60 * 60 * 1000,
      integer: true,
    }),
  },

  defaults: {
    width: readNumberEnv("DEFAULT_WIDTH", 1600, {
      min: 320,
      max: 3840,
      integer: true,
    }),
    height: readNumberEnv("DEFAULT_HEIGHT", 1200, {
      min: 240,
      max: 3840,
      integer: true,
    }),
    voice: readVoiceEnv("DEFAULT_VOICE", "shimmer"),
    speechRate: readNumberEnv("DEFAULT_SPEECH_RATE", 1, {
      min: 0.5,
      max: 2,
    }),
    musicVolume: readNumberEnv("DEFAULT_MUSIC_VOLUME", 0.2, {
      min: 0,
      max: 1,
    }),
    locale: readOptionalEnv("DEFAULT_LOCALE") ?? "en-US",
  },

  limits: {
    narrationMaxChars: readNumberEnv("NARRATION_MAX_CHARS", 1500, {
      min: 1,
      max: 10000,
      integer: true,
    }),
    imageMaxCount: readNumberEnv("IMAGE_MAX_COUNT", 40, {
      min: 1,
      max: 200,
      integer: true,
    }),
    widthMin: 320,
    widthMax: 3840,
    heightMin: 240,
    heightMax: 3840,
    speechRateMin: 0.5,
    speechRateMax: 2,
    musicVolumeMin: 0,
    musicVolumeMax: 1,
  },

  openai: {
    moderationModel:
      readOptionalEnv("OPENAI_MODERATION_MODEL") ?? "omni-moderation-latest",
    ttsModel: readOptionalEnv("TTS_MODEL") ?? "gpt-4o-mini-tts",
  },
} as const;
