# Mindsea 开发约定

- 先读 `docs/development.md`；涉及分层记忆时同时读 `docs/design/l3-memory.md`。
- 产品约定：Memory 被动检索；Future 每轮检查；Future 更新由新事件独立触发。不得把更新绑定到召回成功。
- L0～L3 核心流程已实现，参见 `docs/layered-memory.md`。不得将确定性测试模型的结果声称为真实语义准确率。
- 保持 contracts / application / storage / search / http / client / DSH 适配的边界。
- 生产 TypeScript 禁止显式 any；外部数据在边界校验；禁止吞掉错误后推进处理 checkpoint。
- 不在 main.ts 或插件 index.ts 堆业务逻辑。源代码使用 kebab-case 文件名。
- SQLite 是唯一权威源；写入保护用户边界、来源、版本和事务一致性。
- 按变更运行必要检查；交付前运行 `npm run check`。说明真实联调与替身测试的区别。
- 不自动修改用户 DSH profile，不把测试模型请求发给真实供应商，不提交密钥或本地数据库。
