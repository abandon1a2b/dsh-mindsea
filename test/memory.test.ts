import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Store } from "../src/storage/sqlite/store.ts";
import { createApp } from "../src/http/server.ts";
import { buildContext } from "../src/application/assemble-context.ts";
import { MeiliSearch } from "../src/search/meilisearch.ts";

const user = "alice";
const key = "test-secret-with-at-least-24-characters";

test("Chinese search, literal FTS syntax and user isolation", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const item = store.save(user, {
    kind: "memory",
    content: "用户正在研究聊天记忆系统",
  });
  store.save("bob", { kind: "memory", content: "聊天记忆系统的另一位用户" });
  assert.deepEqual(
    store.recall(user, "聊天记忆").map((x) => x.id),
    [item.id],
  );
  assert.equal(store.recall(user, "记忆").length, 1);
  assert.equal(store.recall(user, '" OR *').length, 0);
  assert.throws(() => store.get("bob", item.id), { status: 404 });
});

test("event retries preserve the original timestamp and validate conflicts", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const event = {
    id: "external-message-1",
    sessionId: "s1",
    role: "user",
    content: "下周面试",
  };
  const first = store.addEvent(user, event);
  assert.deepEqual(store.addEvent(user, event), first);
  assert.throws(() => store.addEvent(user, { ...event, content: "different" }), {
    status: 409,
  });
  assert.throws(() => store.addEvent("bob", event), { status: 409 });
});

test("source references cannot cross users and failed writes roll back", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const source = store.addEvent("bob", {
    sessionId: "s",
    role: "user",
    content: "Private",
  });
  assert.throws(
    () =>
      store.save(user, {
        kind: "memory",
        content: "Wrong owner",
        sourceEventId: source.id,
      }),
    { status: 404 },
  );
  assert.equal(store.recall(user, "").length, 0);
  assert.equal(store.pending().length, 0);
});

test("due timeline normalizes timezones and ignores unrelated query", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const interview = store.save(user, {
    kind: "future",
    content: "面试后来怎么样",
    followUpAt: "2026-10-28T08:00:00+08:00",
  });
  store.save(user, {
    kind: "future",
    content: "明天的计划",
    followUpAt: "2026-10-29T08:00:00+08:00",
  });
  store.save("bob", {
    kind: "future",
    content: "私人的事件",
    followUpAt: "2026-10-27T08:00:00Z",
  });
  assert.equal(store.recall(user, "今天好累").length, 0);
  assert.equal(store.due(user, "2026-10-27T23:59:59.999Z").length, 0);
  assert.deepEqual(
    store.due(user, "2026-10-28T00:00:00Z").map((x) => x.id),
    [interview.id],
  );
  const updated = store.save(
    user,
    {
      kind: "future",
      content: interview.content,
      status: "followed_up",
      followUpAt: interview.followUpAt,
    },
    { id: interview.id, version: 1 },
  );
  assert.equal(store.due(user, "2026-10-28T00:00:00Z").length, 0);
  assert.equal(updated.status, "followed_up");
  assert.notEqual(updated.status, "completed");
});

test("revisions preserve evidence; stale writers cannot overwrite corrections", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const first = store.save(user, { kind: "memory", content: "Default JWT" });
  const second = store.save(
    user,
    { kind: "memory", content: "Default Session" },
    { id: first.id, version: 1 },
  );
  assert.equal(second.createdAt, first.createdAt);
  assert.throws(
    () =>
      store.save(
        user,
        { kind: "memory", content: "Stale JWT" },
        { id: first.id, version: 1 },
      ),
    { status: 409 },
  );
  assert.deepEqual(
    store.history(user, first.id).map((x) => x.content),
    ["Default JWT", "Default Session"],
  );
  assert.throws(() => store.history("bob", first.id), { status: 404 });
  store.save(
    user,
    { kind: "memory", content: second.content, status: "superseded" },
    { id: first.id, version: 2 },
  );
  assert.equal(store.recall(user, "Session").length, 0);
  assert.equal(store.recall(user, "JWT").length, 0);
});

test("outbox acknowledgements never lose newer writes", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const old = store.save(user, { kind: "memory", content: "Before" });
  store.save(user, { kind: "memory", content: "After" }, { id: old.id, version: 1 });
  store.acknowledge([old]);
  assert.equal(store.pending()[0]?.version, 2);
  store.acknowledge(store.pending());
  assert.equal(store.pending().length, 0);
  store.reindex();
  assert.equal(store.pending().length, 1);
});

test("open loops and context budget are bounded, deduplicated, and prioritize due items", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const future = store.save(user, {
    kind: "future",
    content: "面试",
    followUpAt: "2020-01-01T00:00:00Z",
  });
  const loop = store.save(user, { kind: "loop", content: "想做一个游戏" });
  const result = buildContext(
    { due: [future], openLoops: store.loops(user), relevant: [future, loop] },
    2000,
  );
  assert.equal(result.candidates.due.length, 1);
  assert.equal(result.candidates.openLoops.length, 1);
  assert.equal(result.candidates.relevant.length, 0);
  assert.equal(JSON.stringify(result.candidates).length, result.candidateChars);
  const small = buildContext({ due: [future], openLoops: [], relevant: [] }, 100);
  assert.ok(small.candidateChars <= 100);
  assert.equal(small.omitted, 1);
});

