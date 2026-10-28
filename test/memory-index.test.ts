import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage/sqlite/store.ts";
import { MeiliSearch } from "../src/search/meilisearch.ts";
import { memoryInputSchema } from "../src/contracts/memory.ts";
import { atomic } from "../src/storage/sqlite/transaction.ts";

test("layered index validates stale/foreign hits, deletes forgotten documents and retains newer outbox writes", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const create = (user: string) => {
    const ev = store.addEvent(user, {
      sessionId: "s",
      role: "user",
      content: "用户喜欢极简风格",
    });
    const record = memoryInputSchema.parse({
      layer: "L1",
      kind: "fact",
      topic: "design",
      content: ev.content,
      basis: "explicit",
      evidence: [store.memory.records.evidence(user, ev.id)],
    });
    return {
      ev,
      record: atomic(store.db, () =>
        store.memory.records.save(user, record, ev.id, "test"),
      ),
    };
  };
  const own = create("alice");
  const foreign = create("bob");
  const api = new MeiliSearch("http://unused.invalid");
  const writes: { path: string; body: unknown }[] = [];
  api.request = async (path, _method, body) => {
    if (path.startsWith("/tasks/")) return { status: "succeeded" };
    if (path.endsWith("/search"))
      return { hits: [{ id: foreign.record.id }, { id: own.record.id }] };
    writes.push({ path, body });
    return { taskUid: 1 };
  };
  await api.memory.sync(store);
  assert.equal(api.memory.pending(store).length, 0);
  assert.equal(
    (await api.memory.recall(store, "alice", { query: "极简" })).items[0]!.id,
    own.record.id,
  );
  const upserts = writes.find(
    (item) =>
      item.path.endsWith("/documents") && Array.isArray(item.body) && item.body.length,
  )!;
  assert.equal(JSON.stringify(upserts.body).includes("contentHash"), false);
  store.memory.lifecycle.forget("alice", { eventIds: [own.ev.id] });
  assert.equal(
    (await api.memory.recall(store, "alice", { query: "极简" })).items.length,
    0,
  );
  await api.memory.sync(store);
  assert.ok(writes.some((item) => item.path.endsWith("/delete-batch")));
  // Cached foreign/stale hits are still not evidence after deletion.
  assert.equal(
    (await api.memory.recall(store, "alice", { query: "极简" })).items.length,
    0,
  );
});
