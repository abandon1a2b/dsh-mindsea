import type { DatabaseSync } from "node:sqlite";
export function atomic<T>(db: DatabaseSync, run: () => T): T {
  db.exec("SAVEPOINT memory_operation");
  try {
    const result = run();
    db.exec("RELEASE memory_operation");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO memory_operation");
    db.exec("RELEASE memory_operation");
    throw error;
  }
}
