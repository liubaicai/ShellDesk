# ClickHouse 管理器

> 当前状态：已接入远程桌面（appKey: `clickhouse`），实现入口为 `src/components/remote-desktop/RemoteClickHouse.tsx`。本文保留当前实现范围和设计取舍，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

ClickHouse 管理器用于通过当前 SSH 连接访问远程 ClickHouse HTTP 接口，完成数据库与表浏览、列信息查看、SQL 查询、表结构编辑、CSV/JSON 数据导入和表数据预览。它复用 MySQL 管理器的信息架构，但按 ClickHouse 的 HTTP API、列式存储和 mutation 特性保持结果集编辑边界。

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
  - 侧边栏提供可视化新建表入口，生成 `CREATE TABLE` 并通过 `connection:clickhouse-query` 执行。
- 新建表：
  - 支持常用引擎选择、排序键 `ORDER BY` 多选、可选分区表达式 `PARTITION BY` 和表注释。
  - 字段支持类型、Nullable、DEFAULT 表达式、CODEC 和注释。
- 编辑表结构：
  - 表右键菜单提供“编辑表结构”，通过 `SHOW CREATE TABLE` 读取当前建表 SQL 并复用建表对话框填充字段。
  - 支持生成并逐条执行 `ADD COLUMN`、`DROP COLUMN`、`MODIFY COLUMN`、`MODIFY ORDER BY` 和 `MODIFY COMMENT`。
  - ClickHouse 不能直接 ALTER 的 `ENGINE` 与 `PARTITION BY` 只展示当前值，不生成修改语句。
- 查询工作台：
  - 多查询 tab。
  - SQL 执行、耗时、结果 tab、分页和执行历史。
  - 查询默认数据库通过 ClickHouse HTTP `database` 参数传递。
- 数据导入：
  - 支持从 CSV 粘贴和 JSON 数组粘贴导入，CSV 首行作为列名。
  - 导入目标可从已加载表列表选择，也可跟随 SQL 编辑器当前选中的表。
  - 批量生成 `INSERT INTO db.table (...) FORMAT Values ...` 并通过 `connection:clickhouse-query` 执行。
- 表预览：
  - 选择表后默认执行 `SELECT * FROM db.table LIMIT 50`。
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

- `src-tauri/src/database/clickhouse.rs`
- `src-tauri/src/database/tunnel.rs`
- `src-tauri/src/ipc.rs`
- `src/tauriBridge.ts`
- `src/vite-env.d.ts`
- `src/components/remote-desktop/RemoteClickHouse.tsx`
- `src/styles/remote-desktop/_clickhouse.scss`
- `src/RemoteDesktopShell.tsx`
- `src/assets/desktop-icons/clickhouse.png`

## 设计取舍

- 首版不提供 MySQL 式单元格编辑。ClickHouse 的 `ALTER TABLE ... UPDATE` 是异步 mutation，行定位和更新确认需要单独设计。
- 当前 schema 管理覆盖可视化建表和部分可 ALTER 的表结构编辑；暂不提供引擎/分区修改和查询取消。
- 单次 HTTP 响应限制为 25MB，超过后提示缩小查询范围。
