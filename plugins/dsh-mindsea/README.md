# dsh-mindsea · 脑海

Mindsea 的首个宿主插件，面向 DSH **0.2.1-rc.2**。插件实现全部使用 TypeScript，发布包是编译后的 ESM。

## 行为

| 能力        | 触发方式                            | 有结果                                 | 无结果                         |
| ----------- | ----------------------------------- | -------------------------------------- | ------------------------------ |
| Memory      | 模型按需调用 recall / remember 工具 | 使用查到的事实，或保存明确记忆         | 说明未找到，不猜测             |
| Future 检查 | 每个聊天回合的 agent/pre-step 钩子  | 注入少量候选，由模型决定是否提起       | 不注入内容，正常聊天           |
| Future 更新 | 新用户/助手对话入库后的独立后台维护 | 事务提交取消、改期、完成、已跟进等变化 | 完成该事件检查，继续等待新事件 |

这里“每次”指每个聊天回合，不是每个 token，也不是内部工具循环的每一步。同一回合有新的用户补充输入时也会再次检查。

Future 的状态只有读取结果 `ready / empty / pending`，网络失败走异常降级。pending 和网络失败都不等同于 empty。每次检查默认最多等后台维护五秒，再用至多两秒请求检查接口；状态尚未追上时不提示旧事项。后台仍继续完成更新，下一回合再检查。可通过 hookBudgetMs 调整等待时间。

## 构建与安装

1. 启动 Mindsea 服务（Node.js 24+），保存并设置 `MINDSEA_API_KEY`。
2. 在仓库根目录构建并打包：

   ```sh
   npm ci
   npm run build
   npm pack ./plugins/dsh-mindsea
   ```

3. 安装本地插件包。先用目标机器的 `dsh plugin --help` 核对当前 CLI；以下以 web profile 为例：

   ```sh
   dsh plugin --profile web add /absolute/path/dsh-mindsea-0.1.0.tgz
   ```

4. 在该 profile 的 `id: mindsea` loader entry 配置以下字段，并确保启动 DSH 的进程也带有相同 `MINDSEA_API_KEY`。然后重新加载 profile / 重启 DSH。

   ```yaml
   baseUrl: http://127.0.0.1:4318
   apiKeyEnv: MINDSEA_API_KEY
   userId: local-owner
   provider: deepseek
   model: deepseek-chat
   timeZone: Asia/Shanghai
   hookBudgetMs: 5000
   pollMs: 1000
   sessionIds: []
   ```

`provider` / `model` 必须改为你在 DSH 已配置且可用的模型路由；示例不是自动探测结果。维护使用现有 DSH `llm` 服务，插件不额外保存供应商 API key。每条新文本对话可能产生一次额外维护模型调用，读取 Future 本身不调用模型。

`userId` 绑定可信的个人 profile。空 sessionIds 表示这个个人 profile 的所有会话；设置 ID 列表则只启用对应会话。不要把同一固定 userId 的实例直接挂到多人/QQ群共享会话中；这种接入需要桥接端提供可信用户映射，当前插件不支持多用户身份自动识别。

插件本身只需要 Node.js 22+；SQLite 留在独立的 Node.js 24+ Mindsea 服务，避免要求 DSH 进程加载 SQLite。

## 实现与约束

- `session/event` 收集用户原话与已提交、未中断的助手文本；`agent/created` 和首次 pre-step 从 DSH 会话日志回放补采。消息 ID 经 session + message ID 哈希，用于幂等写入。
- pre-step 先接入本轮新输入，再限时等待维护并检查 Future，避免“取消计划”的输入之后还提起旧安排。
- 插件注入的上下文、其他插件上下文、Memory 工具结果都不当作用户原话重新记忆，避免自我污染。当前只支持文本块，不提取图片/附件中的事实。
- 事件持久化后，后台处理不依赖再次聊天、工具查询或 Future 检查。在 DSH 宿主进程运行时定期轮询；关闭 DSH 后暂停，重新启动后续接。
- 助手输出最多只能将确实已问及的事项标为 followed_up，不能凭助手陈述取消、完成或创建用户计划。实际语义匹配仍取决于模型，模型输入包含原始证据。
- 检索不会自动标记已跟进；后台看到实际提交的助手文本后再判断。对于 QQ 等外部传输，“DSH 已提交”不等于“远端已送达”，需要对应桥接适配确认送达状态，本版面向 DSH 原生聊天。
- 单次维护输入上限 80,000 字符，议程最多 1,000 项；超限、模型失败或输出截断时保留任务，避免在缺少证据的情况下推进处理进度。
- 新事件在服务故障时暂存于插件内存，并由 DSH 自己的会话日志提供重启补采来源。尚未被 DSH 提交的 pre-step 输入没有额外的本地磁盘队列。
- API key 从环境变量读取，配置仅保存变量名。插件卸载会停止定时器并取消在途维护。

## 验证范围

通过官方 npm 发布的 0.2.1-rc.2 类型检查，参考了 `dsh-agent-loop` 的实际调用顺序、`dsh-tools` 的工具协议和 `dsh-llm` 的流事件协议。

自动测试使用真实 SQLite/HTTP、确定性的模型替身和钩子测试宿主。还没有在真实运行的 DSH profile 上启动测试，也未调用真实供应商模型。本包不会自行安装或改写你的 DSH 配置。

官方来源：

- https://www.npmjs.com/package/@deepseek-ai/dsh-agent/v/0.2.1-rc.2
- https://www.npmjs.com/package/@deepseek-ai/dsh-agent-loop/v/0.2.1-rc.2
- https://www.npmjs.com/package/@deepseek-ai/dsh-tools/v/0.2.1-rc.2
- https://www.npmjs.com/package/@deepseek-ai/dsh-llm/v/0.2.1-rc.2
