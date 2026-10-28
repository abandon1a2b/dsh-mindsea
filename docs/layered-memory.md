# L0～L3：实现与使用

版本：0.2.0；SQLite schema v3。Memory 的自动整理与 Future 更新使用独立队列，DSH 对话前只检查 Future。Memory 的读取仍由工具按需触发。

## 已实现的完整流程

1. 原始文本进入 L0，保留空白、实际发生时间、接收时间、角色和生产者；身份由接入端绑定。
2. 人类消息在同一事务中写入 Memory 任务。助手消息只进入 Future/跟进维护，不可成为用户画像的根证据。
3. 独立 Memory worker 获取租约、原始消息、近期会话、现有记忆与已计算的证据片段。
4. DSH 模型提出 L1 事实、L2 主题、L3 画像及明确纠正；不相关事件可以返回空批次。
5. 服务校验用户、原文 SHA-256、Unicode 码点偏移、依赖版本、层级、作用域和状态，在同一事务中写入记录、历史、证据、依赖、索引 outbox 与完成标记。
6. 模型需要时调用 `mindsea_recall`，可按意图、范围和层级读取；结果附带证据和处理进度。

L1 是 fact / episode；L2 是 topic-summary；L3 是 preference / habit / long-term-goal / relationship。L2 依赖 L1，L3 可依赖 L1 或 L2；不允许同层/高层依赖、跨用户依赖、候选依赖和失效依赖。

## 证据与画像规则

- 证据由 eventId、start、end、contentHash、relation 组成。start/end 按 Unicode 码点计算，区间为左闭右开。
- 人类消息只代表证据来源。它究竟是玩笑、转述、临时状态还是明确偏好，由模型做语义判断；服务不能通过哈希证明一句话的含义。
- 相同原文事件跨层引用只算一份根证据；重复导入的相同文本也不增加 independentEvidenceCount。
- 明确的稳定偏好可由 L1 直接支持 L3，不强制绕经 L2。
- inferred 画像强制为 candidate。只有既有候选收到一条新的用户确认证据后，才允许激活；不能在创建时顺便伪造确认。
- L3 不得把低层证据的具体范围扩大成 global，即使通过 L2 间接引用也会检查。
- 同范围同谓词不同值不会静默覆盖：旧、新记录进入 disputed。具体范围的例外不影响一般规则。
- 同一条记录的纠错保留修订。明确 superseded / retracted 会屏蔽旧根证据用于后续晋升，防止重建复活。

屏蔽采用保守的事件级策略：同一消息里有多个事实，其中一个被撤回后，该消息不再支持新的有效记忆；需要一条新的人类陈述重新建立证据。这会牺牲部分召回，避免误复活。

## 公开接口

所有接口使用服务密钥和可信 `X-User-ID`。`/v1/memory/recall` 保留兼容旧 records，返回 `legacy-unverified`；分层记忆使用 `/v1/memory/query`。

| 方法 | 路径                                          | 用途                                            |
| ---- | --------------------------------------------- | ----------------------------------------------- |
| GET  | `/v1/memory/evidence/:eventId?start=0&end=10` | 获取经过校验的证据引用，省略 end 表示全文       |
| POST | `/v1/memory/remember`                         | `{content,evidence}`，显式保存 L1               |
| POST | `/v1/memory/query`                            | 分层查询、原文查询、历史查询                    |
| GET  | `/v1/memory/records/:id`                      | 当前记录                                        |
| GET  | `/v1/memory/records/:id/history`              | 修订历史                                        |
| POST | `/v1/memory/actions`                          | 确认候选、质疑或撤回                            |
| POST | `/v1/memory/forget`                           | `{eventIds:[...]}`，删除源事件与相关派生内容    |
| GET  | `/v1/memory/topics`                           | 主题及别名                                      |
| POST | `/v1/memory/topics/alias`                     | `{topic,alias}`，将新别名绑定到既有主题         |
| GET  | `/v1/memory/jobs`                             | 最近 100 个任务、错误状态、watermark            |
| POST | `/v1/memory/jobs/claim`                       | 领取待处理任务，返回租约与快照                  |
| POST | `/v1/memory/jobs/:id/commit`                  | `{token,revision,plan}`，原子提交               |
| POST | `/v1/memory/jobs/:id/fail`                    | `{token}`，退回重试或标为失败                   |
| POST | `/v1/memory/jobs/:id/retry`                   | 人工重试 failed 任务                            |
| POST | `/v1/memory/rebuild`                          | 对未被忘记/撤回的旧事件重新排队，不清空派生记录 |

主题名称经过 Unicode NFC、首尾空白和小写规范化。别名只绑定到现有 canonical topic，不能把另一个已使用的主题直接改成别名；需要合并的内容应通过带版本的写入重整，避免盲目合并不同主题。

### 查询示例

```json
{
  "query": "技术",
  "intent": "preference",
  "scope": { "kind": "topic", "key": "design-review" },
  "layers": ["L1", "L2", "L3"],
  "limit": 5,
  "maxChars": 12000,
  "includeInactive": false
}
```

intent 支持 auto / preference / history / topic / exact-quote。偏好优先 L3，经历优先 L1，主题优先 L2；具体 scope 优先 global，相同内容跨层去重。未指定 scope 时只返回 global，避免把局部偏好误用到所有场景。

