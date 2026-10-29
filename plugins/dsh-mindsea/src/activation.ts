import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import type { Session } from "@deepseek-ai/dsh-session";
import type { Config } from "./config.ts";

export const activationSchema = z
  .object({
    enabled: z.boolean().default(false),
    audience: z.enum(["private", "group", "unknown"]).default("unknown"),
    sessionIds: z.array(z.string().min(1)).default([]),
    disabledSessionIds: z.array(z.string().min(1)).default([]),
    workspaces: z
      .array(
        z
          .object({
            path: z.string().min(1),
            includeChildren: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type Activation = z.infer<typeof activationSchema>;
export function readActivation(config: Config): Activation {
  if (config.activationFile)
    return activationSchema.parse(
      JSON.parse(readFileSync(config.activationFile, "utf8")),
    );
  return activationSchema.parse({
    enabled: config.enabled ?? false,
    audience: config.audience ?? "unknown",
    sessionIds: config.sessionIds,
    workspaces: config.workspaces ?? [],
  });
}
export function resolveActivation(
  config: Config,
  session: Session,
): { enabled: boolean; reason: string } {
  try {
    const settings = readActivation(config);
    if (!settings.enabled) return { enabled: false, reason: "disabled" };
    if (settings.audience !== "private")
      return { enabled: false, reason: "audience-not-private" };
    if (settings.disabledSessionIds.includes(session.id))
      return { enabled: false, reason: "session-disabled" };
    if (settings.sessionIds.includes(session.id))
      return { enabled: true, reason: "session-rule" };
    const cwd = session.header?.cwd;
    if (!cwd) return { enabled: false, reason: "no-workspace" };
    const current = realpathSync(cwd);
    if (!statSync(current).isDirectory())
      return { enabled: false, reason: "not-a-workspace-directory" };
    for (const workspace of settings.workspaces) {
      if (!isAbsolute(workspace.path)) continue;
      const root = realpathSync(workspace.path);
      if (!statSync(root).isDirectory()) continue;
      const path = relative(root, current);
      if (
        path === "" ||
        (workspace.includeChildren &&
          !isAbsolute(path) &&
          path !== ".." &&
          !path.startsWith(`..${sep}`))
      )
        return { enabled: true, reason: "workspace-rule" };
    }
    return { enabled: false, reason: "no-matching-rule" };
  } catch {
    return { enabled: false, reason: "settings-or-workspace-unavailable" };
  }
}
