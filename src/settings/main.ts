import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  statSync,
} from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { Store } from "../storage/sqlite/store.ts";
import { page, escape as e } from "./page.ts";

// A short-lived local management process. No service admin secret enters the browser.
const dbPath = resolve(process.env.MINDSEA_DB ?? "data/mindsea.sqlite");
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const store = new Store(dbPath);
let codeUsed = false;
const code = randomBytes(18).toString("hex");
const session = randomBytes(24).toString("hex");
const csrf = randomBytes(24).toString("hex");
const settingsRoot = resolve(dirname(dbPath), "profiles");
mkdirSync(settingsRoot, { recursive: true, mode: 0o700 });
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const field = (label: string, name: string, type = "text") =>
  `<label>${label}<input name="${name}" type="${type}" required></label>`;
const hidden = `<input type="hidden" name="csrf" value="${csrf}">`;
function dashboard(message = "") {
  const rows = store.access.list();
  const profiles = rows
    .map((row) => {
      const file = resolve(settingsRoot, String(row.brainId), "activation.json");
      let settings: {
        enabled?: boolean;
        workspaces?: { path: string; includeChildren: boolean }[];
      } = {};
      if (existsSync(file)) settings = JSON.parse(readFileSync(file, "utf8"));
      return `<section><h2>${e(row.brainName)}</h2><p>所属人员：${e(row.personName)} · ${row.paused ? "已暂停" : settings.enabled ? "规则已启用" : "未启用"}</p><p class="muted">${e(row.brainId)}</p><form method="post" action="/rules">${hidden}<input type="hidden" name="brainId" value="${e(row.brainId)}"><label>工作区目录<input name="workspace" value="${e(settings.workspaces?.[0]?.path ?? "")}" placeholder="/absolute/path/to/workspace"></label><label><input type="checkbox" name="children" ${settings.workspaces?.[0]?.includeChildren ? "checked" : ""}> 包含子目录</label><label><input type="checkbox" name="enabled" ${settings.enabled ? "checked" : ""}> 在该工作区启用（仅个人 DSH profile）</label><button>保存规则</button></form><form method="post" action="/pause">${hidden}<input type="hidden" name="brainId" value="${e(row.brainId)}"><input type="hidden" name="paused" value="${row.paused ? "0" : "1"}"><button>${row.paused ? "恢复脑海访问" : "暂停脑海访问"}</button></form><details><summary>查看 DSH 配置位置</summary><p>配置：<code>${e(resolve(dirname(file), "dsh-config.json"))}</code></p><p>启动环境：<code>${e(resolve(dirname(file), "start-env.sh"))}</code></p><p>密钥只保存在权限为 0600 的本机文件，不在页面显示。一个个人 profile 绑定一个脑海，换人员或脑海请使用新 profile 和新会话。</p></details></section>`;
    })
    .join("");
  return page(
    `${message ? `<section role="status">${e(message)}</section>` : ""}<p>默认不采集任何会话。创建脑海后设置工作区，只有匹配的个人会话才接入。</p><section><h2>创建私人脑海</h2><form method="post" action="/create">${hidden}<div class="grid">${field("人员显示名", "personName")}${field("脑海名称", "brainName")}</div><label>已有人员（可选）<select name="personId"><option value="">创建新人员身份</option>${[...new Map(rows.map((row) => [String(row.personId), row])).values()].map((row) => `<option value="${e(row.personId)}">${e(row.personName)}</option>`).join("")}</select></label><button>创建并生成个人配置</button></form><p class="muted">本页面属于本机管理员，只管理身份、脑海和规则；不是多人登录入口。</p></section>${profiles || "<section><p>还没有脑海。旧数据库内容不会自动归到新身份。</p></section>"}`,
  );
}
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  try {
    const host = req.headers.host ?? "";
    if (!/^127\.0\.0\.1:\d+$/.test(host)) throw new Error("Invalid host");
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === "/") {
      if (req.headers.cookie?.split("; ").includes(`mindsea_setup=${session}`)) {
        res.end(dashboard());
        return;
      }
      res.end(
        page(
          `<section><h2>打开本机设置</h2><p>输入启动设置服务时终端显示的一次性访问码。</p><form method="post" action="/login">${field("访问码", "code", "password")}<button>进入设置</button></form></section>`,
        ),
      );
      return;
    }
    if (req.method !== "POST") throw new Error("Unsupported request");
    if (req.headers.origin !== `http://${host}`) throw new Error("Origin rejected");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > 8192) throw new Error("Form too large");
    }
    const data = new URLSearchParams(raw);
    if (url.pathname === "/login") {
      if (codeUsed || !equal(data.get("code") ?? "", code))
        throw new Error("访问码错误");
      codeUsed = true;
      res.setHeader(
        "Set-Cookie",
        `mindsea_setup=${session}; HttpOnly; SameSite=Strict; Path=/`,
      );
      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }
    if (
      !req.headers.cookie?.split("; ").includes(`mindsea_setup=${session}`) ||
      !equal(data.get("csrf") ?? "", csrf)
    )
      throw new Error("Authentication required");
    if (url.pathname === "/create") {
      const result = store.access.create({
        personName: data.get("personName"),
        brainName: data.get("brainName"),
        ...(data.get("personId") ? { personId: data.get("personId") } : {}),
      });
      const dir = resolve(settingsRoot, result.brainId);
      mkdirSync(dir, { mode: 0o700 });
      const file = resolve(dir, "activation.json");
      writeFileSync(
        file,
        JSON.stringify(
          {
            enabled: false,
            audience: "private",
            sessionIds: [],
            disabledSessionIds: [],
            workspaces: [],
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      const variable = `MINDSEA_PERSONAL_KEY_${result.brainId.replaceAll("-", "_")}`;
      writeFileSync(
        resolve(dir, "start-env.sh"),
        `export ${variable}='${result.token}'\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        resolve(dir, "dsh-config.json"),
        JSON.stringify(
          {
            baseUrl: process.env.MINDSEA_SERVICE_URL ?? "http://127.0.0.1:4318",
            apiKeyEnv: variable,
            userId: result.brainId,
            enabled: false,
            activationFile: file,
            provider: "deepseek",
            model: "deepseek-chat",
            timeZone: "Asia/Shanghai",
            sessionIds: [],
            hookBudgetMs: 5000,
            pollMs: 1000,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      res.end(
        dashboard("脑海已创建。请设置工作区，再将生成的配置填入指定个人 DSH profile。"),
      );
      return;
    }
    const brainId = data.get("brainId") ?? "";
    if (!store.access.list().some((row) => row.brainId === brainId))
      throw new Error("Brain not found");
    if (url.pathname === "/rules") {
      const workspace = data.get("workspace") ?? "";
      const enabled = data.get("enabled") === "on";
      if (enabled && !workspace) throw new Error("启用前请选择工作区");
      if (workspace && !isAbsolute(workspace)) throw new Error("必须是绝对目录");
      const canonical = workspace ? realpathSync(workspace) : "";
      if (canonical && !statSync(canonical).isDirectory())
        throw new Error("必须选择目录");
      writeFileSync(
        resolve(settingsRoot, brainId, "activation.json"),
        JSON.stringify(
          {
            enabled,
            audience: "private",
            sessionIds: [],
            disabledSessionIds: [],
            workspaces: canonical
              ? [{ path: canonical, includeChildren: data.get("children") === "on" }]
              : [],
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      res.end(dashboard("规则已保存。下轮对话前会重新检查；不会补采旧聊天。"));
      return;
    }
    if (url.pathname === "/pause") {
      store.access.pause(brainId, data.get("paused") === "1");
      res.end(dashboard("访问状态已更新。"));
      return;
    }
    throw new Error("Unknown operation");
  } catch (error) {
    res.statusCode = 400;
    res.end(
      page(
        `<section><h2>未完成操作</h2><p>${e(error instanceof Error ? error.message : "操作失败")}</p><a href="/">返回设置</a></section>`,
      ),
    );
  }
});
server.listen(Number(process.env.MINDSEA_SETTINGS_PORT ?? 4319), "127.0.0.1", () =>
  console.log(
    `脑海设置：http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}\n本次访问码：${code}`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => server.close(() => store.close()));
