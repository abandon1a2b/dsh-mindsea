import Schema from "@deepseek-ai/schemastery";
export interface Config {
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
