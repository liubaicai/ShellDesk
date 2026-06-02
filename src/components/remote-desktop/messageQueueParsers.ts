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

export function createKafkaTopicsCommand(commandPath: string, bootstrapServer: string, isWindowsHost: boolean) {
  const executable = normalizeCommandPath(commandPath, 'kafka-topics.sh');
  const server = bootstrapServer.trim() || '127.0.0.1:9092';

  if (isWindowsHost) {
    return powershellCommand(`& ${powershellSingleQuote(executable)} --bootstrap-server ${powershellSingleQuote(server)} --list`);
  }

  return `${shellSingleQuote(executable)} --bootstrap-server ${shellSingleQuote(server)} --list`;
}

export function createKafkaLagCommand(commandPath: string, bootstrapServer: string, isWindowsHost: boolean) {
  const executable = normalizeCommandPath(commandPath, 'kafka-consumer-groups.sh');
  const server = bootstrapServer.trim() || '127.0.0.1:9092';

  if (isWindowsHost) {
    return powershellCommand(`& ${powershellSingleQuote(executable)} --bootstrap-server ${powershellSingleQuote(server)} --describe --all-groups`);
  }

  return `${shellSingleQuote(executable)} --bootstrap-server ${shellSingleQuote(server)} --describe --all-groups`;
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
