import { resolveActivation } from "./activation.ts";
import type { Context } from "@deepseek-ai/cordis";
import { MindseaClient } from "../../../src/client/index.ts";
import type { Config } from "./config.ts";
import { createEventBuffer } from "./event-buffer.ts";
import { createMaintenance } from "./maintenance.ts";
import { registerFutureHook } from "./future-hook.ts";
import { registerMemoryTools } from "./memory-tools.ts";
import { makeMemoryDecider } from "./memory-model.ts";
import { startMemoryMaintenance } from "./memory-maintenance.ts";
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
  const sessions = new Map(
    ctx.agents.list().map((agent) => [String(agent.id), agent.session]),
  );
  const matches = (id: string) => {
    const session =
      sessions.get(id) ?? ctx.agents.list().find((agent) => agent.id === id)?.session;
    return !!session && resolveActivation(config, session).enabled;
  };
  const bound = new Set<string>();
  const ensure = async (agent: import("@deepseek-ai/dsh-agent").Agent) => {
    sessions.set(agent.id, agent.session);
    if (!matches(agent.id)) {
      bound.delete(agent.id);
      return;
    }
    if (config.legacyAccess) {
      bound.add(agent.id);
      return;
    }
    try {
      await client.bindSession(agent.id);
      bound.add(agent.id);
    } catch {
      bound.delete(agent.id);
    }
  };
  const enabled = (id: string) =>
    matches(id) && (config.legacyAccess === true || bound.has(id));
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
    sessions.set(session.id, session);
    buffer.capture(session, event);
    if (enabled(session.id)) void maintenance.pump();
  });
  const offCreated = ctx.on("agent/created", async ({ agent }) => {
    await ensure(agent);
    buffer.replay(agent.session);
    if (enabled(agent.id)) void maintenance.pump();
  });
  const offCapture = ctx.on(
    "agent/pre-step",
    async (payload, next) => {
      await ensure(payload.agent);
      return next();
    },
    true,
  );
  const offStep = registerFutureHook(
    ctx,
    config,
    enabled,
    buffer,
    maintenance.pump,
    clientFor,
    warn,
  );
  const stopMemory = startMemoryMaintenance(
    client,
    makeMemoryDecider(ctx, config),
    lifetime.signal,
    config.pollMs,
    warn,
    () => [...sessions.keys()].some(enabled),
  );
  const toolScopes = new Map<string, () => void>();
  const refreshTools = (agent: import("@deepseek-ai/dsh-agent").Agent) => {
    if (enabled(agent.id) && !toolScopes.has(agent.id))
      toolScopes.set(agent.id, registerMemoryTools(agent.ctx, enabled, clientFor));
    else if (!enabled(agent.id) && toolScopes.has(agent.id)) {
      toolScopes.get(agent.id)!();
      toolScopes.delete(agent.id);
    }
  };
  const offToolCreated = ctx.on("agent/created", async ({ agent }) => {
    await ensure(agent);
    refreshTools(agent);
  });
  const offToolStep = ctx.on(
    "agent/pre-step",
    async (payload, next) => {
      await ensure(payload.agent);
      refreshTools(payload.agent);
      return next();
    },
    true,
  );
  for (const agent of ctx.agents.list()) refreshTools(agent);
  const offTools = () => {
    offToolCreated();
    offToolStep();
    for (const dispose of toolScopes.values()) dispose();
    toolScopes.clear();
  };
  for (const agent of ctx.agents.list()) buffer.replay(agent.session);
  const timer = setInterval(() => {
    for (const agent of ctx.agents.list()) refreshTools(agent);
    if ([...sessions.keys()].some(enabled)) void maintenance.pump();
  }, config.pollMs);
  timer.unref();
  if ([...sessions.keys()].some(enabled)) void maintenance.pump();
  ctx.effect(() => async () => {
    lifetime.abort();
    clearInterval(timer);
    offEvent();
    offCreated();
    offStep();
    offCapture();
    offTools();
    await Promise.all([maintenance.settled(), stopMemory()]);
  });
}
