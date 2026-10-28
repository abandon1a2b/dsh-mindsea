import { z } from "zod";
import type { Store } from "../storage/sqlite/store.ts";
import {
  memoryQuerySchema,
  type MemoryRecall,
  type MemoryRecord,
} from "../contracts/memory.ts";
import type { MeiliSearch } from "./meilisearch.ts";

const hitsSchema = z.object({ hits: z.array(z.object({ id: z.string() })) });
/** A separate disposable index; evidence and event text never leave SQLite. */
export class MemoryIndex {
  transport: MeiliSearch;
  ready = false;
  lastError: string | null = null;
  constructor(transport: MeiliSearch) {
    this.transport = transport;
  }
  get index() {
    return `${this.transport.index}_memory`;
  }
  pending(store: Store): MemoryRecord[] {
    return store.db
      .prepare(
        "SELECT document FROM memory_outbox JOIN memory_records ON memory_records.id=memory_outbox.id LIMIT 100",
      )
      .all()
      .map((row) => JSON.parse(row.document as string) as MemoryRecord);
  }
  async sync(store: Store): Promise<void> {
    const api = this.transport;
    try {
      if (!this.ready) {
        await api.task(
          await api.request(
            `/indexes/${this.index}/documents?primaryKey=id`,
            "POST",
            [],
          ),
        );
        await api.task(
          await api.request(`/indexes/${this.index}/settings`, "PATCH", {
            searchableAttributes: ["content", "topic"],
            filterableAttributes: ["userId", "status", "layer"],
          }),
        );
        store.db.exec(
          "INSERT INTO memory_outbox SELECT id,version FROM memory_records WHERE true ON CONFLICT(id) DO UPDATE SET version=excluded.version",
        );
        this.ready = true;
      }
      const pending = this.pending(store);
      const live = pending.filter((item) => item.status !== "retracted");
      const removed = pending.filter((item) => item.status === "retracted");
      if (live.length)
        await api.task(
          await api.request(
            `/indexes/${this.index}/documents`,
            "POST",
            live.map(({ id, userId, layer, status, content, topic, version }) => ({
              id,
              userId,
              layer,
              status,
              content,
              topic,
              version,
            })),
          ),
        );
      if (removed.length)
        await api.task(
          await api.request(
            `/indexes/${this.index}/documents/delete-batch`,
            "POST",
            removed.map((item) => item.id),
          ),
        );
      for (const item of pending)
        store.db
          .prepare("DELETE FROM memory_outbox WHERE id=? AND version=?")
          .run(item.id, item.version);
      this.lastError = null;
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : "Memory index unavailable";
      throw error;
    }
  }
  async recall(store: Store, user: string, input: unknown): Promise<MemoryRecall> {
    const query = memoryQuerySchema.parse(input);
    const local = () => store.memory.retrieval.recall(user, query);
    if (
      !this.ready ||
      this.lastError ||
      this.pending(store).length ||
      !query.query ||
      query.asOf ||
      query.intent === "exact-quote"
    )
      return local();
    try {
      const revision = store.memory.records.revision(user);
      const result = hitsSchema.parse(
        await this.transport.request(`/indexes/${this.index}/search`, "POST", {
          q: query.query,
          limit: 100,
          filter: [
            `userId = ${JSON.stringify(user)}`,
            ...(query.includeInactive ? [] : ["status = active"]),
          ],
        }),
      );
      if (
        revision !== store.memory.records.revision(user) ||
        this.pending(store).length
      )
        return local();
      // Re-read every hit through the authoritative visibility/version/tenant checks.
      return store.memory.retrieval.recall(
        user,
        query,
        new Set(result.hits.map((hit) => hit.id)),
      );
    } catch {
      return local();
    }
  }
}
