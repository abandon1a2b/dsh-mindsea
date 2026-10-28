import type { MindseaClient } from "../../client/index.ts";
import {
  memoryPlanSchema,
  type MemoryJob,
  type MemoryPlan,
  type Evidence,
} from "../../contracts/memory.ts";

export interface MemoryModelInput extends MemoryJob {
  sourceEvidence: Evidence[];
  signal?: AbortSignal;
}
export type DecideMemory = (input: MemoryModelInput) => Promise<MemoryPlan>;

/** Memory is processed independently of Future and is never automatically injected. */
export async function processMemoryJob(
  client: MindseaClient,
  decide: DecideMemory,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const { job } = await client.claimMemory();
  if (!job) return false;
  try {
    const sourceEvidence: Evidence[] = [];
    for (const event of [...job.recentEvents, job.event])
      if (event.role === "user") sourceEvidence.push(await client.evidence(event.id));
    const plan = memoryPlanSchema.parse(
      await decide({ ...job, sourceEvidence, signal }),
    );
    signal?.throwIfAborted();
    await client.commitMemory(job, plan);
    return true;
  } catch (error) {
    // A lease survives abrupt disconnects; normal failures release it with bounded backoff.
    try {
      await client.failMemory(job);
    } catch {
      /* Retry/commit may already have settled remotely. */
    }
    throw error;
  }
}
