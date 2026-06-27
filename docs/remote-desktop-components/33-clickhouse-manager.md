# ClickHouse 管理器

> 当前状态：已接入远程桌面（appKey: `clickhouse`），实现入口为 `src/components/remote-desktop/RemoteClickHouse.tsx`。本文保留当前实现范围和设计取舍，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

ClickHouse 管理器用于通过当前 SSH 连接访问远程 ClickHouse HTTP 接口，完成数据库与表浏览、列信息查看、SQL 查询和表数据预览。它复用 MySQL 管理器的信息架构，但按 ClickHouse 的 HTTP API、列式存储和 mutation 特性保持首版只读结果集。

## 当前实现范围

- 连接表单：
  - host、HTTP port、user、password、default database。
  - 默认 `127.0.0.1:8123`，勾选 HTTPS / TLS 后默认 `8443`。
- SSH 传输：
  - Rust 后端通过当前连接执行远程 HTTP/CLI 访问 ClickHouse。
  - 不新增前端 ClickHouse 客户端依赖，后端统一返回 JSON 结果。
- 对象浏览：
  - 数据库列表来自 `system.databases`。
  - 表列表来自 `system.tables`，展示 engine、行数和容量摘要。
  - 列列表来自 `system.columns`，展示类型、主键和排序键标记。
- 查询工作台：
  - 多查询 tab。
  - SQL 执行、耗时、结果 tab、分页和执行历史。
  - 查询默认数据库通过 ClickHouse HTTP `database` 参数传递。
- 表预览：
  - 选择表后默认执行 `SELECT * FROM db.table LIMIT 500`。
  - 结果表格分页显示，每页 100 行。
- 连接生命周期：
  - 窗口卸载或断开时清理 Rust 后端会话配置。
  - 主连接关闭时通过 `registerConnectionCleanup` 移除 ClickHouse 会话。

## IPC

- `connection:clickhouse-connect`
- `connection:clickhouse-disconnect`
- `connection:clickhouse-databases`
- `connection:clickhouse-tables`
- `connection:clickhouse-columns`
- `connection:clickhouse-query`

## 代码落点

- `src-tauri/src/database.rs`
- `src-tauri/src/ipc.rs`
- `src/tauriBridge.ts`
- `src/vite-env.d.ts`
- `src/components/remote-desktop/RemoteClickHouse.tsx`
- `src/styles/remote-desktop/_clickhouse.scss`
- `src/RemoteDesktopShell.tsx`
- `src/assets/desktop-icons/clickhouse.png`

## 设计取舍

- 首版不提供 MySQL 式单元格编辑。ClickHouse 的 `ALTER TABLE ... UPDATE` 是异步 mutation，行定位和更新确认需要单独设计。
- 首版不做完整 schema 管理、导入导出和查询取消。
- 单次 HTTP 响应限制为 25MB，超过后提示缩小查询范围。
