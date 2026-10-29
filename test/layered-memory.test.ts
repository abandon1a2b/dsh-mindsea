import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Store } from "../src/storage/sqlite/store.ts";
import { atomic } from "../src/storage/sqlite/transaction.ts";
import {
  memoryInputSchema,
  type Evidence,
  type MemoryInput,
  type MemoryPlan,
} from "../src/contracts/memory.ts";
import { createApp } from "../src/http/server.ts";
import { MindseaClient } from "../src/client/index.ts";
import { processMemoryJob } from "../src/application/memory/process-job.ts";
const user = "alice";
const noChanges: MemoryPlan = {
  extractorVersion: "test",
  writes: [],
  invalidations: [],
};
function setup(t: TestContext) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  return store;
}
function record(
  store: Store,
  content = "以后技术问题先给结论",
  owner = user,
  occurredAt?: string,
) {
  return store.addEvent(owner, {
    id: randomUUID(),
    sessionId: "chat",
    role: "user",
    content,
    occurredAt,
  });
}
function input(
  layer: "L1" | "L2" | "L3",
  evidence: Evidence,
  deps: { id: string; version: number }[] = [],
  overrides: Record<string, unknown> = {},
): MemoryInput {
  return memoryInputSchema.parse({
    layer,
    kind: layer === "L1" ? "fact" : layer === "L2" ? "topic-summary" : "preference",
    content: layer === "L2" ? "技术交流偏好：先说结论" : "技术问题先给结论",
    topic: "technical-communication",
    subjectId: "self",
    scope: { kind: "global", key: "*" },
    basis: "explicit",
    status: "active",
    evidence: [evidence],
    dependencies: deps,
    ...(layer === "L3"
      ? { claim: { predicate: "response.order", value: "conclusion-first" } }
      : {}),
    ...overrides,
  });
}
function plan(evidence: Evidence): MemoryPlan {
  return {
    extractorVersion: "test-v1",
    invalidations: [],
    writes: [
      { key: "fact", record: input("L1", evidence) },
      { key: "topic", record: input("L2", evidence, [{ id: "$fact", version: 1 }]) },
      { key: "profile", record: input("L3", evidence, [{ id: "$topic", version: 1 }]) },
    ],
  };
}
function seed(store: Store) {
  const event = record(store);
  const evidence = store.memory.records.evidence(user, event.id);
  const job = store.memory.jobs.claim(user)!;
  const items = store.memory.jobs.commit(user, job.id, {
    token: job.token,
    revision: job.revision,
    plan: plan(evidence),
  });
  return { event, evidence, job, items };
}

test("L0 Unicode evidence spans are exact, role-bound and tenant-bound", (t) => {
  const store = setup(t);
  const event = record(store, "🙂先给结论");
  const records = store.memory.records;
  const evidence = records.evidence(user, event.id, 1, 3);
  assert.equal(evidence.start, 1);
  assert.equal(evidence.end, 3);
  assert.equal(records.validateEvidence(user, evidence).id, event.id);
  assert.throws(() => records.validateEvidence("bob", evidence), { status: 404 });
  assert.throws(() => records.validateEvidence(user, { ...evidence, end: 99 }), {
    status: 400,
  });
  assert.throws(
    () => records.validateEvidence(user, { ...evidence, contentHash: "0".repeat(64) }),
    { status: 400 },
  );
  const assistant = store.addEvent(user, {
    sessionId: "chat",
    role: "assistant",
    content: "用户是内向的",
  });
  assert.throws(() => records.evidence(user, assistant.id), { status: 400 });
  assert.equal(store.memory.jobs.list(user).length, 1);
  assert.ok(event.recordedAt);
  assert.equal(event.sourceKind, "human");
});

test("batch produces L1/L2/L3 with one root, exact versions and retry-safe receipt", (t) => {
  const store = setup(t);
  const { job, items, evidence } = seed(store);
  assert.deepEqual(
    items.map((r) => r.layer),
    ["L1", "L2", "L3"],
  );
  assert.equal(items[2]!.independentEvidenceCount, 1);
  assert.deepEqual(items[2]!.rootEventIds, [job.event.id]);
  assert.equal(items[2]!.dependencies[0]!.id, items[1]!.id);
  assert.equal(store.memory.jobs.watermark(user).pending, 0);
  assert.deepEqual(
    store.memory.jobs.commit(user, job.id, {
      token: job.token,
      revision: job.revision,
      plan: plan(evidence),
    }),
    items,
  );
  assert.equal(store.memory.records.list(user).length, 3);
  assert.throws(() => store.memory.records.get("bob", items[0]!.id), { status: 404 });
});

