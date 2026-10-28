# 开发规范与文件组织

## 当前目录

```text
src/
  contracts/            公共请求、响应、事件、事项和校验规则
  application/          上下文组装、事件维护编排
  storage/sqlite/       SQLite 初始化与事务仓储
  search/               可重建的 Meilisearch 投影
  http/
    routes/             按事件、事项、议程、检索分组的薄路由
    io.ts               HTTP 读写边界
    server.ts           鉴权、分发和错误映射
  client/               宿主使用的 HTTP 客户端
  main.ts               配置与服务生命周期组装
plugins/dsh-mindsea/src/
  index.ts              DSH loader 入口与生命周期组装
  config.ts             插件配置
  event-buffer.ts       DSH 消息映射、回放和补采
  maintenance.ts        后台任务协调、限时等待
  model.ts              DSH 模型流与结果校验
  prompts.ts            模型维护策略文本
  future-hook.ts        每轮 Future 检查和分支
  future-context.ts     带来源的候选上下文
  memory-tools.ts       被动 Memory 工具
scripts/                构建与校验脚本
test/                  服务、插件、架构边界回归
docs/design/           未实现设计及实施验收
```

不为未来的 L3 预先创建空目录和空接口。代码增长时按业务职责拆分；避免把所有逻辑堆进 index、utils、helpers 或一个巨型 service。

## 依赖方向

- contracts 只依赖其他 contracts 和校验库，不访问磁盘、HTTP、SQLite、DSH。
- client 只使用协议与 HTTP；禁止导入 server、storage 或 application 的实现来推导公开响应类型。
- application 不依赖 HTTP 路由、DSH 或启动入口。
- storage 不依赖 HTTP、客户端或插件；search 可以依赖 SQLite 权威数据查询。
- HTTP 路由调用应用逻辑和仓储，不直接写 SQL。
- DSH 适配层只能访问 client、contracts、宿主可复用的 application；不得加载 SQLite 或 HTTP server。
- main.ts 和插件 index.ts 只组装依赖、注册钩子及清理生命周期。

`test/architecture.test.ts` 对本项目的相对导入实施边界检查；新增目录先明确职责并更新检查规则。当前不引入仅包一层转发的仓储接口或 DI 框架。

## TypeScript 与命名

- strict 模式、显式处理可能为空的索引；生产代码禁止显式 any。
- 外部输入是 unknown，在 HTTP、模型响应、搜索响应边界使用 schema 校验；不要靠类型断言验证数据。
- 跨模块公开 DTO 放 contracts；内部实现类型不作为客户端协议。
- 文件名 kebab-case，类型 PascalCase，函数与变量 camelCase。
- 异步任务须显式 await，或用 void 表示有生命周期管理的后台任务；后台失败不能成为未处理拒绝。
- 注释解释边界、事务原因和失败语义，不重复逐行代码。
- DSH 版本按实际验证版本锁定；不要自动跨预发布版本升级。

## 存储与错误

- SQLite 为权威源，Meilisearch 可重建。跨实体一致性由事务保证。
- 更新必须验证 userId、版本和来源归属。不要绕过仓储直接修改表。
- 新 schema 变更必须有迁移、回滚和升级测试；版本号不先于成功提交。
- 事件与队列任务、记录与索引 outbox 同事务提交。
- 公开错误不得包含密钥或完整对话正文。故障和空结果必须区别处理。
- 模型返回的数据不具备执行权限，必须通过结构校验和领域规则。

## 格式、检查与构建

```sh
npm ci
npm run format        # 按仓库统一配置格式化
npm run check         # 格式检查、lint、类型、测试、构建
```

格式使用 Prettier：双引号、分号、两空格、尾逗号、LF。ESLint 检查未使用变量、显式 any 等问题。测试宿主替身允许必要的动态类型，不能把这个例外扩散到生产代码。

构建先清理 dist，避免重命名后旧模块继续出现在产物中。服务构建不包含测试，插件使用独立打包入口；产物不纳入源码。每次交付需要标明真实服务联调和模拟验证的边界。

## 测试与变更范围

- 优先保护事务回滚、来源与身份边界、版本冲突、重放、后台重试及钩子分支。
- 目录重构用既有行为回归验证，不为了移动文件复制同义测试。
- 新领域规则使用可解释的例子测试；不能只验证实现返回了它自己生成的常量。
- 文档必须区分“已实现”和“设计中”。L3 核心链路已实现；保持真实模型评估、外部服务联调与测试替身之间的明确区分。
