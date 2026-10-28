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
  assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 2);
});
