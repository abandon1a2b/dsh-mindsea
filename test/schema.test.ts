import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeSchema } from "../src/storage/sqlite/schema.ts";

test("failed schema upgrade rolls back DDL and does not advance its version", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE reconciliation_jobs(incompatible TEXT); PRAGMA user_version=1");
  assert.throws(() => initializeSchema(db));
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='events'").get(),
    undefined,
  );
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE name='reconciliation_jobs'").get(),
  );
  db.exec("DROP TABLE reconciliation_jobs");
  initializeSchema(db);
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 3);
});

test("schema v2 upgrades events without fabricating verified L3 or replaying old jobs", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    `CREATE TABLE events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,document TEXT NOT NULL); PRAGMA user_version=2;`,
  );
  db.prepare("INSERT INTO events VALUES(?,?,?)").run(
    "legacy",
    "alice",
    JSON.stringify({
      id: "legacy",
      userId: "alice",
      sessionId: "s",
      role: "user",
      content: "旧的原始记录",
      occurredAt: "2020-01-01T00:00:00Z",
    }),
  );
  initializeSchema(db);
  const event = JSON.parse(
    db.prepare("SELECT document FROM events").get()!.document as string,
  );
  assert.equal(event.sourceKind, "human");
  assert.equal(event.producer, "legacy");
  assert.equal(event.content, "旧的原始记录");
  assert.equal(db.prepare("SELECT count(*) n FROM memory_jobs").get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM memory_records").get()!.n, 0);
  initializeSchema(db);
  assert.equal(db.prepare("SELECT count(*) n FROM events").get()!.n, 1);
});
