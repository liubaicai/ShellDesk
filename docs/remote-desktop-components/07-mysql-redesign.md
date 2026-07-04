# MySQL 管理器组件重设计文档

> 当前状态：已接入远程桌面（appKey: `mysql`），实现入口为 `src/components/remote-desktop/RemoteMySQL.tsx`。本文保留重设计背景，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

MySQL 管理器用于通过 SSH 安全访问远程 MySQL 或兼容数据库，完成库表浏览、查询、数据检查和受控编辑。它应是轻量数据库工作台，而不是只包一层 SQL 文本框。

## 重新设计目标

- 让连接、库表导航、查询执行和结果查看形成完整工作流。
- 给查询和数据编辑足够安全边界，避免误更新。
- 支持多个查询上下文和结果查看，而不让一个表格承担全部。
- 与 PostgreSQL、SQLite 设计保持可复用模式，但保留 MySQL 特性。

## 功能架构

### 连接

- host、port、user、password、database、SSL/隧道说明。
- 连接状态、重连、断开、最近连接。
- 明确当前 SSH 连接和数据库目标的关系。

### 对象浏览

- 数据库、表、视图。
- 列、主键、索引摘要。
- 表数据浏览默认限制行数。
- 对象搜索和刷新。

### 查询与结果

- 多查询 tab 或 query tabs。
- SQL 编辑、执行、停止、查询历史。
- 结果表、消息、影响行数、执行耗时。
- 查询结果支持 JSON/CSV 导出。
- 支持 CSV（首行为列名）和 JSON 数组粘贴导入，按批生成 `INSERT` 并显示导入进度。

### 数据编辑

- 首版只对可识别主键的表提供单元格编辑。
- 更新前显示目标行和字段变化。
- 非主键或复杂结果集只读。

## 交互设计

- 左侧对象树。
- 中上 SQL 编辑区，标签化。
- 中下结果区，支持多个结果 tab。
- 顶部显示连接 badge、当前库、刷新、断开。
- 写操作结果必须突出 affected rows 和错误。

## 数据与状态

```ts
interface MysqlWorkspace {
  connectionId: string;
  mysqlSessionId: string;
  activeDatabase?: string;
  queryTabs: MysqlQueryTab[];
}

interface MysqlQueryTab {
  id: string;
  title: string;
  sql: string;
  running: boolean;
  resultId?: string;
}
```

## 能力与集成设计

- 数据库连接和隧道留在 Rust 后端。
- schema 查询和 SQL 查询通过类型化 IPC。
- 表格组件可和 PostgreSQL、SQLite 共用基础结果视图。
- 与文件管理器保持边界，数据库导出/导入在前端生成 SQL，经现有查询 IPC 执行。

## 开发计划

1. 统一数据库 workspace 交互模型。
2. 增强对象树到列、索引摘要。
3. 引入查询 tab 和结果 tab。
4. 增加查询历史、耗时和状态。
5. 强化单元格编辑确认和只读策略。
6. 抽取通用结果表格能力。
7. 补断开连接、查询错误和大结果集限制测试。

## 验收标准

- 能连接 MySQL 并浏览库表。
- 查询执行结果、耗时、错误信息清楚。
- 大表默认不会无限加载。
- 可编辑表的更新目标明确。
- 断开后数据库会话资源释放。

## 设计取舍

- 首版不做完整数据库建模工具。
- 批量导入导出保持轻量实现，不引入额外后端 IPC。
- 查询安全和结果可读性优先于功能堆叠。
