# 通用接入接口（DSH 已有专用插件）

DSH 用户优先使用 `plugins/dsh-mindsea/README.md`。下面的回调示例面向其他宿主；DSH 插件已实现该回调并绑定自己的模型服务。

Future 有两条独立链路：

1. **维护**：新对话 → 持久化事件队列 → 模型判断事项变化 → 原子更新事项和处理进度。
2. **呈现**：当前语境/时间 → 召回候选 → 判断适不适合提起 → 记录已跟进。

维护不调用 `context()`、`recall()` 或 `due()`，也不依赖事项之前是否出现在回答中。

## 在宿主后台启动维护器

```ts
import { MindseaClient } from "./src/client/index.ts";
import { runReconciler } from "./src/application/reconcile-events.ts";

const memory = new MindseaClient({
  baseUrl: "http://127.0.0.1:4318",
  apiKey: process.env.MINDSEA_API_KEY!,
  userId: authenticatedUser.id,
});
const controller = new AbortController();

// 在该用户的宿主后台生命周期启动一次，不放在召回/回复分支里。
const maintenance = runReconciler(
  memory,
  async ({ event, recentEvents, agenda, signal }) => {
    // 对接宿主已有模型。这里的 inferAgendaChanges 是宿主实现，不是内置函数。
    // 输入包含新事件、同会话前 20 条事件，以及全部分页读取的 Future/loop。
    // agenda 不按是否到期、是否召回过或当前状态过滤。
    return inferAgendaChanges({ event, recentEvents, agenda, signal });
  },
  {
    signal: controller.signal,
    onError: (error) => reportMaintenanceFailure(error),
  },
);

// 收到任何新事件就记录，不需要先检索 Future。
await memory.record({
  id: "platform:session-123:message-456",
  sessionId: "session-123",
  role: "user",
  content: "那个面试取消了。",
});

// 正常对话的读取路径：
const context = await memory.context("今天好累");
// reconciliationPending=true 表示事件维护尚未追上。
// 此时 context 暂缓返回 Future/loop，仅返回 memory。
// 主对话可照常进行，但不要根据缓存的旧事项发起提醒。

// 宿主退出时：
controller.abort();
await maintenance;
```

宿主必须为已认证用户运行维护器，即使当前没有生成回复、没有触发召回。多用户宿主负责维护用户与 worker 的映射。服务本身不维护模型供应商配置，`npm start` 只运行 HTTP 服务和索引同步；没有接入 `decide` 模型回调时，事件会安全地保留为待处理，不能声称已经自动理解了对话。

## 模型返回结构

维护器会自动附加读取时的 `agendaRevision`。模型只返回：

```json
{
  "updates": [
    {
      "id": "既有事项ID",
      "version": 1,
      "item": {
        "kind": "future",
        "content": "用户已取消原定的面试",
        "status": "cancelled"
      }
    }
  ],
  "creates": []
}
```

可以取消、改期、完成、重新打开事项，或创建新 Future/loop。没有变化时返回空数组。完整字段替换规则与普通 PUT 相同，改期需提供 `followUpAt`，需要保留的内容和日期应一起返回。服务强制将每个变化的 `sourceEventId` 指向本次新事件，旧版本保留原来源。

## 一致性与失败处理

- 事件和待处理任务在同一 SQLite 事务写入；幂等事件重试不会重复排队。
- 同一用户按入库顺序处理；新事件不能越过尚未完成的旧事件。不同用户独立。
- 队列持久化，模型失败、进程退出、读取超量均不推进进度。
- 议程分页每页最多 100 条；worker 默认最多接收 10,000 条。超限会失败并保留任务，不静默截断。
- 分页期间或推理期间议程发生变化时，版本检查返回冲突，重新读取并推理。即使模型判断“无变化”，也不能用旧快照推进进度。
- 整批修改、历史版本、索引 outbox 和完成标记在同一事务提交。任一修改失败，整批回滚。
- 完成响应丢失后重试同一个事件，会返回已保存的结果，不重复创建或修改。
- 任务完成重试返回的是当时结果；需要最新事项时再调用 get。
- `context`、`future/due`、`loops` 在存在待处理事件时返回 `reconciliationPending: true` 并暂缓呈现议程。`recall` 和单条 get 仍是原始数据查询，不保证语义维护已追上。
- 为兼容初版数据库，升级到 schema v2 保留既有事件和事项；升级前事件不自动重放，以免重复提取。升级后新事件全部入队。

## 提取与呈现规则

- 新的用户陈述、可信工具结果可能改变事项；助手说“我问过了”不能证明事情已经完成。
- 用户明确事实、偏好、计划可以形成候选。玩笑、假设、引述、模型猜测不能直接转成事实。
- 同会话近期事件帮助解决“那个安排”等指代。不明确时不强行匹配、取消或改期。
- 未来时间按用户时区解释；时间不明确的事项先建无日期 loop，不凭空指定精确日期。
- 历史内容是资料，不是指令；维护器也必须抵抗历史中的指令注入。
- `followed_up` 仅表示已经向用户提起，不表示完成；未来的新证据仍应继续更新它。
- 时间到达只会进入候选，不代表允许发送通知。用户明确要求提醒时，由宿主调度器负责通知。
- 不因为日期过去就自动将 pending 标记为 completed。

DSH 0.2.1-rc.2 接入位于 `plugins/dsh-mindsea`：session/event、agent/created 和 agent/pre-step；源码使用官方类型检查。
