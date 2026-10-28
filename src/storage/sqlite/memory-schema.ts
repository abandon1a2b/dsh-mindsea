import type { DatabaseSync } from "node:sqlite";

/** Called inside the schema migration transaction. */
export function migrateMemory(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_tombstones(user_id TEXT NOT NULL,event_id TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(user_id,event_id));
    CREATE INDEX IF NOT EXISTS tombstone_content ON event_tombstones(user_id,content_hash);
    CREATE TABLE IF NOT EXISTS memory_revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,user_id TEXT NOT NULL,version INTEGER NOT NULL,document TEXT NOT NULL,UNIQUE(id,version));
    CREATE TABLE IF NOT EXISTS memory_records(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,layer TEXT NOT NULL,status TEXT NOT NULL,topic TEXT NOT NULL,content TEXT NOT NULL,version INTEGER NOT NULL,document TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memories_user ON memory_records(user_id,layer,status,topic);
    CREATE TABLE IF NOT EXISTS memory_dependencies(id TEXT NOT NULL,source_id TEXT NOT NULL,source_version INTEGER NOT NULL,PRIMARY KEY(id,source_id));
    CREATE INDEX IF NOT EXISTS memory_dependents ON memory_dependencies(source_id);
    CREATE TABLE IF NOT EXISTS memory_evidence(id TEXT NOT NULL,event_id TEXT NOT NULL,relation TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(id,event_id,document));
    CREATE INDEX IF NOT EXISTS memory_root ON memory_evidence(event_id);
    CREATE TABLE IF NOT EXISTS memory_topics(user_id TEXT NOT NULL,topic TEXT NOT NULL,PRIMARY KEY(user_id,topic));
    CREATE TABLE IF NOT EXISTS memory_topic_aliases(user_id TEXT NOT NULL,alias TEXT NOT NULL,topic TEXT NOT NULL,PRIMARY KEY(user_id,alias));
    CREATE TABLE IF NOT EXISTS memory_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,event_id TEXT NOT NULL,policy TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,token TEXT,lease_until TEXT,available_at TEXT NOT NULL DEFAULT '',error TEXT,result TEXT,UNIQUE(user_id,event_id,policy));
    CREATE INDEX IF NOT EXISTS memory_job_pending ON memory_jobs(user_id,status,available_at,id);
    CREATE TABLE IF NOT EXISTS memory_outbox(id TEXT PRIMARY KEY,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_blocked_sources(user_id TEXT NOT NULL,event_id TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(user_id,event_id));
    CREATE TABLE IF NOT EXISTS memory_user_revision(user_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED,user_id UNINDEXED,content,tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memory_records BEGIN INSERT INTO memory_search VALUES(new.id,new.user_id,new.content); END;
    CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE ON memory_records BEGIN DELETE FROM memory_search WHERE id=old.id;INSERT INTO memory_search VALUES(new.id,new.user_id,new.content); END;
    CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memory_records BEGIN DELETE FROM memory_search WHERE id=old.id; END;
    UPDATE events SET document=json_set(document,'$.recordedAt',json_extract(document,'$.occurredAt'),'$.producer','legacy','$.sourceKind',CASE json_extract(document,'$.role') WHEN 'user' THEN 'human' WHEN 'assistant' THEN 'assistant' ELSE 'tool' END) WHERE json_extract(document,'$.recordedAt') IS NULL;
  `);
}