test("invalid later writes roll back earlier layers and checkpoint", (t) => {
  const store = setup(t);
  const event = record(store);
  const ev = store.memory.records.evidence(user, event.id);
  const job = store.memory.jobs.claim(user)!;
  const draft = plan(ev);
  draft.writes[2]!.record.evidence[0] = { ...ev, contentHash: "0".repeat(64) };
  assert.throws(
    () =>
      store.memory.jobs.commit(user, job.id, {
        token: job.token,
        revision: job.revision,
        plan: draft,
      }),
    { status: 400 },
  );
  assert.equal(store.memory.records.list(user).length, 0);
  assert.equal(store.memory.records.revision(user), 0);
  assert.equal(store.memory.jobs.watermark(user).pending, 1);
});

test("inferred profile stays candidate until a new human confirmation", (t) => {
  const store = setup(t);
  const { items, evidence, event } = seed(store);
  const candidate = atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L3", evidence, [{ id: items[0]!.id, version: 1 }], {
        basis: "inferred",
        claim: { predicate: "format", value: "short" },
      }),
      event.id,
      "test",
    ),
  );
  assert.equal(candidate.status, "candidate");
  assert.equal(
    store.memory.retrieval
      .recall(user, { query: "", intent: "preference" })
      .items.some((r) => r.id === candidate.id),
    false,
  );
  const confirmation = record(store, "对，我确实一直喜欢简短的格式");
  const confirmed = store.memory.lifecycle.act(user, {
    revision: store.memory.records.revision(user),
    target: { id: candidate.id, version: 1 },
    action: "confirm",
    evidence: store.memory.records.evidence(user, confirmation.id),
    reason: "用户确认该条偏好",
  });
  assert.equal(confirmed.status, "active");
  assert.equal(confirmed.version, 2);
  assert.ok(confirmed.evidence.some((e) => e.eventId === confirmation.id));
});

test("correcting L1 invalidates derived topic/profile in the same transaction", (t) => {
  const store = setup(t);
  const { items } = seed(store);
  const correction = record(store, "以前的先给结论偏好不适用了");
  const ev = store.memory.records.evidence(user, correction.id);
  const job = store.memory.jobs.claim(user)!;
  store.memory.jobs.commit(user, job.id, {
    token: job.token,
    revision: job.revision,
    plan: {
      ...noChanges,
      invalidations: [
        {
          target: { id: items[0]!.id, version: 1 },
          status: "superseded",
          evidence: ev,
          reason: "明确纠正",
        },
      ],
    },
  });
  assert.deepEqual(
    items.map((r) => store.memory.records.get(user, r.id).status),
    ["superseded", "disputed", "disputed"],
  );
  assert.equal(store.memory.retrieval.recall(user, { query: "技术" }).items.length, 0);
  assert.equal(store.memory.records.history(user, items[2]!.id).length, 2);
});

test("scope exceptions preserve general profiles, conflicting same-scope claims become disputed", (t) => {
  const store = setup(t);
  const { items } = seed(store);
  const event = record(store, "设计评审先讲完整推导");
  const ev = store.memory.records.evidence(user, event.id);
  const fact = atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L1", ev, [], { content: "设计评审详细", topic: "design-review" }),
      event.id,
      "test",
    ),
  );
  const specific = atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L3", ev, [{ id: fact.id, version: 1 }], {
        content: "评审先给推导",
        scope: { kind: "topic", key: "design-review" },
        claim: { predicate: "response.order", value: "derivation-first" },
      }),
      event.id,
      "test",
    ),
  );
  assert.equal(store.memory.records.get(user, items[2]!.id).status, "active");
  assert.equal(
    store.memory.retrieval.recall(user, {
      intent: "preference",
      scope: { kind: "topic", key: "design-review" },
    }).items[0]!.id,
    specific.id,
  );
  const conflict = atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L3", ev, [{ id: fact.id, version: 1 }], {
        claim: { predicate: "response.order", value: "derivation-first" },
      }),
      event.id,
      "test",
    ),
  );
  assert.equal(conflict.status, "disputed");
  assert.equal(store.memory.records.get(user, items[2]!.id).status, "disputed");
});