默认排除候选、冲突、撤回、过期和依赖失效的记录。`includeInactive: true` 用于主动审查，不意味着返回内容都可作为当前事实。`asOf` 按系统 recorded revision 的 updatedAt 回看当时已知的版本；exact-quote 的 asOf 则过滤原始事件 occurredAt。历史结果保留状态/有效期，不能当作当前结论。

`watermark` 包含 pending、failed、lastCompletedEventId 和 revision。lastCompletedEventId 是最近完成任务的事件，不是连续处理到的全局游标；pending/failed 非零时，已有检索结果可能尚未涵盖新消息的语义变化。显式纠正 API 在事务提交时立即失效旧结论；自然语言纠正要等模型识别后才能应用。

### 批次示例

```json
{
  "extractorVersion": "my-model/prompt-v1",
  "invalidations": [],
  "writes": [
    {
      "key": "fact",
      "record": {
        "layer": "L1",
        "kind": "fact",
        "topic": "communication",
        "content": "用户明确要求技术说明先给结论",
        "basis": "explicit",
        "evidence": ["替换为 evidence 接口返回的对象"]
      }
    },
    {
      "key": "profile",
      "record": {
        "layer": "L3",
        "kind": "preference",
        "topic": "communication",
        "content": "技术说明先给结论",
        "basis": "explicit",
        "scope": { "kind": "topic", "key": "technical-discussion" },
        "claim": { "predicate": "response.order", "value": "conclusion-first" },
        "evidence": ["替换为 evidence 对象"],
        "dependencies": [{ "id": "$fact", "version": 1 }]
      }
    }
  ]
}
```

上面 evidence 的字符串是文档占位符，实际请求必须使用证据对象。`$key` 只引用同批前面已经创建的低层记录，服务器解析成真实 ID。更新需要 id 和 version；失效 L1 会自动改变派生条目的版本，重建时应读取最新版本或创建有新证据的替代记录。

### 确认或纠正

```json
{
  "revision": 12,
  "target": { "id": "memory-id", "version": 1 },
  "action": "confirm",
  "evidence": {
    "eventId": "new-user-event",
    "start": 0,
    "end": 8,
    "contentHash": "64位SHA-256",
    "relation": "supports"
  },
  "reason": "用户明确确认这条偏好"
}
```

action 支持 confirm / retract / dispute。revision 取自 memory jobs 或 query 的 watermark，证据引用取自 evidence 接口。失败的版本检查返回 409，不允许静默覆盖。

## DSH 工具

- `mindsea_recall`：被动分层查询；可以请求 includeInactive 审查候选。
- `mindsea_remember`：把最新已提交的用户原话作为证据保存 L1。
- `mindsea_memory_inspect`：查看记录历史与来源。
- `mindsea_memory_action`：使用当前用户证据确认、质疑、撤回。
- `mindsea_forget`：仅在明确要求遗忘指定源事件时执行不可逆清理。

Memory worker 单独轮询，使用 DSH 的 provider/model。每条用户事件可能增加一次 Memory 模型调用；Future 维护仍使用自己的任务循环。读取画像不会触发一个新的聊天回合，也不会把完整画像自动注入每轮对话。

## 调度、预算与恢复

- 同用户同时最多一个 Memory 租约；租约 120 秒。模型调用 60 秒超时。
- 处理失败退回队列，至少 5 秒后重试，三次后进入 failed。失败任务不阻塞后续任务和 Future。可使用 retry 接口恢复。
- 快照最多 2,000 条当前记录；DSH 模型输入预算 160,000 字符、输出预算 200,000 字符。超限明确失败，不静默截断证据。
- L1/L2/L3 在一个受限批次中更新受影响内容；本版不做全用户全量定时蒸馏。重复事实按原文和结构去重。
- v2 → v3 自动迁移并保留旧事件；历史事件不会自动发给模型，显式调用 rebuild 才重新处理。
- 旧 kind=memory 记录保留为 legacy/unverified，不能自动冒充 L3。

## 遗忘范围

删除指定 L0 内容以及同用户的相同文本副本；删除关联任务；脱敏所有依赖记忆的当前和历史内容、来源引用以及有来源关联的旧 Memory/Future。无正文 tombstone 阻止相同 ID 或相同原文重放。正在运行的旧模型结果会因 revision / 来源失效被拒绝。

Meilisearch 使用独立 `<index>_memory`，删除任务通过 outbox 重试。在索引同步完成前，权威读取会拒绝返回已遗忘记录。数据库备份、DSH 自身历史和供应商日志不由本服务清理；SQLite 删除是逻辑数据删除，不保证存储介质上的取证擦除。无法判断没有来源关系的任意手工复制文本，需按用户指定范围另行清理。

## 已验证与实践边界

- 真实 SQLite/HTTP 集成：Unicode 引用、跨用户隔离、原子提交、回滚、租约、失败重试、重启恢复、版本冲突、历史查询、画像确认、范围限制、纠错传播、撤回防复活、遗忘和检索预算。
- 官方 DSH 0.2.1-rc.2 核心运行时：真实 Cordis、AgentLoop、Session、ToolRuntime 和 LlmRuntime 装载插件，完成对话后后台生成 L3，卸载停止工作。模型使用本地确定性适配器。
- Meilisearch 协议使用模拟服务/适配器验证，包括删除与故障回退；尚未接入真实运行的 Meilisearch。
- 没有用真实供应商模型评估玩笑识别、人物指代和长期画像的语义准确率。类型/证据校验通过，不等于模型理解必然正确。
