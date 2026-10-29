import Schema from "@deepseek-ai/schemastery";
export interface Config {
  legacyAccess?: boolean;
  enabled?: boolean;
  audience?: "private" | "group" | "unknown";
  activationFile?: string;
  workspaces?: { path: string; includeChildren: boolean }[];
  baseUrl: string;
  apiKeyEnv: string;
  userId: string;
  provider: string;
  model: string;
  timeZone: string;
  sessionIds: string[];
  hookBudgetMs: number;
  pollMs: number;
}
export const Config = Schema.object({
  legacyAccess: Schema.boolean().default(false),
  enabled: Schema.boolean().default(false),
  audience: Schema.union(["private", "group", "unknown"]).default("unknown"),
  activationFile: Schema.string(),
  workspaces: Schema.array(
    Schema.object({
      path: Schema.string().required(),
      includeChildren: Schema.boolean().default(false),
    }),
  ).default([]),
  baseUrl: Schema.string().default("http://127.0.0.1:4318"),
  apiKeyEnv: Schema.string().default("MINDSEA_API_KEY"),
  userId: Schema.string().required(),
  provider: Schema.string().required(),
  model: Schema.string().required(),
  timeZone: Schema.string().default("Asia/Shanghai"),
  sessionIds: Schema.array(Schema.string()).default([]),
  hookBudgetMs: Schema.number().min(0).max(30000).default(5000),
  pollMs: Schema.number().min(100).max(60000).default(1000),
});
