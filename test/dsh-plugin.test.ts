import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  createMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { Store } from "../src/storage/sqlite/store.ts";
import { createApp } from "../src/http/server.ts";
import { apply } from "../plugins/dsh-mindsea/src/index.ts";
import { makeDecider } from "../plugins/dsh-mindsea/src/model.ts";
import { futureText } from "../plugins/dsh-mindsea/src/future-context.ts";
import type { Config } from "../plugins/dsh-mindsea/src/config.ts";

const key = "mindsea-test-plugin-key-at-least-24-chars";
const defaults: Config = {
  legacyAccess: true,
  enabled: true,
  audience: "private",
  baseUrl: "",
  apiKeyEnv: "MINDSEA_TEST_PLUGIN_KEY",
  userId: "owner",
  provider: "mock",
  model: "mock-model",
  timeZone: "Asia/Shanghai",
  sessionIds: ["session-a"],
  hookBudgetMs: 1500,
  pollMs: 100,
};

async function harness(
  t: TestContext,
  decide: (request: GenerateOptions) => unknown = () => ({
    updates: [],
    creates: [],
  }),
) {
  const store = new Store(":memory:");
  const server = createApp(store, key, undefined, { legacyAccess: true });
  const requests: string[] = [];
  server.on("request", (req) => requests.push(req.url!));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const hooks = new Map<string, Function>();
  const tools = new Map<string, any>();
  const disposers: Function[] = [];
  const llmCalls: GenerateOptions[] = [];
  const ctx = {
    agents: { list: () => [] },
    on: (name: string, fn: Function) => {
      const previous = hooks.get(name);
      hooks.set(
        name,
        previous && name === "agent/pre-step"
          ? async (payload: unknown, next: Function) =>
              fn(payload, () => previous(payload, next))
          : previous && name === "agent/created"
            ? async (payload: unknown) => {
                await previous(payload);
                return fn(payload);
              }
            : fn,
      );
      return () => hooks.delete(name);
    },
    effect: (setup: () => Function) => {
      const dispose = setup();
      disposers.push(dispose);
      return dispose;
    },
    tools: {
      register: (tool: any) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    llm: {
      async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
        llmCalls.push(request);
        yield {
          type: "text-delta",
          index: 0,
          text: JSON.stringify(decide(request)),
        };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  } as unknown as Context;
  const config = { ...defaults, baseUrl: `http://127.0.0.1:${addr.port}` };
  const old = process.env.MINDSEA_TEST_PLUGIN_KEY;
  process.env.MINDSEA_TEST_PLUGIN_KEY = key;
  apply(ctx, config);
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    if (old === undefined) delete process.env.MINDSEA_TEST_PLUGIN_KEY;
    else process.env.MINDSEA_TEST_PLUGIN_KEY = old;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const agent = {
    id: "session-a",
    ctx,
    session: { id: "session-a", snapshotEvents: () => [] },
  } as unknown as Agent;
  const step = async (turn: number, content?: string) => {
    const messages = content
      ? [
          createMessage({
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: content }],
          }),
        ]
      : [];
    const decision = { kind: "enter" as const, messages: [...messages] };
    return hooks.get("agent/pre-step")!(
      {
        agent,
        messages,
        turn,
        step: turn,
        signal: new AbortController().signal,
      },
      async () => decision,
    );
  };
  return {
    store,
    requests,
    hooks,
    tools,
    llmCalls,
    agent,
    step,
    ctx,
    config,
    server,
  };
}

test("DSH checks every turn, empty is silent, and Memory is never retrieved by the hook", async (t) => {
  const h = await harness(t);
  const one = await h.step(1, "你好");
  assert.equal(one.messages.length, 1);
  const two = await h.step(2, "今天不错");
  assert.equal(two.messages.length, 1);
  assert.equal(h.requests.filter((path) => path === "/v1/future/check").length, 2);
  assert.equal(
    h.requests.filter((path) => path.includes("recall") || path === "/v1/context")
      .length,
    0,
  );
  await h.step(2); // Same conversation turn's internal tool step.
  assert.equal(h.requests.filter((path) => path === "/v1/future/check").length, 2);
  await h.step(2, "补充一下"); // New user steering is a new evidence boundary.
  assert.equal(h.requests.filter((path) => path === "/v1/future/check").length, 3);
});

