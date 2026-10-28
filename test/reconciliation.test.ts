import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/sqlite/store.ts";
import { createApp } from "../src/http/server.ts";
import { MindseaClient } from "../src/client/index.ts";
import { reconcileNext, runReconciler } from "../src/application/reconcile-events.ts";
const user = "alice";
const empty = { updates: [], creates: [] };

function event(store: Store, id: string, content = "这个安排取消了") {
  return store.addEvent(user, { id, sessionId: "chat", role: "user", content });
}

test("events and maintenance jobs are durable and idempotent; v1 data is preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenda-"));
  try {
    const path = join(dir, "mindsea.sqlite");
    let store = new Store(path);
    store.save(user, {
      kind: "future",
      content: "远期面试",
      followUpAt: "2099-01-01T00:00:00Z",
    });
    store.db.exec("DROP TABLE reconciliation_jobs; PRAGMA user_version=1");
    store.close();
    store = new Store(path);
    event(store, "cancel");
    event(store, "cancel");
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM reconciliation_jobs").get()!.n,
      1,
    );
    store.close();
    store = new Store(path);
    try {
      assert.equal(store.nextReconciliation(user)?.event.id, "cancel");
      assert.equal(store.agenda(user).items[0]?.content, "远期面试");
      assert.equal(store.db.prepare("PRAGMA user_version").get()!.user_version, 3);
      store.db.exec(
        `CREATE TRIGGER fail_job BEFORE INSERT ON reconciliation_jobs BEGIN SELECT RAISE(ABORT,'queue failure'); END;`,
      );
      assert.throws(() => event(store, "must-rollback"));
      assert.throws(() => store.event(user, "must-rollback"), { status: 404 });
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maintenance processes events in arrival order and preserves preceding session context", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  event(store, "first", "面试改时间了");
  event(store, "second", "算了，取消吧");
  const revision = store.agendaRevision(user);
  assert.throws(
    () => store.reconcile(user, "second", { ...empty, agendaRevision: revision }),
    { status: 409 },
  );
  assert.equal(store.nextReconciliation(user)?.recentEvents.length, 0);
  store.reconcile(user, "first", { ...empty, agendaRevision: revision });
  const second = store.nextReconciliation(user)!;
  assert.equal(second.event.id, "second");
  assert.deepEqual(
    second.recentEvents.map((e) => e.id),
    ["first"],
  );
  assert.equal(store.nextReconciliation("bob"), null);
  assert.throws(
    () => store.reconcile("bob", "second", { ...empty, agendaRevision: revision }),
    { status: 404 },
  );
});

test("failed batch rolls back every item, revision and checkpoint; retry is idempotent", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const a = store.save(user, {
    kind: "future",
    content: "面试",
    followUpAt: "2099-01-01T00:00:00Z",
  });
  const b = store.save(user, { kind: "loop", content: "做游戏" });
  event(store, "cancel");
  const revision = store.agendaRevision(user);
  const plan = {
    agendaRevision: revision,
    updates: [
      {
        id: a.id,
        version: 1,
        item: { kind: "future", content: "面试取消", status: "cancelled" },
      },
      {
        id: b.id,
        version: 99,
        item: { kind: "loop", content: "游戏取消", status: "cancelled" },
      },
    ],
    creates: [],
  };
  assert.throws(() => store.reconcile(user, "cancel", plan), { status: 409 });
  assert.equal(store.get(user, a.id).version, 1);
  assert.equal(store.history(user, a.id).length, 1);
  assert.equal(store.agendaRevision(user), revision);
  assert.equal(store.nextReconciliation(user)?.event.id, "cancel");
  plan.updates[1]!.version = 1;
  const result = store.reconcile(user, "cancel", plan);
  assert.equal(result[0]?.status, "cancelled");
  assert.equal(result[0]?.sourceEventId, "cancel");
  assert.equal(store.nextReconciliation(user), null);
  assert.deepEqual(store.reconcile(user, "cancel", plan), result);
  assert.equal(store.history(user, a.id).length, 2);
});

test("stale empty decisions cannot checkpoint past concurrent agenda changes", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  event(store, "change");
  const job = store.nextReconciliation(user)!;
  store.save(user, { kind: "loop", content: "新计划" });
  assert.throws(
    () =>
      store.reconcile(user, "change", {
        ...empty,
        agendaRevision: job.agendaRevision,
      }),
    { status: 409 },
  );
  assert.equal(store.nextReconciliation(user)?.event.id, "change");
});

