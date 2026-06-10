import { powershellCommand, powershellSingleQuote } from './remoteSystem';
import { tCurrent } from '../../i18n';

export interface RabbitQueueSummary {
  name: string;
  vhost?: string;
  messages: number;
  consumers: number;
  state?: string;
}

export interface KafkaTopicSummary {
  name: string;
}

export interface KafkaConsumerLag {
  group: string;
  topic: string;
  partition: number;
  currentOffset?: number;
  logEndOffset?: number;
  lag?: number;
  consumerId?: string;
  host?: string;
  clientId?: string;
}

export interface KafkaPartitionOffset {
  topic: string;
  partition: number;
  offset: number;
}

export interface KafkaTopicOffsetSummary {
  topic: string;
  partitionCount: number;
  earliestOffset: number;
  latestOffset: number;
  messageCount: number;
}

export interface KafkaSampleOptions {
  topicName: string;
  maxMessages: number;
  timeoutMs: number;
  fromBeginning: boolean;
}

export type KafkaCommandTarget =
  | { mode: 'host'; commandPath: string }
  | { mode: 'docker'; commandPath: string; containerName: string; dockerPath: string };

export const DEFAULT_KAFKA_TOPICS_PATH = '/opt/kafka/bin/kafka-topics.sh';
export const DEFAULT_KAFKA_CONSUMER_GROUPS_PATH = '/opt/kafka/bin/kafka-consumer-groups.sh';
export const DEFAULT_KAFKA_CONSOLE_CONSUMER_PATH = '/opt/kafka/bin/kafka-console-consumer.sh';
export const DEFAULT_KAFKA_GET_OFFSETS_PATH = '/opt/kafka/bin/kafka-get-offsets.sh';

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toNumber(value: unknown, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeCommandPath(value: string, fallback: string) {
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeRequiredValue(value: string, messageId: 'messageQueue.kafka.containerRequired' | 'messageQueue.kafka.topicRequired') {
  const trimmed = value.trim();

  if (!trimmed || /[\r\n]/.test(trimmed)) {
    throw new Error(tCurrent(messageId));
  }

  return trimmed;
}

function normalizeBoundedInteger(value: number, min: number, max: number, fallback: number) {
  const next = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(Math.max(next, min), max);
}

function normalizeUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');

  if (!trimmed || /[\r\n]/.test(trimmed)) {
    throw new Error(tCurrent('auto.messageQueueParsers.1ij6jbt'));
  }

  return trimmed;
}

function stripAnsi(value: string) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

export function formatRabbitCommandError(stdout: string, stderr: string, code: number) {
  const output = stripAnsi(stderr || stdout).trim();

  if (/Usage\s+rabbitmqctl/i.test(output)) {
    return tCurrent('auto.messageQueueParsers.6v3pbs');
  }

  return output || tCurrent('auto.messageQueueParsers.hd8mha', { value0: code });
}

export function createRabbitCtlCommand(commandPath: string, isWindowsHost: boolean) {
  const executable = normalizeCommandPath(commandPath, 'rabbitmqctl');

  if (isWindowsHost) {
    return powershellCommand(`& ${powershellSingleQuote(executable)} --quiet list_queues name messages consumers state`);
  }

  return `${shellSingleQuote(executable)} --quiet list_queues name messages consumers state`;
}

export function createRabbitManagementCommand(config: { url: string; username: string; password: string }, isWindowsHost: boolean) {
  const queuesUrl = `${normalizeUrl(config.url)}/api/queues`;
  const authText = config.username.trim() ? `${config.username.trim()}:${config.password}` : '';

  if (isWindowsHost) {
    const authArgs = authText ? `$curlArgs += @("-u", ${powershellSingleQuote(authText)})` : '';

    return powershellCommand(`
$curlArgs = @("-sS", "--max-time", "15")
${authArgs}
$curlArgs += @(${powershellSingleQuote(queuesUrl)})
& curl.exe @curlArgs
exit $LASTEXITCODE
`);
  }

  const authArgs = authText ? `-u ${shellSingleQuote(authText)}` : '';
  return `curl -sS --max-time 15 ${authArgs} ${shellSingleQuote(queuesUrl)}`;
}

function createKafkaCliCommand(target: KafkaCommandTarget, fallbackCommand: string, bootstrapServer: string, isWindowsHost: boolean, args: string[]) {
  const executable = normalizeCommandPath(target.commandPath, fallbackCommand);
  const server = bootstrapServer.trim() || '127.0.0.1:9092';
  const kafkaArgs = ['--bootstrap-server', server, ...args];

  if (target.mode === 'docker') {
    const dockerExecutable = normalizeCommandPath(target.dockerPath, 'docker');
    const containerName = normalizeRequiredValue(target.containerName, 'messageQueue.kafka.containerRequired');

    if (isWindowsHost) {
      const powershellArgs = kafkaArgs.map((arg) => powershellSingleQuote(arg)).join(' ');
      return powershellCommand(`& ${powershellSingleQuote(dockerExecutable)} exec ${powershellSingleQuote(containerName)} ${powershellSingleQuote(executable)} ${powershellArgs}`);
    }

    const shellArgs = kafkaArgs.map((arg) => shellSingleQuote(arg)).join(' ');
    return `${shellSingleQuote(dockerExecutable)} exec ${shellSingleQuote(containerName)} ${shellSingleQuote(executable)} ${shellArgs}`;
  }

  if (isWindowsHost) {
    const powershellArgs = kafkaArgs.map((arg) => powershellSingleQuote(arg)).join(' ');
    return powershellCommand(`& ${powershellSingleQuote(executable)} ${powershellArgs}`);
  }

  const shellArgs = kafkaArgs.map((arg) => shellSingleQuote(arg)).join(' ');
  return `${shellSingleQuote(executable)} ${shellArgs}`;
}

export function createKafkaTopicsCommand(target: KafkaCommandTarget, bootstrapServer: string, isWindowsHost: boolean) {
  return createKafkaCliCommand(target, DEFAULT_KAFKA_TOPICS_PATH, bootstrapServer, isWindowsHost, ['--list']);
}

export function createKafkaLagCommand(target: KafkaCommandTarget, bootstrapServer: string, isWindowsHost: boolean) {
  return createKafkaCliCommand(target, DEFAULT_KAFKA_CONSUMER_GROUPS_PATH, bootstrapServer, isWindowsHost, ['--describe', '--all-groups']);
}

export function createKafkaOffsetsCommand(target: KafkaCommandTarget, bootstrapServer: string, topicName: string, offsetTime: '-1' | '-2', isWindowsHost: boolean) {
  const normalizedTopic = normalizeRequiredValue(topicName, 'messageQueue.kafka.topicRequired');

  return createKafkaCliCommand(target, DEFAULT_KAFKA_GET_OFFSETS_PATH, bootstrapServer, isWindowsHost, ['--topic', normalizedTopic, '--time', offsetTime]);
}

export function createKafkaSampleCommand(target: KafkaCommandTarget, bootstrapServer: string, options: KafkaSampleOptions, isWindowsHost: boolean) {
  const topicName = normalizeRequiredValue(options.topicName, 'messageQueue.kafka.topicRequired');
  const maxMessages = normalizeBoundedInteger(options.maxMessages, 1, 100, 20);
  const timeoutMs = normalizeBoundedInteger(options.timeoutMs, 1000, 60000, 10000);

  return createKafkaCliCommand(
    target,
    DEFAULT_KAFKA_CONSOLE_CONSUMER_PATH,
    bootstrapServer,
    isWindowsHost,
    [
      '--topic',
      topicName,
      ...(options.fromBeginning ? ['--from-beginning'] : []),
      '--consumer-property',
      'enable.auto.commit=false',
      '--max-messages',
      String(maxMessages),
      '--timeout-ms',
      String(timeoutMs),
    ],
  );
}

export function parseRabbitCtlQueues(stdout: string): RabbitQueueSummary[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^name\s+messages\s+consumers\s+state$/i.test(line))
    .map((line) => {
      const parts = line.split(/\s+/);
      const state = parts.pop() ?? '';
      const consumers = toNumber(parts.pop());
      const messages = toNumber(parts.pop());
      const name = parts.join(' ') || '-';

      return { name, messages, consumers, state };
    });
}

