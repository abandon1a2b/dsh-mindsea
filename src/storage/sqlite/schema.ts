import { migrateMemory } from "./memory-schema.ts";
import type { DatabaseSync } from "node:sqlite";

export function initializeSchema(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()!.user_version as number;
  if (version > 3) {
    throw new Error("Database schema is newer than this server");
  }
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,content TEXT NOT NULL,follow_up_at TEXT,updated_at TEXT NOT NULL,version INTEGER NOT NULL,document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS item_user ON items(user_id,kind,status);
      CREATE INDEX IF NOT EXISTS item_due ON items(user_id,status,follow_up_at);
      CREATE TABLE IF NOT EXISTS revisions(item_id TEXT NOT NULL,version INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(item_id,version));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,version INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED,user_id UNINDEXED,content,tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS items_insert AFTER INSERT ON items BEGIN INSERT INTO search VALUES(new.id,new.user_id,new.content); END;
      CREATE TRIGGER IF NOT EXISTS items_update AFTER UPDATE ON items BEGIN DELETE FROM search WHERE id=old.id; INSERT INTO search VALUES(new.id,new.user_id,new.content); END;
      CREATE TABLE IF NOT EXISTS reconciliation_jobs(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
        user_id TEXT NOT NULL,
        result TEXT
      );
      CREATE INDEX IF NOT EXISTS reconcile_pending ON reconciliation_jobs(user_id,result,seq);

    `);
    migrateMemory(db);
    db.exec("PRAGMA user_version=3");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
