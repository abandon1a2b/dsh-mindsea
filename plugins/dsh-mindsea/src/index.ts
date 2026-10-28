import type { Context } from "@deepseek-ai/cordis";
import { MindseaClient } from "../../../src/client/index.ts";
import type { Config } from "./config.ts";
import { createEventBuffer } from "./event-buffer.ts";
import { createMaintenance } from "./maintenance.ts";
import { registerFutureHook } from "./future-hook.ts";
import { registerMemoryTools } from "./memory-tools.ts";
import { makeDecider } from "./model.ts";

// DSH loader entry: all runtime logic belongs to the feature modules below.
export { Config } from "./config.ts";
export const name = "mindsea";
export const inject = ["agents", "llm", "tools"];
export function apply(ctx: Context, config: Config) {
  const key = process.env[config.apiKeyEnv];
  if (!key || key.length < 24)
    throw new Error(`Set ${config.apiKeyEnv} before starting DSH`);
  if (!config.userId.trim()) throw new Error("Mindsea userId is required");
  new Intl.DateTimeFormat("en", { timeZone: config.timeZone });
  const lifetime = new AbortController();
  const clientFor = (signal: AbortSignal, timeoutMs = 5000) =>
    new MindseaClient({
      baseUrl: config.baseUrl,
      apiKey: key,
      userId: config.userId,
      signal: AbortSignal.any([lifetime.signal, signal]),
      timeoutMs,
    });
  const client = clientFor(lifetime.signal);
  const enabled = (id: string) =>
    !config.sessionIds.length || config.sessionIds.includes(id);
  const warn = () =>
    console.warn("[mindsea] Maintenance/service unavailable; pending work retained.");
  const buffer = createEventBuffer(client, enabled);
  const maintenance = createMaintenance(
    client,
    makeDecider(ctx, config),
    buffer,
    lifetime.signal,
    warn,
  );
  const offEvent = ctx.on("session/event", (session, event) => {
    buffer.capture(session, event);
    void maintenance.pump();
  });
  const offCreated = ctx.on("agent/created", ({ agent }) => {
    buffer.replay(agent.session);
    void maintenance.pump();
  });
  const offStep = registerFutureHook(
    ctx,
    config,
    enabled,
    buffer,
    maintenance.pump,
    clientFor,
    warn,
  );
  const offTools = registerMemoryTools(ctx, enabled, clientFor);
  for (const agent of ctx.agents.list()) buffer.replay(agent.session);
  const timer = setInterval(() => void maintenance.pump(), config.pollMs);
  timer.unref();
  void maintenance.pump();
  ctx.effect(() => async () => {
    lifetime.abort();
    clearInterval(timer);
    offEvent();
    offCreated();
    offStep();
    offTools();
    await maintenance.settled();
  });
}
