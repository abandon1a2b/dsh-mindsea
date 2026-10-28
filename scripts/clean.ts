import { rmSync } from "node:fs";
import { resolve } from "node:path";

// Only generated outputs. Resolve from this file so cwd cannot change the target.
const root = resolve(import.meta.dirname, "..");
for (const target of ["dist", "plugins/dsh-mindsea/lib"]) {
  rmSync(resolve(root, target), { recursive: true, force: true });
}