test("SQLite survives restart including FTS and revision state", () => {
  const dir = mkdtempSync(join(tmpdir(), "mindsea-"));
  try {
    let store = new Store(join(dir, "test.sqlite"));
    const item = store.save(user, { kind: "memory", content: "持久化记忆" });
    store.close();
    store = new Store(join(dir, "test.sqlite"));
    try {
      assert.equal(store.recall(user, "持久化")[0]?.id, item.id);
      assert.equal(store.history(user, item.id).length, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid status and missing future time are rejected", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (const item of [
    { kind: "future", content: "x" },
    { kind: "memory", content: "x", status: "pending" },
    { kind: "future", content: "x", followUpAt: "tomorrow" },
    { kind: "loop", content: "x", followUpAt: "2026-10-28T10:00:00" },
  ])
    assert.throws(() => store.save(user, item));
});

test("HTTP authentication, tenant boundaries, context, validation and update conflict", async (t) => {
  const store = new Store(":memory:");
  const server = createApp(store, key, undefined, { legacyAccess: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    Authorization: `Bearer ${key}`,
    "X-User-ID": user,
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/v1/loops")).status, 401);
  assert.equal(
    (
      await fetch(base + "/v1/loops", {
        headers: { Authorization: `Bearer ${key}` },
      })
    ).status,
    400,
  );
  const created = await fetch(base + "/v1/items", {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "future",
      content: "面试",
      followUpAt: "2020-01-01T00:00:00Z",
    }),
  });
  assert.equal(created.status, 201);
  const item = (await created.json()) as { id: string };
  const context = await fetch(base + "/v1/context", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "今天好累" }),
  });
  assert.equal(context.status, 200);
  const result = (await context.json()) as any;
  assert.equal(result.candidates.due[0].id, item.id);
  assert.equal(
    (
      await fetch(base + "/v1/items/" + item.id, {
        headers: { ...headers, "X-User-ID": "bob" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(base + "/v1/recall", {
        method: "POST",
        headers,
        body: "{bad",
      })
    ).status,
    400,
  );
  const input = {
    version: 1,
    item: { kind: "future", content: "面试", status: "completed" },
  };
  assert.equal(
    (
      await fetch(base + "/v1/items/" + item.id, {
        method: "PUT",
        headers,
        body: JSON.stringify(input),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(base + "/v1/items/" + item.id, {
        method: "PUT",
        headers,
        body: JSON.stringify(input),
      })
    ).status,
    409,
  );
  assert.equal(
    ((await fetch(base + "/v1/future/due", { headers }).then((r) => r.json())) as any)
      .items.length,
    0,
  );
});

test("Meilisearch outage preserves outbox and falls back to SQLite", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.save(user, { kind: "memory", content: "本地记忆可用" });
  const search = new MeiliSearch("http://127.0.0.1:1");
  await assert.rejects(() => search.sync(store));
  assert.equal(store.pending().length, 1);
  assert.equal((await search.recall(store, user, "本地记忆", 10)).length, 1);
});

test("Meilisearch async tasks sync records, reject foreign hits and preserve failed batches", async (t) => {
  const { createServer } = await import("node:http");
  const store = new Store(":memory:");
  const own = store.save(user, { kind: "memory", content: "我喜欢简单架构" });
  const foreign = store.save("bob", {
    kind: "memory",
    content: "Foreign secret",
  });
  let fail = false;
  let taskId = 0;
  let searches = 0;
  const batches: unknown[][] = [];
  const mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const data = raw ? JSON.parse(raw) : undefined;
    let output: unknown;
    if (req.url?.startsWith("/tasks/"))
      output = { status: fail ? "failed" : "succeeded" };
    else if (req.url?.endsWith("/search")) {
      searches++;
      assert.ok(data.filter[0].includes("alice"));
      output = { hits: [{ id: foreign.id }, { id: own.id }] };
    } else {
      if (Array.isArray(data)) batches.push(data);
      output = { taskUid: ++taskId };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(output));
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    store.close();
  });
  const address = mock.address();
  assert.ok(address && typeof address !== "string");
  const search = new MeiliSearch(`http://127.0.0.1:${address.port}`);
  await search.sync(store);
  assert.equal(store.pending().length, 0);
  assert.ok(batches.some((batch) => batch.length === 2));
  assert.deepEqual(
    (await search.recall(store, user, "架构", 10)).map((item) => item.id),
    [own.id],
  );
  assert.equal(searches, 1);
  store.save(user, { kind: "memory", content: "最新内容" }, { id: own.id, version: 1 });
  fail = true;
  await assert.rejects(() => search.sync(store));
  assert.equal(store.pending().length, 1);
  assert.equal((await search.recall(store, user, "最新内容", 10))[0]?.version, 2);
  fail = false;
  await search.sync(store);
  assert.equal(store.pending().length, 0);
});

test("malformed Meilisearch responses cannot acknowledge writes or replace SQLite truth", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const item = store.save(user, { kind: "memory", content: "可靠的记忆" });
  const search = new MeiliSearch("http://unused.invalid");
  search.request = async () => ({ taskUid: "invalid" });
  await assert.rejects(() => search.sync(store));
  assert.equal(store.pending().length, 1);
  store.acknowledge(store.pending());
  search.ready = true;
  search.lastError = null;
  search.request = async () => ({ hits: [{ id: 123 }] });
  assert.deepEqual(
    (await search.recall(store, user, "可靠的", 10)).map((value) => value.id),
    [item.id],
  );
});