test("job leases expire, failed jobs are observable/retryable, Future remains independent", (t) => {
  const store = setup(t);
  const first = record(store);
  const second = record(store, "另一件独立的事");
  const job = store.memory.jobs.claim(user)!;
  assert.equal(store.memory.jobs.claim(user), null);
  store.db
    .prepare(
      "UPDATE memory_jobs SET lease_until='2000-01-01T00:00:00.000Z',attempts=3 WHERE id=?",
    )
    .run(job.id);
  const next = store.memory.jobs.claim(user)!;
  assert.equal(next.event.id, second.id);
  assert.equal(store.memory.jobs.watermark(user).failed, 1);
  assert.throws(
    () =>
      store.memory.jobs.commit(user, job.id, {
        token: job.token,
        revision: job.revision,
        plan: noChanges,
      }),
    { status: 409 },
  );
  store.memory.jobs.commit(user, next.id, {
    token: next.token,
    revision: next.revision,
    plan: noChanges,
  });
  store.memory.jobs.retry(user, job.id);
  assert.equal(store.memory.jobs.claim(user)!.event.id, first.id);
  assert.equal(store.nextReconciliation(user)!.event.id, first.id);
  store.reconcile(user, first.id, {
    agendaRevision: store.agendaRevision(user),
    updates: [],
    creates: [],
  });
  assert.equal(store.nextReconciliation(user)!.event.id, second.id);
});

test("stale no-op model result cannot advance memory checkpoint", (t) => {
  const store = setup(t);
  const event = record(store);
  const job = store.memory.jobs.claim(user)!;
  atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L1", store.memory.records.evidence(user, event.id)),
      event.id,
      "manual",
    ),
  );
  assert.throws(
    () =>
      store.memory.jobs.commit(user, job.id, {
        token: job.token,
        revision: job.revision,
        plan: noChanges,
      }),
    { status: 409 },
  );
  assert.equal(store.memory.jobs.watermark(user).pending, 1);
});

test("old imported corrections cannot replace newer evidence", (t) => {
  const store = setup(t);
  const newer = record(store, "新偏好", user, "2026-10-28T10:00:00Z");
  const ev = store.memory.records.evidence(user, newer.id);
  const current = atomic(store.db, () =>
    store.memory.records.save(user, input("L1", ev), newer.id, "test"),
  );
  const older = record(store, "旧偏好", user, "2020-01-01T00:00:00Z");
  assert.throws(
    () =>
      store.memory.lifecycle.act(user, {
        revision: store.memory.records.revision(user),
        target: { id: current.id, version: 1 },
        action: "retract",
        evidence: store.memory.records.evidence(user, older.id),
        reason: "old",
      }),
    { status: 409 },
  );
});

test("forget erases evidence, derived history, legacy/Future copies and blocks replay", (t) => {
  const store = setup(t);
  const { items, event } = seed(store);
  const future = store.save(user, {
    kind: "future",
    content: event.content,
    followUpAt: "2099-01-01T00:00:00Z",
    sourceEventId: event.id,
  });
  const result = store.memory.lifecycle.forget(user, { eventIds: [event.id] });
  assert.equal(result.affectedMemories, 3);
  assert.throws(() => store.event(user, event.id), { status: 404 });
  assert.equal(store.memory.records.get(user, items[2]!.id).content, "[forgotten]");
  assert.equal(store.get(user, future.id).content, "[forgotten]");
  for (const table of [
    "events",
    "memory_records",
    "memory_revisions",
    "memory_evidence",
    "revisions",
    "items",
  ]) {
    const rows = store.db.prepare(`SELECT * FROM ${table}`).all();
    assert.equal(JSON.stringify(rows).includes(event.content), false, table);
  }
  assert.throws(
    () =>
      store.addEvent(user, {
        id: event.id,
        sessionId: event.sessionId,
        role: "user",
        content: event.content,
      }),
    { status: 410 },
  );
  assert.throws(() => record(store, event.content), { status: 410 });
  assert.equal(
    store.memory.retrieval.recall(user, { query: "", includeInactive: true }).items
      .length,
    0,
  );
  assert.equal(store.memory.jobs.rebuild(user), 0);
});

test("memory queries prioritize profile, return original quotes, respect budgets and validity", (t) => {
  const store = setup(t);
  const { items, event } = seed(store);
  const result = store.memory.retrieval.recall(user, {
    query: "技术",
    intent: "preference",
  });
  assert.equal(result.items[0]!.layer, "L3");
  assert.ok(result.items.length < 3);
  assert.equal(
    store.memory.retrieval.recall(user, { query: "技术", maxChars: 100 }).items.length,
    0,
  );
  assert.equal(
    store.memory.retrieval.recall(user, { query: "以后", intent: "exact-quote" })
      .quotes[0]!.content,
    event.content,
  );
  const ev = store.memory.records.evidence(user, event.id);
  atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L1", ev, [], { content: "过期的记忆", validTo: "2020-01-01T00:00:00Z" }),
      event.id,
      "test",
    ),
  );
  assert.equal(store.memory.retrieval.recall(user, { query: "过期" }).items.length, 0);
  assert.equal(
    store.memory.retrieval.recall(user, { query: "过期", includeInactive: true }).items
      .length,
    1,
  );
  assert.equal(store.memory.records.get(user, items[0]!.id).layer, "L1");
});

