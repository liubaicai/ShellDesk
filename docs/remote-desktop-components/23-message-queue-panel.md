# RabbitMQ / Kafka 简易面板功能设计与开发计划

## 定位

RabbitMQ / Kafka 简易面板用于查看消息队列的基础状态，例如 RabbitMQ 队列、consumer、消息堆积，以及 Kafka topic、partition、consumer lag。它面向排障和观察，不做完整管理控制台。

## 目标用户场景

- 查看 RabbitMQ 队列堆积。
- 查看 Kafka consumer group lag。
- 检查 broker/topic 是否存在。
- 复制诊断输出。
- 快速判断消费是否卡住。

## 首版功能范围

- RabbitMQ：
  - 通过 `rabbitmqctl` 或 Management HTTP API 查看队列。
  - 队列名、messages、consumers、state。
- Kafka：
  - 通过 `kafka-topics.sh`、`kafka-consumer-groups.sh`。
  - topic 列表、consumer group lag。
- 查询：
  - 刷新。
  - 搜索 queue/topic/group。

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

- `kafka-topics.sh --bootstrap-server <server> --list`。
- `kafka-consumer-groups.sh --bootstrap-server <server> --describe --all-groups`。

首版允许用户配置命令路径和 bootstrap server。

## IPC 与代码落点

首版复用 `runCommand`。不新增 Rabbit/Kafka Node 客户端依赖，降低复杂度。

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
6. 实现搜索、刷新、复制。
7. 增加工具不存在和权限错误提示。

## 验收标准

- RabbitMQ 主机能展示队列名称和堆积数。
- Kafka 环境能展示 topic 或 consumer lag。
- 工具路径错误时提示清晰。
- 输出解析失败时保留原始输出。
- 不执行删除队列/topic 等危险操作。

## 后续增强

- RabbitMQ exchange/binding。
- Kafka topic 创建和配置查看。
- 消息采样查看。
- 告警阈值卡片。
