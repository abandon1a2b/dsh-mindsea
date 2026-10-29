import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../contracts/common.ts";
import { atomic } from "./transaction.ts";

const name = z.string().trim().min(1).max(100);
export interface AccessIdentity {
  personId: string;
  brainId: string;
  namespace: string;
  credentialId: string;
}
export class AccessStore {
  db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  create(input: unknown) {
    const data = z
      .object({
        personName: name,
        brainName: name,
        personId: z.string().uuid().optional(),
      })
      .strict()
      .parse(input);
    return atomic(this.db, () => {
      const personId = data.personId ?? randomUUID();
      if (
        data.personId &&
        !this.db.prepare("SELECT 1 FROM persons WHERE id=?").get(personId)
      )
        throw new AppError(404, "Person not found");
      if (!data.personId)
        this.db
          .prepare("INSERT INTO persons VALUES(?,?)")
          .run(personId, data.personName);
      const brainId = randomUUID();
      const namespace = `brain:${brainId}`;
      this.db
        .prepare("INSERT INTO brains VALUES(?,?,?,?,0)")
        .run(brainId, personId, data.brainName, namespace);
      return { ...this.issue(personId, brainId), personId, brainId };
    });
  }
  issue(personId: string, brainId: string) {
    const token = randomBytes(32).toString("hex");
    const credentialId = randomUUID();
    this.db
      .prepare("INSERT INTO brain_credentials VALUES(?,?,?,?,0)")
      .run(
        credentialId,
        personId,
        brainId,
        createHash("sha256").update(token).digest("hex"),
      );
    return { token, credentialId };
  }
  authenticate(token: string): AccessIdentity {
    const row = this.db
      .prepare(
        `SELECT c.id credentialId,c.person_id personId,c.brain_id brainId,b.namespace FROM brain_credentials c JOIN brains b ON b.id=c.brain_id AND b.person_id=c.person_id WHERE c.token_hash=? AND c.revoked=0 AND b.paused=0`,
      )
      .get(createHash("sha256").update(token).digest("hex"));
    if (!row)
      throw new AppError(401, "Credential revoked, brain paused or unauthorized");
    return row as unknown as AccessIdentity;
  }
  bind(identity: AccessIdentity, sessionId: string) {
    const id = z.string().min(1).max(200).parse(sessionId);
    return atomic(this.db, () => {
      const old = this.db
        .prepare("SELECT namespace FROM brain_sessions WHERE session_id=?")
        .get(id);
      if (old && old.namespace !== identity.namespace)
        throw new AppError(
          409,
          "Session already belongs to a different brain; start a new session",
        );
      this.db
        .prepare("INSERT OR IGNORE INTO brain_sessions VALUES(?,?)")
        .run(id, identity.namespace);
      return { brainId: identity.brainId, sessionId: id };
    });
  }
  list() {
    return this.db
      .prepare(
        "SELECT b.id brainId,b.person_id personId,p.name personName,b.name brainName,b.paused FROM brains b JOIN persons p ON p.id=b.person_id ORDER BY p.name,b.name",
      )
      .all();
  }
  pause(id: string, paused: boolean) {
    if (
      !this.db.prepare("UPDATE brains SET paused=? WHERE id=?").run(Number(paused), id)
        .changes
    )
      throw new AppError(404, "Brain not found");
  }
  revoke(id: string) {
    if (
      !this.db.prepare("UPDATE brain_credentials SET revoked=1 WHERE id=?").run(id)
        .changes
    )
      throw new AppError(404, "Credential not found");
  }
}
export function accessSchema(db: DatabaseSync) {
  db.exec(`
 CREATE TABLE IF NOT EXISTS persons(id TEXT PRIMARY KEY,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS brains(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES persons(id),name TEXT NOT NULL,namespace TEXT NOT NULL UNIQUE,paused INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS brain_sessions(session_id TEXT PRIMARY KEY,namespace TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS brain_credentials(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES persons(id),brain_id TEXT NOT NULL REFERENCES brains(id),token_hash TEXT NOT NULL UNIQUE,revoked INTEGER NOT NULL DEFAULT 0);
`);
}
