import { setTimeout as delay } from "node:timers/promises";
import type { MindseaClient } from "../client/index.ts";
import type { Item } from "../contracts/items.ts";
import type { ReconciliationJob, ReconciliationPlan } from "../contracts/agenda.ts";

export type DecideAgendaChanges = (
  input: ReconciliationJob & {
    agenda: Item[];
    signal?: AbortSignal;
  },
) => Promise<Pick<ReconciliationPlan, "updates" | "creates">>;

/** Event-driven maintenance. It never calls context(), recall(), or due(). */
export async function reconcileNext(
  client: MindseaClient,
  decide: DecideAgendaChanges,
  options: { signal?: AbortSignal; maxAgendaItems?: number } = {},
): Promise<boolean> {
  options.signal?.throwIfAborted();
  const { job } = await client.nextReconciliation();
  if (!job) return false;
  const agenda: Item[] = [];
  let cursor = "";
  do {
    options.signal?.throwIfAborted();
    const page = await client.agenda(cursor);
    if (page.agendaRevision !== job.agendaRevision)
      throw new Error("Agenda changed while reading; retry event");
    agenda.push(...page.items);
    if (agenda.length > (options.maxAgendaItems ?? 10_000))
      throw new Error("Agenda exceeds worker limit; event remains pending");
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  } while (cursor.length > 0);
  const changes = await decide({ ...job, agenda, signal: options.signal });
  options.signal?.throwIfAborted();
  await client.reconcile(job.event.id, {
    ...changes,
    agendaRevision: job.agendaRevision,
  });
  return true;
}

/** Start once per authenticated user in the host's background lifecycle, not on recall. */
export async function runReconciler(
  client: MindseaClient,
  decide: DecideAgendaChanges,
  options: {
    signal: AbortSignal;
    pollMs?: number;
    maxAgendaItems?: number;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isFinite(pollMs) || pollMs < 50)
    throw new Error("pollMs must be at least 50");
  while (!options.signal.aborted) {
    try {
      if (await reconcileNext(client, decide, options)) continue;
    } catch (error) {
      if (options.signal.aborted) break;
      options.onError?.(error);
    }
    try {
      await delay(pollMs, undefined, { signal: options.signal });
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}
