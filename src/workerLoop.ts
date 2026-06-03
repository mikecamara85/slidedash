// ./src/workerLoop.ts

import { randomBytes } from "crypto";

import { config } from "./config";
import { claimNextJob } from "./jobRepo";
import { processSlideshowJob } from "./processJob";

function makeWorkerId(): string {
  return `worker_${randomBytes(8).toString("hex")}`;
}

let started = false;

export function startWorkerLoop(): void {
  if (started) return;
  started = true;

  if (!config.worker.enabled) {
    console.log("[worker] disabled by config");
    return;
  }

  const workerId = makeWorkerId();
  console.log(
    `[worker] starting with id=${workerId}, pollIntervalMs=${config.worker.pollIntervalMs}`,
  );

  void runWorkerLoop(workerId);
}

async function runWorkerLoop(workerId: string): Promise<void> {
  while (true) {
    try {
      const claimed = await claimNextJob(workerId);

      if (!claimed) {
        await sleep(config.worker.pollIntervalMs);
        continue;
      }

      console.log(`[worker] claimed job ${claimed.job._id}`);
      await processSlideshowJob(claimed.job, claimed.leaseToken);
    } catch (error) {
      console.error("[worker] loop error:", error);
      await sleep(config.worker.pollIntervalMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
