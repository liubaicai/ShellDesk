# MongoDB 管理器功能设计与开发计划

<!-- current-implementation:start -->
## 当前实现状态

- 接入状态：已接入远程桌面目录，appKey 为 `mongo`；注册、窗口、图标、翻译和渲染分支由合同检查覆盖。
- 能力声明：平台 `linux / windows / macos`；模式 `network-client`；权限 `user`。
- 依赖探测：Linux `—`；Windows `—`；macOS `—`。存在依赖时由 Launchpad 连接级探测并显示缺失原因。
- 验证边界：启动合同为 `automated-contract`；完整业务流程仍为 `environment-required`，没有真实主机证据时不得写成已验证通过。
- 最后同步：2026-07-28；详见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
<!-- current-implementation:end -->

> 当前状态：已接入远程桌面（appKey: `mongo`），实现入口为 `src/components/remote-desktop/RemoteMongo.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

MongoDB 管理器用于通过 SSH 隧道连接远程 MongoDB，查看数据库、集合、文档和索引。它补充现有关系型数据库与键值数据库管理能力。

## 目标用户场景

- 连接远程 MongoDB。
- 查看数据库和集合。
- 查询文档。
- 查看索引。
- 编辑或复制单个文档。

## 首版功能范围

- 连接：
  - host、port、username、password、authSource。
  - 默认 `127.0.0.1:27017`。
- 浏览：
  - 数据库列表。
  - 集合列表。
  - 文档列表，默认 limit 100。
- 查询：
  - JSON filter。
  - projection、sort、limit。
- 详情：
  - 文档 JSON 格式化查看。
  - 索引列表。

## 交互设计

可借鉴 Redis/Mysql：

- 未连接：连接卡片。
- 已连接：
  - 左侧数据库/集合树。
  - 顶部查询编辑区。
  - 主区域文档列表。
  - 右侧文档详情。

编辑文档首版可以只读，避免 `_id`、嵌套字段和类型转换复杂度。

## 数据模型

```ts
interface MongoConnectConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  authSource?: string;
  mongoId?: string;
}

interface MongoQueryRequest {
  database: string;
  collection: string;
  filter: string;
  projection?: string;
  sort?: string;
  limit: number;
}
```

## IPC 与 Rust 后端设计

当前 Tauri 版本把数据库能力放在 Rust 后端。MongoDB 通过 `src-tauri/src/database/mongo.rs` 和 `src-tauri/src/database/tunnel.rs` 维护会话配置、隧道连接、数据库/集合/索引查询和文档操作。

新增 IPC：

- `connection:mongo-connect`
- `connection:mongo-disconnect`
- `connection:mongo-databases`
- `connection:mongo-collections`
- `connection:mongo-indexes`
- `connection:mongo-query`

同步修改 `src-tauri/src/database/mongo.rs`、`src-tauri/src/database/tunnel.rs`、`src-tauri/src/ipc/database_channels.rs`、`src/tauriBridge.ts`、`src/vite-env.d.ts`。

## 代码落点

- `src-tauri/src/database/mongo.rs`
- `src-tauri/src/database/tunnel.rs`
- `src-tauri/src/ipc.rs`
- `src/tauriBridge.ts`
- `src/vite-env.d.ts`
- `src/components/remote-desktop/RemoteMongo.tsx`
- `src/styles/remote-desktop/_mongo.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`
- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（仅在需要新增 Rust 依赖时）

## 开发计划

1. 设计 Rust 后端 MongoDB 会话并实现连接验证。
2. 实现数据库和集合列表 IPC。
3. 实现文档查询和 JSON 序列化。
4. 实现索引列表。
5. 实现前端连接卡片和对象树。
6. 实现查询编辑和结果展示。
7. 补错误处理和断开清理。

## 验收标准

- 能通过 SSH 隧道连接 MongoDB。
- 能列出数据库和集合。
- 能执行 JSON filter 查询。
- 查询错误显示 MongoDB 错误信息。
- 断开后 Rust 后端连接清理。

## 后续增强

- 文档编辑。
- 聚合管道。
- explain。
- 导入导出 JSON。
