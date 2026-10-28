import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Store } from "./storage/sqlite/store.ts";
import { MeiliSearch } from "./search/meilisearch.ts";
import { createApp } from "./http/server.ts";

const key = process.env.MINDSEA_API_KEY ?? "";
if (key.length < 24)
  throw new Error("Set MINDSEA_API_KEY to a random secret of at least 24 characters");
const database = resolve(process.env.MINDSEA_DB ?? "data/mindsea.sqlite");
mkdirSync(dirname(database), { recursive: true, mode: 0o700 });
const store = new Store(database);
const search = process.env.MEILI_URL
  ? new MeiliSearch(
      process.env.MEILI_URL,
      process.env.MEILI_API_KEY,
      process.env.MEILI_INDEX,
    )
  : undefined;
const server = createApp(store, key, search);
const host = process.env.MINDSEA_HOST ?? "127.0.0.1";
const port = Number(process.env.MINDSEA_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid MINDSEA_PORT");
let stopped = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let indexing: Promise<void> | undefined;
async function sync() {
  if (stopped || !search) return;
  indexing = search
    .sync(store)
    .catch((error) => console.error("Search sync deferred:", error.message));
  await indexing;
  if (!stopped) timer = setTimeout(() => void sync(), 2000);
}
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => {
  console.log(`Mindsea listening on http://${host}:${port}`);
  void sync();
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
  void shutdown();
});
async function shutdown() {
  if (stopped) return;
  stopped = true;
  if (timer) clearTimeout(timer);
  const force = setTimeout(() => process.exit(1), 40_000);
  force.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await indexing;
  store.close();
  clearTimeout(force);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
