import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/sqlite/store.ts";
import { createApp } from "../src/http/server.ts";
import { MindseaClient } from "../src/client/index.ts";
import { resolveActivation } from "../plugins/dsh-mindsea/src/activation.ts";
import type { Config } from "../plugins/dsh-mindsea/src/config.ts";
import type { Session } from "@deepseek-ai/dsh-session";

test("scoped credentials isolate people and brains and reject forged headers, paused or revoked access", async (t) => {
  const store = new Store(":memory:");
  const admin = "admin-key-not-for-content-at-least-24";
  const alice = store.access.create({ personName: "Alice", brainName: "Private" });
  const work = store.access.create({
    personId: alice.personId,
    personName: "Alice",
    brainName: "Work",
  });
  const bob = store.access.create({ personName: "Bob", brainName: "Private" });
  const server = createApp(store, admin);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = (value: typeof alice) =>
    new MindseaClient({ baseUrl, apiKey: value.token, userId: value.brainId });
  await api(alice).bindSession("unique-session");
  await assert.rejects(() => api(work).bindSession("unique-session"));
  await assert.rejects(() => api(bob).bindSession("unique-session"));
  const item = await api(alice).remember({
    kind: "memory",
    content: "Alice private fact",
  });
  assert.equal((await api(work).recall("")).items.length, 0);
  assert.equal((await api(bob).recall("")).items.length, 0);
  await assert.rejects(() => api(bob).get(item.id));
  assert.equal(
    (
      await fetch(baseUrl + "/v1/me", {
        headers: { Authorization: `Bearer ${alice.token}`, "X-User-ID": bob.brainId },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(baseUrl + "/v1/items/" + item.id, {
        headers: { Authorization: `Bearer ${admin}`, "X-User-ID": alice.brainId },
      })
    ).status,
    401,
  );
  store.access.pause(alice.brainId, true);
  await assert.rejects(() => api(alice).recall(""));
  store.access.pause(alice.brainId, false);
  assert.equal((await api(alice).recall("")).items.length, 1);
  store.access.revoke(alice.credentialId);
  await assert.rejects(() => api(alice).recall(""));
});

test("activation defaults closed, matches canonical path boundaries and respects audience/session exclusions", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mindsea-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "chat");
  const child = join(workspace, "child");
  const sibling = join(root, "chat-private");
  mkdirSync(child, { recursive: true });
  mkdirSync(sibling);
  symlinkSync(sibling, join(workspace, "escape"));
  const session = (cwd: string) => ({ id: "s", header: { cwd } }) as unknown as Session;
  const config = {
    sessionIds: [],
    workspaces: [{ path: workspace, includeChildren: false }],
  } as unknown as Config;
  assert.equal(resolveActivation(config, session(workspace)).enabled, false);
  config.enabled = true;
  config.audience = "private";
  assert.equal(resolveActivation(config, session(workspace)).enabled, true);
  assert.equal(resolveActivation(config, session(child)).enabled, false);
  config.workspaces![0]!.includeChildren = true;
  assert.equal(resolveActivation(config, session(child)).enabled, true);
  assert.equal(resolveActivation(config, session(sibling)).enabled, false);
  assert.equal(
    resolveActivation(config, session(join(workspace, "escape"))).enabled,
    false,
  );
  config.audience = "group";
  assert.equal(resolveActivation(config, session(workspace)).enabled, false);
  config.activationFile = join(root, "activation.json");
  writeFileSync(
    config.activationFile,
    JSON.stringify({
      enabled: true,
      audience: "private",
      sessionIds: ["s"],
      disabledSessionIds: ["s"],
    }),
  );
  assert.equal(
    resolveActivation(config, session(workspace)).reason,
    "session-disabled",
  );
  writeFileSync(config.activationFile, "{bad");
  assert.equal(resolveActivation(config, session(workspace)).enabled, false);
});
