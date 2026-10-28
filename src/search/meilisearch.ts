import { z } from "zod";
const taskReceiptSchema = z.object({ taskUid: z.number().int().nonnegative() });
const taskStateSchema = z.object({
  status: z.enum(["enqueued", "processing", "succeeded", "failed", "canceled"]),
});
const searchResultSchema = z.object({ hits: z.array(z.object({ id: z.string() })) });
import type { Item } from "../contracts/items.ts";
import type { Store } from "../storage/sqlite/store.ts";

// SQLite is authoritative. This optional index is disposable and rebuildable.
export class MeiliSearch {
  url: string;
  key: string;
  index: string;
  ready = false;
  lastError: string | null = null;
  constructor(url: string, key = "", index = "mindsea_v1") {
    this.url = url.replace(/\/$/, "");
    this.key = key;
    this.index = index;
    if (!/^[a-zA-Z0-9_-]+$/.test(index))
      throw new Error("Invalid Meilisearch index name");
  }
  async request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await fetch(this.url + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Meilisearch HTTP ${response.status}`);
    return response.json();
  }
  async task(receipt: unknown) {
    const task = taskReceiptSchema.parse(receipt);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = taskStateSchema.parse(await this.request(`/tasks/${task.taskUid}`));
      if (state.status === "succeeded") return;
      if (state.status === "failed" || state.status === "canceled")
        throw new Error("Meilisearch indexing task failed");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Meilisearch task timeout");
  }
  async sync(store: Store) {
    try {
      if (!this.ready) {
        // Empty upsert creates a missing index and is safe for an existing one.
        await this.task(
          await this.request(
            `/indexes/${this.index}/documents?primaryKey=id`,
            "POST",
            [],
          ),
        );
        await this.task(
          await this.request(`/indexes/${this.index}/settings`, "PATCH", {
            searchableAttributes: ["content"],
            filterableAttributes: ["userId", "status", "kind"],
          }),
        );
        store.reindex();
        this.ready = true;
      }
      const items = store.pending();
      if (items.length) {
        await this.task(
          await this.request(`/indexes/${this.index}/documents`, "POST", items),
        );
        store.acknowledge(items);
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Index sync failed";
      throw error;
    }
  }
  async recall(
    store: Store,
    user: string,
    query: string,
    limit: number,
    memoryOnly = false,
  ): Promise<Item[]> {
    // Pending writes and outages must never hide new authoritative records.
    if (!this.ready || this.lastError || store.pending(1).length || !query.trim())
      return store.recall(user, query, limit, memoryOnly);
    try {
      const raw = await this.request(`/indexes/${this.index}/search`, "POST", {
        q: query,
        limit,
        filter: [
          `userId = ${JSON.stringify(user)}`,
          "status IN [active,pending,followed_up]",
          ...(memoryOnly ? ["kind = memory"] : []),
        ],
      });
      const result = searchResultSchema.parse(raw);
      if (store.pending(1).length) return store.recall(user, query, limit, memoryOnly);
      const items: Item[] = [];
      for (const hit of result.hits) {
        try {
          const current = store.get(user, hit.id);
          if (
            ["active", "pending", "followed_up"].includes(current.status) &&
            (!memoryOnly || current.kind === "memory")
          )
            items.push(current);
        } catch {
          /* Reject stale or foreign hits. */
        }
      }
      return items;
    } catch {
      return store.recall(user, query, limit, memoryOnly);
    }
  }
}