export function parseRabbitManagementQueues(stdout: string): RabbitQueueSummary[] {
  const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;

  if (!Array.isArray(rows)) {
    throw new Error(tCurrent('auto.messageQueueParsers.e8ywwx'));
  }

  return rows.map((row) => ({
    name: String(row.name ?? ''),
    vhost: String(row.vhost ?? ''),
    messages: toNumber(row.messages),
    consumers: toNumber(row.consumers),
    state: row.state ? String(row.state) : undefined,
  })).filter((queue) => queue.name);
}

export function parseKafkaTopics(stdout: string): KafkaTopicSummary[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^__consumer_offsets$/.test(line))
    .map((name) => ({ name }));
}

export function parseKafkaLag(stdout: string): KafkaConsumerLag[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^GROUP\s+TOPIC\s+PARTITION/i.test(line))
    .map((line) => {
      const parts = line.split(/\s+/);
      const [group = '', topic = '', partition = '', currentOffset = '', logEndOffset = '', lag = '', consumerId = '', host = '', clientId = ''] = parts;

      return {
        group,
        topic,
        partition: toNumber(partition),
        currentOffset: currentOffset === '-' ? undefined : toNumber(currentOffset),
        logEndOffset: logEndOffset === '-' ? undefined : toNumber(logEndOffset),
        lag: lag === '-' ? undefined : toNumber(lag),
        consumerId,
        host,
        clientId,
      };
    })
    .filter((item) => item.group && item.topic);
}

export function parseKafkaPartitionOffsets(stdout: string): KafkaPartitionOffset[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [topic = '', partition = '', offset = ''] = line.split(':');

      return {
        topic,
        partition: toNumber(partition, -1),
        offset: toNumber(offset, -1),
      };
    })
    .filter((item) => item.topic && item.partition >= 0 && item.offset >= 0);
}

export function summarizeKafkaTopicOffsets(earliestOffsets: KafkaPartitionOffset[], latestOffsets: KafkaPartitionOffset[]): KafkaTopicOffsetSummary | null {
  const latestByPartition = new Map<number, KafkaPartitionOffset>();
  latestOffsets.forEach((offset) => latestByPartition.set(offset.partition, offset));

  let earliestOffsetTotal = 0;
  let latestOffsetTotal = 0;
  let messageCount = 0;
  let topic = latestOffsets[0]?.topic ?? earliestOffsets[0]?.topic ?? '';

  earliestOffsets.forEach((earliest) => {
    const latest = latestByPartition.get(earliest.partition);
    if (!latest) return;
    topic = topic || latest.topic || earliest.topic;
    earliestOffsetTotal += earliest.offset;
    latestOffsetTotal += latest.offset;
    messageCount += Math.max(latest.offset - earliest.offset, 0);
  });

  if (!topic || latestByPartition.size === 0) {
    return null;
  }

  return {
    topic,
    partitionCount: latestByPartition.size,
    earliestOffset: earliestOffsetTotal,
    latestOffset: latestOffsetTotal,
    messageCount,
  };
}

export function parseKafkaSampleMessages(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .filter((line) => !/^Processed a total of \d+ messages?\.?$/i.test(line.trim()));
}
