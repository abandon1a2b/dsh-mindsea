import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import LlmRuntime, {
  LlmAdapter,
  createMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import * as plugin from "../plugins/dsh-mindsea/src/index.ts";
import { Store } from "../src/storage/sqlite/store.ts";
import { createApp } from "../src/http/server.ts";

class LocalModel extends LlmAdapter {
  calls: GenerateOptions[] = [];
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    request.signal?.throwIfAborted();
    this.calls.push(request);
    let text = "收到，我会记得。";
    if (request.system?.includes("Maintain Mindsea L1")) {
      const block = request.messages[0]!.content[0]!;
      assert.equal(block.type, "text");
      if (block.type !== "text") throw new Error();
      const data = JSON.parse(block.text);
      const evidence = data.sourceEvidence.find(
        (e: { eventId: string }) => e.eventId === data.event.id,
      );
      text = JSON.stringify({
        extractorVersion: "runtime-fixture",
        invalidations: [],
        writes: [
          {
            key: "fact",
            record: {
              layer: "L1",
              kind: "fact",
              topic: "communication",
              content: "技术说明先给结论",
              basis: "explicit",
              evidence: [evidence],
            },
          },
          {
            key: "profile",
            record: {
              layer: "L3",
              kind: "preference",
              topic: "communication",
              content: "技术说明先给结论",
              basis: "explicit",
              evidence: [evidence],
              dependencies: [{ id: "$fact", version: 1 }],
              claim: { predicate: "response.order", value: "conclusion-first" },
            },
          },
        ],
      });
    } else if (request.system?.includes("Future/open-loop"))
      text = JSON.stringify({ updates: [], creates: [] });
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

test(
  "official DSH runtime loads the plugin, completes a turn and consolidates L3 independently",
  { timeout: 15000 },
  async (t) => {
    const store = new Store(":memory:");
    const key = "runtime-fixture-secret-at-least-24";
    const personal = store.access.create({
      personName: "Runtime owner",
      brainName: "Runtime brain",
    });
    const identity = store.access.authenticate(personal.token);
    const server = createApp(store, key);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const ctx = new Context();
    const old = process.env.MINDSEA_RUNTIME_TEST_KEY;
    process.env.MINDSEA_RUNTIME_TEST_KEY = personal.token;
    t.after(async () => {
      await ctx.fiber.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      if (old === undefined) delete process.env.MINDSEA_RUNTIME_TEST_KEY;
      else process.env.MINDSEA_RUNTIME_TEST_KEY = old;
    });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    await ctx.plugin(LlmRuntime);
    const model = new LocalModel();
    ctx.llm.registerAdapter(["local-fixture"], model);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    const installed = await ctx.plugin(plugin, {
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKeyEnv: "MINDSEA_RUNTIME_TEST_KEY",
      userId: personal.brainId,
      provider: "local-fixture",
      model: "fixture",
      timeZone: "Asia/Shanghai",
      enabled: true,
      audience: "private",
      sessionIds: ["mindsea-runtime-test"],
      hookBudgetMs: 1000,
      pollMs: 100,
    });
    const disabled = await ctx.agentLoop.create(SessionId("unrelated-session"), {
      provider: "local-fixture",
      model: "fixture",
    });
    disabled.followup(
      createMessage({
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "这段话不应该存进脑海" }],
      }),
    );
    await disabled.whenIdle();
    assert.equal(store.db.prepare("SELECT count(*) n FROM events").get()!.n, 0);
    assert.equal(model.calls.filter((call) => call.system).length, 0);
    assert.equal(
      model.calls
        .flatMap((call) => call.tools ?? [])
        .some((tool) => tool.name.startsWith("mindsea_")),
      false,
    );
    const agent = await ctx.agentLoop.create(SessionId("mindsea-runtime-test"), {
      provider: "local-fixture",
      model: "fixture",
    });
    agent.followup(
      createMessage({
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "以后技术问题先给结论" }],
      }),
    );
    await agent.whenIdle();
    const assistant = agent.session
      .snapshotEvents()
      .filter((event) => event.type === "assistant/message");
    assert.ok(assistant.length > 0);
    const until = Date.now() + 6000;
    while (
      Date.now() < until &&
      !store.memory.records.list(identity.namespace).some((r) => r.layer === "L3")
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      store.memory.retrieval.recall(identity.namespace, { intent: "preference" })
        .items[0]?.layer,
      "L3",
    );
    assert.ok(model.calls.some((call) => call.system?.includes("Maintain Mindsea L1")));
    assert.ok(model.calls.some((call) => !call.system));
    const calls = model.calls.length;
    await installed.dispose();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(model.calls.length, calls);
  },
);
