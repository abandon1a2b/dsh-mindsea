import type { MindseaClient } from "../../../src/client/index.ts";
import {
  processMemoryJob,
  type DecideMemory,
} from "../../../src/application/memory/process-job.ts";

/** Independent lifecycle: a failing or slow memory model never delays Future maintenance. */
export function startMemoryMaintenance(
  client: MindseaClient,
  decide: DecideMemory,
  signal: AbortSignal,
  pollMs: number,
  warn: () => void,
  enabled: () => boolean = () => true,
) {
  let running: Promise<void> | undefined;
  const pump = () => {
    if (signal.aborted || running || !enabled()) return;
    running = (async () => {
      try {
        for (let i = 0; i < 20 && !signal.aborted; i++)
          if (!(await processMemoryJob(client, decide, signal))) break;
      } catch {
        if (!signal.aborted) warn();
      }
    })().finally(() => {
      running = undefined;
    });
  };
  const timer = setInterval(pump, Math.max(pollMs, 1000));
  timer.unref();
  pump();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