test("database restart retains layered records and unfinished leases", () => {
  const dir = mkdtempSync(join(tmpdir(), "mindsea-l3-"));
  try {
    let store = new Store(join(dir, "memory.sqlite"));
    const { items } = seed(store);
    record(store, "尚未整理");
    const pending = store.memory.jobs.claim(user)!;
    store.close();
    store = new Store(join(dir, "memory.sqlite"));
    try {
      assert.equal(store.memory.records.get(user, items[2]!.id).layer, "L3");
      assert.equal(store.memory.jobs.claim(user), null);
      store.db
        .prepare(
          "UPDATE memory_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?",
        )
        .run(pending.id);
      assert.equal(store.memory.jobs.claim(user)!.event.id, pending.event.id);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP memory worker performs complete L0-L3 cycle with evidence and tenant isolation", async (t) => {
  const store = new Store(":memory:");
  const key = "layered-memory-test-long-enough-key";
  const server = createApp(store, key, undefined, { legacyAccess: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: key,
    userId: user,
  };
  const client = new MindseaClient(options);
  const event = await client.record({
    sessionId: "s",
    role: "user",
    content: "以后技术问题先给结论",
  });
  assert.equal(
    await processMemoryJob(client, async (job) =>
      plan(job.sourceEvidence.find((e) => e.eventId === event.id)!),
    ),
    true,
  );
  const result = await client.memoryQuery({ query: "技术", intent: "preference" });
  assert.equal(result.items[0]!.layer, "L3");
  await assert.rejects(() =>
    new MindseaClient({ ...options, userId: "bob" }).memoryHistory(result.items[0]!.id),
  );
  assert.equal(await processMemoryJob(client, async () => noChanges), false);
  await client.forgetEvents([event.id]);
  assert.equal((await client.memoryQuery({ query: "技术" })).items.length, 0);
});

test("retraction and supersession prevent rebuild from reactivating withdrawn source", (t) => {
  const store = setup(t);
  const { event, items, evidence } = seed(store);
  const correction = record(store, "撤回我之前的偏好");
  store.memory.lifecycle.act(user, {
    revision: store.memory.records.revision(user),
    target: { id: items[0]!.id, version: 1 },
    action: "retract",
    evidence: store.memory.records.evidence(user, correction.id),
    reason: "用户撤回",
  });
  assert.throws(
    () =>
      atomic(store.db, () =>
        store.memory.records.save(user, input("L1", evidence), event.id, "rebuild"),
      ),
    { status: 409 },
  );
  store.memory.jobs.rebuild(user);
  const queued = store.memory.jobs.list(user);
  assert.equal(queued.filter((job) => job.eventId === event.id).length, 1);
});

test("re-extraction is deduplicated and repeated source text is not independent evidence", (t) => {
  const store = setup(t);
  const { event, evidence, items } = seed(store);
  const duplicate = atomic(store.db, () =>
    store.memory.records.save(user, input("L1", evidence), event.id, "rebuild"),
  );
  assert.equal(duplicate.id, items[0]!.id);
  const copied = record(store, event.content);
  const copiedEvidence = store.memory.records.evidence(user, copied.id);
  const withDuplicate = atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L1", copiedEvidence, [], {
        content: "多个来源的同一偏好",
        evidence: [evidence, copiedEvidence],
      }),
      copied.id,
      "test",
    ),
  );
  assert.equal(withDuplicate.rootEventIds.length, 2);
  assert.equal(withDuplicate.independentEvidenceCount, 1);
});

test("L3 cannot depend on candidates, foreign users, cycles, or stale lower versions", (t) => {
  const store = setup(t);
  const { event, evidence, items } = seed(store);
  const invalid = input("L3", evidence, [{ id: items[2]!.id, version: 1 }]);
  assert.throws(
    () =>
      atomic(store.db, () =>
        store.memory.records.save(user, invalid, event.id, "test"),
      ),
    { status: 400 },
  );
  const foreign = record(store, "其他用户的事实", "bob");
  const foreignFact = atomic(store.db, () =>
    store.memory.records.save(
      "bob",
      input("L1", store.memory.records.evidence("bob", foreign.id)),
      foreign.id,
      "test",
    ),
  );
  assert.throws(
    () =>
      atomic(store.db, () =>
        store.memory.records.save(
          user,
          input("L3", evidence, [{ id: foreignFact.id, version: 1 }]),
          event.id,
          "test",
        ),
      ),
    { status: 404 },
  );
  assert.throws(
    () =>
      atomic(store.db, () =>
        store.memory.records.save(
          user,
          input("L3", evidence, [{ id: items[0]!.id, version: 99 }]),
          event.id,
          "test",
        ),
      ),
    { status: 409 },
  );
});

