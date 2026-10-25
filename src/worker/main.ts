import { Queue, Worker } from "bullmq";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getEnv } from "@/lib/validation/env";
import { processMediaJob } from "@/lib/media/process-job";

async function main() {
  const connection = { url: getEnv().REDIS_URL, maxRetriesPerRequest: null };
  const queue = new Queue("privateflix-media", { connection });
  queue.on("error", () => console.error("[PROCESSING] Queue unavailable"));
  await queue.setGlobalConcurrency(1);
  const shutdown = new AbortController();
  const worker = new Worker(
    "privateflix-media",
    async (job) => {
      const { id } = z
        .object({ id: z.string().uuid() })
        .strict()
        .parse(job.data);
      await processMediaJob(id, "/work", shutdown.signal);
    },
    { connection, concurrency: 1, lockDuration: 60000, maxStalledCount: 2 },
  );
  worker.on("error", () =>
    console.error("[PROCESSING] Queue connection failed"),
  );
  let dispatching = false;
  async function dispatch() {
    if (dispatching || shutdown.signal.aborted) return;
    dispatching = true;
    try {
      const jobs = await prisma.processingJob.findMany({
        where: {
          type: "METADATA",
          OR: [
            {
              status: "QUEUED",
              OR: [
                { startedAt: null },
                { startedAt: { lt: new Date(Date.now() - 60000) } },
              ],
            },
            { status: "PROCESSING", leaseExpiresAt: { lt: new Date() } },
          ],
        },
        select: { id: true, attempts: true },
        take: 100,
        orderBy: { createdAt: "asc" },
      });
      for (const job of jobs) {
        const jobId = `${job.id}-${job.attempts}`;
        const existing = await queue.getJob(jobId);
        if (existing && (await existing.getState()) === "failed")
          await existing.remove();
        await queue.add(
          "metadata",
          { id: job.id },
          {
            jobId,
            removeOnComplete: true,
            removeOnFail: { age: 3600, count: 1000 },
          },
        );
      }
    } catch {
      console.error("[PROCESSING] Dispatch failed; durable jobs will retry");
    } finally {
      dispatching = false;
    }
  }
  const timer = setInterval(() => void dispatch(), 5000);
  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    shutdown.abort();
    await worker.close();
    await queue.close();
    await prisma.$disconnect();
  }
  process.once("SIGTERM", () => void close());
  process.once("SIGINT", () => void close());
  await dispatch();
  console.info("[PROCESSING] Worker ready");
}
void main().catch(() => {
  console.error("[PROCESSING] Worker startup failed");
  process.exit(1);
});
