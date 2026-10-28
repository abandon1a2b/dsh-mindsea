# 服务与 API 参考

## 当前能力

- **原始事件**：保存用户、会话、角色、时间和原文；支持调用方提供全局唯一事件 ID，重复提交相同内容不会重复入库。
- **Memory**：长期事实与偏好；修正留存所有版本，可回读来源原文。
- **Future**：带明确时区的未来关注时间，按时间独立召回。
- **事件驱动维护**：原始事件与维护任务原子入库；后台 worker 独立于召回运行；整批更新和处理进度原子提交，支持重试、并发版本保护和来源追溯。
- **Open loops**：没有日期的未闭环事项；也可以指定后续关注时间。
- **上下文组装**：到期事项 → 未闭环事项 → 相关检索；去重并限制候选 JSON 字符数。超过预算的单条候选会被省略，`omitted` 提示数量；不是 token 上限。
- **隔离与并发**：所有用户数据访问按身份过滤；更新要求当前版本，过期写入返回 409；每次变更与历史版本、索引 outbox 在同一事务提交。
- **检索**：默认 SQLite FTS5 trigram，支持中文片段；不足三个字符使用子串查询。默认是字面检索，不是语义向量检索。
- **可选 Meilisearch**：全文检索、异步持久化 outbox 同步；索引故障或尚有待同步写入时回退 SQLite。只在 Meilisearch 任务确认成功后清除对应版本的 outbox。

## 数据与状态

统一事项模型：`kind`、`content`、`status`、`sourceEventId`、`followUpAt`、`version`、时间戳。

| kind   | 默认状态 | 可用状态                                                |
| ------ | -------- | ------------------------------------------------------- |
| memory | active   | active / superseded / expired                           |
| future | pending  | pending / followed_up / completed / cancelled / expired |
| loop   | pending  | pending / followed_up / completed / cancelled / expired |

`future + pending` 必须有 `followUpAt`。日期必须是带时区的 RFC3339，统一转为 UTC。`due` 是派生查询结果，不是数据库状态。

真正向用户提起后，调用方更新为 `followed_up`，停止时间渠道的反复召回；这不代表事件完成。用户确认完成、取消或改变计划后，再更新状态或时间。状态可以通过带版本号的更新纠正或重新设为 pending。

`PUT` 是完整替换可编辑字段，不是局部合并；需要保留来源和时间时，务必一并传入。同一条记忆的纠错保留版本历史；第一版未实现跨记录替代关系图。

## API

除 `/health` 外，所有接口必须提供 `Authorization: Bearer ...` 和 `X-User-ID`。

| 方法 | 路径                        | 用途                                                      |
| ---- | --------------------------- | --------------------------------------------------------- |
| POST | /v1/events                  | 保存原始对话事件                                          |
| GET  | /v1/events/:id              | 回读来源原文                                              |
| POST | /v1/items                   | 创建 memory / future / loop                               |
| GET  | /v1/items/:id               | 获取当前版本                                              |
| PUT  | /v1/items/:id               | `{ "version": 1, "item": { ...完整可编辑字段 } }`         |
| GET  | /v1/items/:id/history       | 查询完整修订历史                                          |
| POST | /v1/future/check            | Future 专用每轮检查；返回 ready / empty / pending         |
| POST | /v1/memory/recall           | 只检索 memory 的被动工具接口                              |
| POST | /v1/recall                  | `{ "query": "记忆", "limit": 10 }`                        |
| POST | /v1/context                 | `{ "query": "今天好累", "limit": 10, "maxChars": 12000 }` |
| GET  | /v1/future/due              | 查询当前已到期且未跟进事项，最多 10 条                    |
| GET  | /v1/loops                   | 查询无日期未闭环事项，最多 10 条                          |
| GET  | /v1/reconciliation/next     | 读取当前用户最早的待处理事件和近期会话                    |
| GET  | /v1/agenda                  | 按 after/limit 分页读取全部 Future/loop，独立于召回       |
| POST | /v1/reconciliation/:eventId | 提交 agendaRevision、updates、creates，并原子完成任务     |

`context`、`future/due` 和 `loops` 在存在待处理事件时返回 `reconciliationPending: true` 并暂缓呈现 Future/loop，以免提起已被新对话改变的旧事项。处理器追上后恢复。

401 未认证；400 请求无效；404 不存在或不属于当前用户；409 版本冲突或事件 ID 冲突；413 请求体超过 256 KB。

**身份边界**：这是可信 Agent 后端调用的内部服务。共享 API key 的持有者有权选择 `X-User-ID`，它不是终端用户登录系统。接入端必须从已认证会话确定用户身份，不能让用户文本决定身份，也不能将 API key 发给浏览器。默认仅监听回环地址。

## Meilisearch（可选）

在已有 Meilisearch 实例上创建专用索引即可，无需迁移 SQLite 数据。

```sh
export MEILI_URL=http://127.0.0.1:7700
export MEILI_API_KEY=你的服务端密钥
export MEILI_INDEX=mindsea_v1
npm start
```

索引名只能包含字母、数字、下划线和连字符。服务会配置该索引的可检索/可过滤字段，因此应使用本项目专用索引。首次连接或进程重启会从 SQLite 重新排队索引任务。原始对话不进入搜索索引；结构化记忆和事项会复制到配置的 Meilisearch 实例。

索引失败每两秒重新尝试，每个 HTTP 请求超时五秒、任务等待上限三十秒；期间 SQLite 可继续写入和检索。程序输出简短错误，不打印消息正文或密钥。

## 配置

| 变量            | 默认值                        |
| --------------- | ----------------------------- |
| MINDSEA_API_KEY | 必填，至少 24 字符            |
| MINDSEA_HOST    | 127.0.0.1                     |
| MINDSEA_PORT    | 4318                          |
| MINDSEA_DB      | data/mindsea.sqlite           |
| MEILI_URL       | 留空时仅使用 SQLite           |
| MEILI_API_KEY   | 可选，按 Meilisearch 配置设置 |
| MEILI_INDEX     | mindsea_v1                    |

## 接入与范围

`src/client/index.ts` 是可复用 TypeScript 客户端，`src/application/reconcile-events.ts` 提供独立后台维护循环，接入流程见 `docs/integration.md`。

这是可运行的服务与 DSH 插件 MVP。DSH 插件自动维护 Future/loop，并以工具方式提供 Memory；尚未提供管理网页、L1～L3 自动记忆整理、独立模型供应商配置、主动通知或向量嵌入。未来的模糊时间（如“下周”）也由接入端结合用户时区解析，不能凭空当作精确日期。

当前采用一个 Node 进程、同步 SQLite 和 WAL，适合本地/小规模服务；尚未做生产负载评估。数据库 schema v2 在启动时兼容升级初版 v1，保留既有数据；历史事件不自动重放，新事件开始写入维护队列。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

测试覆盖真实 SQLite、HTTP 服务和后台维护器，包含未唤起事项被新事件取消、任务持久化、批次回滚、重试幂等、并发快照保护、分页及 schema v1 升级，以及中文检索、身份隔离、来源验证、重复事件、时间边界、版本冲突、重启持久化、预算和去重、索引失败回退、outbox 版本保护。Meilisearch 接口通过本地模拟服务验证；当前环境未启动真实 Meilisearch，尚未做真实实例联调。

DSH 插件回归覆盖每轮检查、空结果静默、工具循环不重复检查、用户补充触发检查、独立事件维护取消事项、上下文来源隔离、Memory 按需调用、服务故障降级和拒绝助手臆造完成。模型行为用确定性替身验证，未发送真实模型请求。
