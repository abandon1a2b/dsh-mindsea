import type { MindseaClient } from "../../../src/client/index.ts";
import {
  reconcileNext,
  type DecideAgendaChanges,
} from "../../../src/application/reconcile-events.ts";
import type { EventBuffer } from "./event-buffer.ts";
export function createMaintenance(
  client: MindseaClient,
  decide: DecideAgendaChanges,
  buffer: EventBuffer,
  signal: AbortSignal,
  warn: () => void,
) {
  let running: Promise<void> | undefined;
  const pump = (): Promise<void> => {
    if (signal.aborted) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        await buffer.flush();
        // Bound one wakeup. The next timer tick continues without any user turn or recall.
        for (let i = 0; i < 100 && !signal.aborted; i++)
          if (
            !(await reconcileNext(client, decide, {
              signal: signal,
              maxAgendaItems: 1000,
            }))
          )
            break;
      } catch {
        if (!signal.aborted) warn();
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
  return { pump, settled: () => running };
}
export async function waitForMaintenance(
  work: Promise<void>,
  budgetMs: number,
  signal: AbortSignal,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, budgetMs);
        onAbort = resolve;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) resolve();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