test("raw whitespace is preserved and scoped evidence cannot become a global profile", (t) => {
  const store = setup(t);
  const event = record(store, "  🙂设计评审请详细说\n");
  assert.equal(event.content, "  🙂设计评审请详细说\n");
  const ev = store.memory.records.evidence(user, event.id);
  assert.equal(ev.end, [...event.content].length);
  const fact = atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L1", ev, [], { scope: { kind: "topic", key: "design-review" } }),
      event.id,
      "test",
    ),
  );
  assert.throws(
    () =>
      atomic(store.db, () =>
        store.memory.records.save(
          user,
          input("L3", ev, [{ id: fact.id, version: 1 }]),
          event.id,
          "test",
        ),
      ),
    { status: 400 },
  );
  const scoped = atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L3", ev, [{ id: fact.id, version: 1 }], {
        scope: { kind: "topic", key: "design-review" },
      }),
      event.id,
      "test",
    ),
  );
  assert.equal(scoped.status, "active");
});

test("inferred profiles cannot fabricate confirmation during initial creation", (t) => {
  const store = setup(t);
  const { event, evidence, items } = seed(store);
  assert.throws(
    () =>
      atomic(store.db, () =>
        store.memory.records.save(
          user,
          input("L3", evidence, [{ id: items[0]!.id, version: 1 }], {
            basis: "inferred",
            confirmation: evidence,
          }),
          event.id,
          "test",
        ),
      ),
    { status: 400 },
  );
});

test("topic aliases canonicalize new writes and reject cross-user or ambiguous bindings", (t) => {
  const store = setup(t);
  const { event, evidence } = seed(store);
  store.memory.topics.alias(user, {
    topic: "technical-communication",
    alias: "技术沟通",
  });
  const saved = atomic(store.db, () =>
    store.memory.records.save(
      user,
      input("L1", evidence, [], {
        topic: "技术沟通",
        content: "另一条明确的技术沟通事实",
      }),
      event.id,
      "test",
    ),
  );
  assert.equal(saved.topic, "technical-communication");
  assert.deepEqual(store.memory.topics.list(user)[0]!.aliases, ["技术沟通"]);
  assert.throws(
    () =>
      store.memory.topics.alias("bob", {
        topic: "technical-communication",
        alias: "技术沟通",
      }),
    { status: 404 },
  );
});

test("history returns past recorded versions while exact quotes filter time before limit", async (t) => {
  const store = setup(t);
  const { items, event } = seed(store);
  const before = items[0]!.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const later = record(store, "技术偏好更新", user, "2099-01-01T00:00:00Z");
  store.memory.lifecycle.act(user, {
    revision: store.memory.records.revision(user),
    target: { id: items[0]!.id, version: 1 },
    action: "dispute",
    evidence: store.memory.records.evidence(user, later.id),
    reason: "有新证据",
  });
  assert.equal(
    store.memory.retrieval.recall(user, {
      query: "技术",
      asOf: before,
      intent: "history",
    }).items[0]!.status,
    "active",
  );
  assert.equal(
    store.memory.retrieval.recall(user, {
      query: "技术",
      intent: "exact-quote",
      asOf: "2090-01-01T00:00:00Z",
      limit: 1,
    }).quotes[0]!.id,
    event.id,
  );
});

test("oversized memory snapshots fail observably without consuming evidence or blocking Future", (t) => {
  const store = setup(t);
  const { items } = seed(store);
  const insert = store.db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?)");
  atomic(store.db, () => {
    for (let index = 0; index < 2001; index++) {
      const value = { ...items[0]!, id: `capacity-${index}` };
      insert.run(
        value.id,
        user,
        value.layer,
        value.status,
        value.topic,
        value.content,
        value.version,
        JSON.stringify(value),
      );
    }
  });
  const event = record(store, "超过快照预算时保留任务");
  assert.equal(store.memory.jobs.claim(user), null);
  assert.equal(store.memory.jobs.watermark(user).failed, 1);
  assert.equal(store.memory.records.event(user, event.id).content, event.content);
  assert.equal(store.memory.jobs.list(user)[0]!.status, "failed");
  assert.ok(store.nextReconciliation(user));
});