test("agenda pages include far-future, followed-up and terminal states without recall filters", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (const status of ["pending", "followed_up", "completed", "cancelled", "expired"])
    store.save(user, {
      kind: "future",
      content: "计划",
      status,
      followUpAt: "2099-01-01T00:00:00Z",
    });
  store.save("bob", { kind: "loop", content: "私密计划" });
  store.save(user, { kind: "memory", content: "画像不是议程" });
  const ids = new Set<string>();
  let cursor = "";
  do {
    const page = store.agenda(user, cursor, 2);
    for (const item of page.items) ids.add(item.id);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  } while (cursor.length > 0);
  assert.equal(ids.size, 5);
});

test("background worker cancels an unawakened future without recall, context or due calls", async (t) => {
  const store = new Store(":memory:");
  const server = createApp(store, "test-secret-with-at-least-24-characters");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const client = new MindseaClient({
    baseUrl: `http://127.0.0.1:${addr.port}`,
    apiKey: "test-secret-with-at-least-24-characters",
    userId: user,
  });
  const future = await client.remember({
    kind: "future",
    content: "下个月面试",
    followUpAt: "2099-01-01T00:00:00Z",
  });
  const originalContext = client.context.bind(client);
  client.context = async () => {
    throw new Error("Worker must not use context");
  };
  client.recall = async () => {
    throw new Error("Worker must not use recall");
  };
  client.due = async () => {
    throw new Error("Worker must not use due");
  };
  await client.record({
    id: "cancel",
    sessionId: "s",
    role: "user",
    content: "那个面试取消了",
  });
  const abort = new AbortController();
  // Deterministic model stand-in; verifies delivery of new evidence and the unawakened item.
  const worker = runReconciler(
    client,
    async (input) => {
      assert.equal(input.event.content, "那个面试取消了");
      assert.equal(input.agenda[0]?.id, future.id);
      return {
        updates: [
          {
            id: future.id,
            version: future.version,
            item: {
              kind: "future",
              content: "面试已取消",
              status: "cancelled",
            },
          },
        ],
        creates: [],
      };
    },
    {
      signal: abort.signal,
      pollMs: 50,
      onError: (error) => {
        throw error;
      },
    },
  );
  for (let i = 0; i < 100 && store.get(user, future.id).status !== "cancelled"; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  await worker;
  assert.equal(store.get(user, future.id).status, "cancelled");
  assert.equal(store.history(user, future.id).length, 2);
  assert.equal(store.nextReconciliation(user), null);
  assert.equal(await reconcileNext(client, async () => empty), false);
  await client.record({
    id: "another",
    sessionId: "s",
    role: "user",
    content: "今天天气不错",
  });
  const context = await originalContext("面试");
  assert.equal(context.reconciliationPending, true);
  assert.deepEqual(context.candidates, {
    due: [],
    openLoops: [],
    relevant: [],
  });
  // Model failure must leave the event pending for restart/retry.
  await assert.rejects(() =>
    reconcileNext(client, async () => {
      throw new Error("model unavailable");
    }),
  );
  assert.equal(store.nextReconciliation(user)?.event.id, "another");
  await reconcileNext(client, async () => empty);
  assert.equal((await originalContext("面试")).reconciliationPending, false);
});

test("service rejects assistant-authored plans even when the DSH guard is bypassed", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const item = store.save(user, {
    kind: "future",
    content: "面试",
    followUpAt: "2099-01-01T00:00:00Z",
  });
  store.addEvent(user, {
    id: "assistant-evidence",
    sessionId: "chat",
    role: "assistant",
    content: "面试后来怎样了？",
  });
  const agendaRevision = store.agendaRevision(user);
  assert.throws(
    () =>
      store.reconcile(user, "assistant-evidence", {
        agendaRevision,
        updates: [],
        creates: [{ kind: "loop", content: "未经用户确认的计划" }],
      }),
    { status: 400 },
  );
  assert.throws(
    () =>
      store.reconcile(user, "assistant-evidence", {
        agendaRevision,
        updates: [
          {
            id: item.id,
            version: 1,
            item: { kind: "future", content: item.content, status: "completed" },
          },
        ],
        creates: [],
      }),
    { status: 400 },
  );
  assert.equal(store.get(user, item.id).version, 1);
  assert.equal(store.nextReconciliation(user)?.event.id, "assistant-evidence");
  store.reconcile(user, "assistant-evidence", {
    agendaRevision,
    updates: [
      {
        id: item.id,
        version: 1,
        item: {
          kind: "future",
          content: item.content,
          status: "followed_up",
          followUpAt: item.followUpAt,
        },
      },
    ],
    creates: [],
  });
  assert.equal(store.get(user, item.id).status, "followed_up");
});
