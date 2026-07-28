# RabbitMQ / Kafka 简易面板功能设计与开发计划

<!-- current-implementation:start -->
## 当前实现状态

- 接入状态：已接入远程桌面目录，appKey 为 `message-queue`；注册、窗口、图标、翻译和渲染分支由合同检查覆盖。
- 能力声明：平台 `linux / windows / macos`；模式 `network-client`；权限 `user`。
- 依赖探测：Linux `—`；Windows `—`；macOS `—`。存在依赖时由 Launchpad 连接级探测并显示缺失原因。
- 验证边界：启动合同为 `automated-contract`；完整业务流程仍为 `environment-required`，没有真实主机证据时不得写成已验证通过。
- 最后同步：2026-07-28；详见[能力与验证矩阵](../remote-desktop-capability-matrix.md)。
<!-- current-implementation:end -->

> 当前状态：已接入远程桌面（appKey: `message-queue`），实现入口为 `src/components/remote-desktop/RemoteMessageQueuePanel.tsx`。本文保留设计计划和验收标准，维护时以当前实现、`RemoteDesktopShell.tsx` 注册表和 `_example.md` 清单为准。

## 定位

RabbitMQ / Kafka 简易面板用于查看消息队列的基础状态，例如 RabbitMQ 队列、consumer、消息堆积，以及 Kafka topic、partition、consumer lag。它面向排障和观察，不做完整管理控制台。

## 目标用户场景

- 查看 RabbitMQ 队列堆积。
- 查看 Kafka consumer group lag。
- 检查 broker/topic 是否存在。
- 采样查看 Kafka topic 消息内容。
- 复制诊断输出。
- 快速判断消费是否卡住。

## 首版功能范围

- RabbitMQ：
  - 通过 `rabbitmqctl` 或 Management HTTP API 查看队列。
  - 队列名、messages、consumers、state。
- Kafka：
  - 默认通过 `/opt/kafka/bin/kafka-topics.sh`、`/opt/kafka/bin/kafka-consumer-groups.sh`。
  - topic 列表、consumer group lag。
  - 通过 `/opt/kafka/bin/kafka-get-offsets.sh` 查询选中 topic 的 earliest/latest offset，计算 broker 侧消息数。
  - 通过 `/opt/kafka/bin/kafka-console-consumer.sh` 对选中 topic 做只读消息采样。
- 查询：
  - 刷新。
  - 搜索 queue/topic/group/message。

## 交互设计

顶部选择后端：RabbitMQ 或 Kafka。主体按后端显示：

- RabbitMQ：队列表格 + 详情。
- Kafka：topic 表格 + consumer group lag 表格。

未检测到工具时显示配置指引，例如填写 Management API URL 或 Kafka bin 路径。

## 数据模型

```ts
interface RabbitQueueSummary {
  name: string;
  vhost?: string;
  messages: number;
  consumers: number;
  state?: string;
}

interface KafkaConsumerLag {
  group: string;
  topic: string;
  partition: number;
  currentOffset?: number;
  logEndOffset?: number;
  lag?: number;
}
```

## 远程命令设计

RabbitMQ：

- `rabbitmqctl list_queues name messages consumers state`。
- Management API：`curl -u user:pass http://127.0.0.1:15672/api/queues`。

Kafka：

- `/opt/kafka/bin/kafka-topics.sh --bootstrap-server <server> --list`。
- `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server <server> --describe --all-groups`。
- `/opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server <server> --topic <topic> --time -2` 与 `--time -1`，用 latest - earliest 汇总 broker 侧消息数。
- `/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server <server> --topic <topic> --max-messages <n> --timeout-ms <ms>`。
- Docker 容器模式：`docker exec <container> /opt/kafka/bin/kafka-topics.sh --bootstrap-server <server> --list`，consumer group lag 同理。

Kafka 允许用户选择宿主机或 Docker 容器执行方式，并配置命令路径、bootstrap server、Docker 命令路径和容器名/ID。容器模式下 Kafka CLI 路径表示容器内部的命令名或绝对路径。消息采样不指定 consumer group，不提交业务 consumer offset，并限制采样条数与超时。

## IPC 与代码落点

首版复用 `runCommand`。不新增 Rabbit/Kafka 前端客户端依赖，降低复杂度。

文件建议：

- `src/components/remote-desktop/RemoteMessageQueuePanel.tsx`
- `src/components/remote-desktop/messageQueueParsers.ts`
- `src/styles/remote-desktop/_message-queue.scss`
- `src/components/remote-desktop/index.ts`
- `src/RemoteDesktopShell.tsx`
- `src/styles/index.scss`

## 开发计划

1. 实现后端选择和配置表单。
2. 实现 RabbitMQ `rabbitmqctl` 队列解析。
3. 实现 RabbitMQ Management API 可选路径。
4. 实现 Kafka topic 列表。
5. 实现 Kafka consumer group lag 解析。
6. 实现 Kafka topic 消息采样。
7. 实现搜索、刷新、复制。
8. 增加工具不存在和权限错误提示。

## 验收标准

- RabbitMQ 主机能展示队列名称和堆积数。
- Kafka 环境能展示 topic 或 consumer lag。
- Kafka 环境能对选中 topic 采样显示消息内容。
- 工具路径错误时提示清晰。
- 输出解析失败时保留原始输出。
- 不执行删除队列/topic 等危险操作。

## 后续增强

- RabbitMQ exchange/binding。
- Kafka topic 创建和配置查看。
- 消息采样查看。
- 告警阈值卡片。
