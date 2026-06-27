# Redis 管理器组件重设计文档

> 当前状态：已接入远程桌面（appKey: `redis`），实现入口为 `src/components/remote-desktop/RemoteRedis.tsx`。本文保留重设计背景，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

Redis 管理器用于通过 SSH 访问远程 Redis，查看 key 空间、TTL、类型和值，执行受控命令并辅助缓存排障。

## 重新设计目标

- 避免用全量 keys 扫描破坏大实例体验。
- 把 key 浏览、值查看、命令控制台和风险操作拆清楚。
- 对不同 value 类型给出合适查看和编辑方式。
- 让 TTL、DB、连接目标始终清晰。

## 功能架构

### 连接与命名空间

- host、port、password、database、TLS 说明。
- 当前 DB、连接状态和断开。
- 数据库切换策略，避免用户不知自己在哪个 DB 操作。

### Key 浏览

- 模式搜索，优先 SCAN。
- key 类型、TTL、大小提示。
- 分页/继续扫描，而不是一次拉全量。
- 收藏常用 pattern 作为后续。

### 值查看与编辑

- string、hash、list、set、zset 分类型展示。
- JSON string 可格式化。
- TTL 展示与修改后续可加入。
- 保存和删除需确认。

### 命令控制台

- 执行 Redis 命令。
- 显示结果和错误。
- 高风险命令提示，例如 `FLUSHALL`、`DEL` 大批量操作。

## 交互设计

- 左侧 key 搜索和 key 列表。
- 右侧值查看区，下方或标签页为命令控制台。
- 顶部持续显示连接、DB、pattern 和刷新状态。
- Key 删除和值保存按钮保持明确，不和刷新混放。

## 数据与状态

```ts
interface RedisKeySummary {
  name: string;
  type: string;
  ttl: number;
  scannedAt: string;
}

interface RedisValueViewState {
  key: string;
  type: string;
  editable: boolean;
  draft?: string;
}
```

## 能力与集成设计

- SSH 隧道和 Redis 会话在 Rust 后端。
- IPC 层应区分 scan、read value、write value、command。
- 与系统监控保持边界，Redis 内存统计可作为后续 INFO 面板。
- 录制和日志不默认保存密码和值全文。

## 开发计划

1. 以 SCAN 思路重整 key 搜索模型。
2. 设计分类型 value viewer。
3. 增强保存、删除和危险命令确认。
4. 增加 INFO 摘要入口或预留。
5. 增加 JSON 值格式化。
6. 验证大 key 空间下列表体验。
7. 补断开、重连、命令错误测试。

## 验收标准

- Redis key 浏览不会依赖一次性全量加载。
- 不同类型值能合理查看。
- 值保存和删除有明确反馈。
- 当前 DB 和目标连接始终可见。
- 高风险命令有提示。

## 设计取舍

- 首版不把 Redis 管理器做成性能监控套件。
- 高级 stream、pubsub、cluster 可后续扩展。
- 大实例可用性优先于“列出所有 key”。