test("ready Future is injected as attributed context, not ingested as user speech", async (t) => {
  const h = await harness(t);
  h.store.save("owner", {
    kind: "future",
    content: "面试之后问进展",
    followUpAt: "2020-01-01T00:00:00Z",
  });
  const result = await h.step(1, "今天好累");
  assert.equal(result.messages.length, 2);
  const injected = result.messages[1];
  assert.equal(injected.source.kind, "mindsea-future");
  assert.ok(injected.content[0].text.includes("面试之后问进展"));
  const before = h.store.db.prepare("SELECT count(*) n FROM events").get()!.n;
  h.hooks.get("session/event")!(h.agent.session, {
    type: "user/message",
    data: injected,
    time: Date.now(),
  });
  await h.step(2);
  assert.equal(h.store.db.prepare("SELECT count(*) n FROM events").get()!.n, before);
});

test("new cancellation updates Future before check, without any prior recall", async (t) => {
  let futureId = "";
  const h = await harness(t, (request) => {
    const block = request.messages[0]!.content[0]!;
    assert.equal(block.type, "text");
    if (block.type !== "text") throw new Error();
    const input = JSON.parse(block.text);
    if (input.event.content === "面试取消了")
      return {
        updates: [
          {
            id: futureId,
            version: 1,
            item: {
              kind: "future",
              content: "面试已取消",
              status: "cancelled",
            },
          },
        ],
        creates: [],
      };
    return { updates: [], creates: [] };
  });
  futureId = h.store.save("owner", {
    kind: "future",
    content: "远期面试",
    followUpAt: "2099-01-01T00:00:00Z",
  }).id;
  const result = await h.step(1, "面试取消了");
  assert.equal(h.store.get("owner", futureId).status, "cancelled");
  assert.equal(result.messages.length, 1);
  assert.ok(h.llmCalls.length > 0);
  assert.equal(
    h.requests.some((path) => path.includes("recall")),
    false,
  );
});

test("passive Memory tools retrieve only memory and write only when invoked", async (t) => {
  const h = await harness(t);
  await h.step(1, "hello");
  h.store.save("owner", { kind: "loop", content: "喜欢写游戏" });
  const statement = createMessage({
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: "我喜欢简洁回答" }],
  });
  h.agent.session.snapshotEvents = () => [
    { type: "user/message", data: statement, time: Date.now(), seq: 0 } as never,
  ];
  const tool = h.tools.get("mindsea_remember");
  await tool.execute(
    { content: "喜欢简洁回答" },
    { agent: h.agent, signal: new AbortController().signal },
  );
  const result = JSON.parse(
    await h.tools
      .get("mindsea_recall")
      .execute(
        { query: "喜欢" },
        { agent: h.agent, signal: new AbortController().signal },
      ),
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].layer, "L1");
  await assert.rejects(() =>
    tool.execute({ content: "x" }, { signal: new AbortController().signal }),
  );
});

test("service failure keeps normal chat flowing with no fabricated Future", async (t) => {
  const h = await harness(t);
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
  const oldWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await h.step(1, "继续聊");
    assert.equal(result.messages.length, 1);
  } finally {
    console.warn = oldWarn;
  }
});

test("maintenance refuses assistant-invented completion and incomplete model output", async (t) => {
  const h = await harness(t, () => ({
    updates: [],
    creates: [{ kind: "loop", content: "编造的计划" }],
  }));
  const input = {
    event: {
      id: "a",
      userId: "owner",
      sessionId: "s",
      role: "assistant" as const,
      content: "你已经完成面试",
      occurredAt: new Date().toISOString(),
    },
    recentEvents: [],
    agenda: [],
    agendaRevision: 0,
  };
  await assert.rejects(() => makeDecider(h.ctx, h.config)(input), /Assistant event/);
  const incomplete = {
    llm: {
      async *stream() {
        yield { type: "text-delta", text: '{"updates":[],"creates":[]}' };
        yield { type: "finish", reason: { kind: "max-tokens" } };
      },
    },
  } as unknown as Context;
  await assert.rejects(() => makeDecider(incomplete, h.config)(input), /incomplete/);
  assert.equal(futureText({ state: "pending", items: [], omitted: 0 }, 1), "");
  assert.equal(futureText({ state: "empty", items: [], omitted: 0 }, 1), "");
});
