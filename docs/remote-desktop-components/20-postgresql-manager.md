# PostgreSQL 管理器功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `postgres`），实现入口为 `src/components/remote-desktop/RemotePostgres.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

PostgreSQL 管理器用于补齐 ShellDesk 的数据库管理能力。当前已有 MySQL、Redis、SQLite，PostgreSQL 是最自然的下一类数据库组件。

## 目标用户场景

- 通过 SSH 隧道连接远程 PostgreSQL。
- 查看数据库、schema、表、视图。
- 执行 SQL 查询并查看结果。
- 查看表结构、索引、主键。
- 轻量编辑单元格或复制查询结果。

## 首版功能范围

- 连接表单：
  - host、port、user、password、database。
  - 默认 `127.0.0.1:5432`。
- 对象树：
  - database。
  - schema。
  - table/view。
- 查询编辑器：
  - SQL 输入。
  - Ctrl+Enter 执行。
  - 结果表格。
- 表浏览：
  - 选择表后默认 `SELECT * LIMIT 500`。
  - 查看列信息。
- 连接生命周期：
  - 连接、断开、错误提示。

## 交互设计

整体可复用 MySQL 管理器的信息架构：

- 未连接：居中连接卡片。
- 已连接：
  - 左侧对象树。
  - 中上 SQL 编辑器。
  - 中下结果表格。
  - 顶部显示当前连接和数据库。

为避免和 MySQL 代码重复，开发时可以抽出数据库通用结果表格和分页组件，但不强制第一版就大拆。

## 数据模型

```ts
interface PostgresConnectConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  postgresId?: string;
}

interface PostgresColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey?: boolean;
}

interface PostgresQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount?: number;
}
```

## IPC 与 Rust 后端设计

当前 Tauri 版本把数据库能力放在 Rust 后端。PostgreSQL 首版通过远程 `psql`/CLI 路径执行结构查询和 SQL 查询，并由 `src-tauri/src/database.rs` 维护会话配置，模式参考当前 MySQL 实现。

新增 IPC：

- `connection:postgres-connect`
- `connection:postgres-disconnect`
- `connection:postgres-databases`
- `connection:postgres-schemas`
- `connection:postgres-tables`
- `connection:postgres-columns`
- `connection:postgres-query`
- 可选 `connection:postgres-update-cell`

同步修改：

- `src-tauri/src/database.rs`
- `src-tauri/src/ipc.rs`
- `src/tauriBridge.ts`
- `src/vite-env.d.ts`

## SQL 查询设计

数据库列表：

```sql
SELECT datname FROM pg_database
WHERE datistemplate = false
ORDER BY datname;
```

schema：

```sql
SELECT schema_name FROM information_schema.schemata
WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
ORDER BY schema_name;
```

表：

```sql
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema = $1
ORDER BY table_name;
```

列：

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = $1 AND table_name = $2
ORDER BY ordinal_position;
```

## 代码落点

- `src/components/remote-desktop/RemotePostgres.tsx`
- `src/styles/remote-desktop/_postgres.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`
- `src-tauri/src/database.rs`
- `src-tauri/src/ipc.rs`
- `src/tauriBridge.ts`
- `src/vite-env.d.ts`
- `src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock`（仅在需要新增 Rust 依赖时）

## 开发计划

1. 设计 Rust 后端会话 Map。
2. 实现连接验证和断开。
3. 实现数据库、schema、表、列查询 IPC。
4. 实现前端连接卡片和对象树。
5. 实现 SQL 编辑器和结果表格。
6. 实现表浏览默认查询。
7. 补错误处理、断开清理和构建类型。

## 验收标准

- 能通过 SSH 隧道连接本机 PostgreSQL。
- 能列出数据库、schema、表和列。
- 能执行 SELECT 查询并展示结果。
- SQL 错误能展示 PostgreSQL 返回信息。
- 断开连接后 Rust 后端会话清理。
- `pnpm build` 通过。

## 后续增强

- 单元格编辑。
- Explain 计划查看。
- 索引、约束、函数、视图详情。
- 查询历史。
- CSV 导出。
