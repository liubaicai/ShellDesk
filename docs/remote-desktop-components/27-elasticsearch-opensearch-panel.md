# Elasticsearch / OpenSearch 面板功能设计与开发计划

> 当前状态：已接入远程桌面（appKey: `search-cluster`），实现入口为 `src/components/remote-desktop/RemoteSearchCluster.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

Elasticsearch / OpenSearch 面板用于查看搜索集群健康、节点、索引、分片和执行基础查询。它面向运维排查，不试图替代 Kibana 或 OpenSearch Dashboards。

## 目标用户场景

- 检查集群健康是否 green/yellow/red。
- 查看索引大小、文档数、状态。
- 查看分片分布。
- 执行 `_search` 查询。
- 复制诊断结果。

## 首版功能范围

- 连接：
  - URL、用户名、密码。
  - 默认 `http://127.0.0.1:9200`。
- 概览：
  - cluster health。
  - 节点数量、索引数量。
- 索引：
  - `_cat/indices`。
  - 搜索、排序。
- 查询：
  - index + JSON body。
  - 查看响应 JSON。

## 交互设计

界面分为：

- 顶部连接栏和健康状态。
- 左侧索引列表。
- 右侧 tabs：概览、分片、查询、原始响应。

健康状态用清晰颜色和文字，不依赖单一颜色表达。

## 远程请求设计

首版可以通过远程 `curl` 请求集群：

- `GET /_cluster/health`
- `GET /_cat/indices?format=json&bytes=b`
- `GET /_cat/shards?format=json`
- `POST /<index>/_search`

如果需要认证：

- curl `-u user:password`。

复杂 body 处理同 API 调试器，可用临时文件或 here-doc。

## IPC 与代码落点

首版复用 `runCommand`，无需新增前端客户端依赖。后续如果要更强体验，可新增 Rust 后端 HTTP over SSH 能力。

文件建议：

- `src/components/remote-desktop/RemoteSearchCluster.tsx`
- `src/components/remote-desktop/searchClusterUtils.ts`
- `src/styles/remote-desktop/_search-cluster.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现连接表单和 health 请求。
2. 实现索引列表。
3. 实现分片列表。
4. 实现基础 `_search` 查询。
5. 实现响应 JSON 格式化。
6. 增加认证和错误提示。
7. 兼容 Elasticsearch/OpenSearch 返回差异。

## 验收标准

- 能连接本机 9200 集群。
- 能显示 health 和索引列表。
- 能对指定索引执行 search。
- JSON body 错误有提示。
- 认证失败能清晰展示。

## 后续增强

- 节点详情。
- 索引 settings/mappings。
- 慢查询和任务查看。
- 快照仓库管理。
