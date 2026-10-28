import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../../contracts/common.ts";
import { z } from "zod";
import { atomic } from "./transaction.ts";

const topicName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((value) => value.normalize("NFC").toLocaleLowerCase());
export function resolveTopic(db: DatabaseSync, user: string, input: string): string {
  const name = topicName.parse(input);
  return (
    (db
      .prepare("SELECT topic FROM memory_topic_aliases WHERE user_id=? AND alias=?")
      .get(user, name)?.topic as string | undefined) ?? name
  );
}
export class MemoryTopics {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  list(user: string) {
    return this.db
      .prepare("SELECT topic FROM memory_topics WHERE user_id=? ORDER BY topic")
      .all(user)
      .map((row) => ({
        topic: row.topic as string,
        aliases: this.db
          .prepare(
            "SELECT alias FROM memory_topic_aliases WHERE user_id=? AND topic=? ORDER BY alias",
          )
          .all(user, row.topic!)
          .map((r) => r.alias as string),
      }));
  }
  alias(user: string, input: unknown) {
    const data = z.object({ topic: topicName, alias: topicName }).strict().parse(input);
    return atomic(this.db, () => {
      if (
        !this.db
          .prepare("SELECT 1 FROM memory_topics WHERE user_id=? AND topic=?")
          .get(user, data.topic)
      )
        throw new AppError(404, "Canonical topic not found");
      if (data.alias === data.topic) return data;
      if (
        this.db
          .prepare("SELECT 1 FROM memory_topics WHERE user_id=? AND topic=?")
          .get(user, data.alias)
      )
        throw new AppError(409, "Alias already names a canonical topic");
      const existing = this.db
        .prepare("SELECT topic FROM memory_topic_aliases WHERE user_id=? AND alias=?")
        .get(user, data.alias);
      if (existing && existing.topic !== data.topic)
        throw new AppError(409, "Alias already bound");
      this.db
        .prepare("INSERT OR IGNORE INTO memory_topic_aliases VALUES(?,?,?)")
        .run(user, data.alias, data.topic);
      this.db
        .prepare(
          "INSERT INTO memory_user_revision VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET revision=revision+1",
        )
        .run(user);
      return data;
    });
  }
}
