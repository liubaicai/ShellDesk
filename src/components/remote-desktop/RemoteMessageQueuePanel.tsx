import { useEffect, useMemo, useState } from 'react';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { loadRemoteConnectionProfile, readProfileBoolean, readProfileString, saveRemoteConnectionProfile } from './remoteConnectionProfiles';
import {
  createKafkaSampleCommand,
  createKafkaLagCommand,
  createKafkaOffsetsCommand,
  createKafkaTopicsCommand,
  createRabbitCtlCommand,
  createRabbitManagementCommand,
  DEFAULT_KAFKA_CONSOLE_CONSUMER_PATH,
  DEFAULT_KAFKA_CONSUMER_GROUPS_PATH,
  DEFAULT_KAFKA_GET_OFFSETS_PATH,
  DEFAULT_KAFKA_TOPICS_PATH,
  formatRabbitCommandError,
  parseKafkaLag,
  parseKafkaPartitionOffsets,
  parseKafkaSampleMessages,
  parseKafkaTopics,
  parseRabbitCtlQueues,
  parseRabbitManagementQueues,
  summarizeKafkaTopicOffsets,
  type KafkaCommandTarget,
  type KafkaConsumerLag,
  type KafkaTopicSummary,
  type KafkaTopicOffsetSummary,
  type RabbitQueueSummary,
} from './messageQueueParsers';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface RemoteMessageQueuePanelProps {
  connectionId: string;
  hostId: string;
  systemType?: RemoteSystemType;
}

type QueueBackend = 'rabbitmq' | 'kafka';
type RabbitMode = 'rabbitmqctl' | 'management-api';
type KafkaExecutionMode = KafkaCommandTarget['mode'];
type QueueTab = 'queues' | 'topics' | 'lag' | 'messages' | 'raw';

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error(tCurrent('auto.remoteMessageQueuePanel.g77vf3'));
  }

  return api.runCommand(connectionId, command);
}

function formatNumber(value?: number) {
  if (value === undefined || Number.isNaN(value)) return '-';
  return value.toLocaleString(getShellDeskLocale());
}

function createKafkaCommandTarget(mode: KafkaExecutionMode, commandPath: string, containerName: string, dockerPath: string): KafkaCommandTarget {
  return mode === 'docker'
    ? { mode, commandPath, containerName, dockerPath }
    : { mode, commandPath };
}

function RemoteMessageQueuePanel({ connectionId, hostId, systemType }: RemoteMessageQueuePanelProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [backend, setBackend] = useState<QueueBackend>('rabbitmq');
  const [rabbitMode, setRabbitMode] = useState<RabbitMode>('rabbitmqctl');
  const [rabbitCtlPath, setRabbitCtlPath] = useState('rabbitmqctl');
  const [rabbitApiUrl, setRabbitApiUrl] = useState('http://127.0.0.1:15672');
  const [rabbitUser, setRabbitUser] = useState('guest');
  const [rabbitPassword, setRabbitPassword] = useState('guest');
  const [kafkaBootstrap, setKafkaBootstrap] = useState('127.0.0.1:9092');
  const [kafkaMode, setKafkaMode] = useState<KafkaExecutionMode>('host');
  const [kafkaDockerPath, setKafkaDockerPath] = useState('docker');
  const [kafkaContainerName, setKafkaContainerName] = useState('');
  const [kafkaTopicsPath, setKafkaTopicsPath] = useState(DEFAULT_KAFKA_TOPICS_PATH);
  const [kafkaGroupsPath, setKafkaGroupsPath] = useState(DEFAULT_KAFKA_CONSUMER_GROUPS_PATH);
  const [kafkaConsumerPath, setKafkaConsumerPath] = useState(DEFAULT_KAFKA_CONSOLE_CONSUMER_PATH);
  const [kafkaOffsetsPath, setKafkaOffsetsPath] = useState(DEFAULT_KAFKA_GET_OFFSETS_PATH);
  const [sampleMaxMessages, setSampleMaxMessages] = useState('20');
  const [sampleTimeoutMs, setSampleTimeoutMs] = useState('10000');
  const [sampleFromBeginning, setSampleFromBeginning] = useState(false);
  const [queues, setQueues] = useState<RabbitQueueSummary[]>([]);
  const [topics, setTopics] = useState<KafkaTopicSummary[]>([]);
  const [lags, setLags] = useState<KafkaConsumerLag[]>([]);
  const [topicOffsets, setTopicOffsets] = useState<Record<string, KafkaTopicOffsetSummary>>({});
  const [sampleMessages, setSampleMessages] = useState<string[]>([]);
  const [selectedQueueName, setSelectedQueueName] = useState('');
  const [selectedTopicName, setSelectedTopicName] = useState('');
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<QueueTab>('queues');
  const [rawOutput, setRawOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sampling, setSampling] = useState(false);
  const [offsetLoading, setOffsetLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState('');

  const filteredQueues = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return keyword ? queues.filter((queue) => queue.name.toLowerCase().includes(keyword) || queue.vhost?.toLowerCase().includes(keyword)) : queues;
  }, [queues, search]);

  const filteredTopics = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return keyword ? topics.filter((topic) => topic.name.toLowerCase().includes(keyword)) : topics;
  }, [topics, search]);

  const filteredLags = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return keyword
      ? lags.filter((lag) => [lag.group, lag.topic, lag.consumerId, lag.host, lag.clientId].some((value) => value?.toLowerCase().includes(keyword)))
      : lags;
  }, [lags, search]);

  const filteredSampleMessages = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return keyword ? sampleMessages.filter((message) => message.toLowerCase().includes(keyword)) : sampleMessages;
  }, [sampleMessages, search]);

  const selectedQueue = useMemo(() => queues.find((queue) => queue.name === selectedQueueName) ?? queues[0] ?? null, [queues, selectedQueueName]);
  const selectedTopic = useMemo(() => topics.find((topic) => topic.name === selectedTopicName) ?? topics[0] ?? null, [selectedTopicName, topics]);
  const lagForSelectedTopic = useMemo(() => selectedTopic ? lags.filter((lag) => lag.topic === selectedTopic.name) : [], [lags, selectedTopic]);
  const lagRowsByTopic = useMemo(() => {
    const next: Record<string, number> = {};
    lags.forEach((lag) => {
      next[lag.topic] = (next[lag.topic] ?? 0) + 1;
    });
    return next;
  }, [lags]);
  const selectedTopicOffsets = selectedTopic ? topicOffsets[selectedTopic.name] : undefined;
  const totalRabbitMessages = useMemo(() => queues.reduce((sum, queue) => sum + queue.messages, 0), [queues]);
  const totalLag = useMemo(() => lags.reduce((sum, lag) => sum + (lag.lag ?? 0), 0), [lags]);

  useEffect(() => {
    let disposed = false;

    void loadRemoteConnectionProfile(hostId, 'message-queue').then((profile) => {
      if (disposed || !profile) return;

      const nextBackend = readProfileString(profile, 'backend', 'rabbitmq');
      const nextRabbitMode = readProfileString(profile, 'rabbitMode', 'rabbitmqctl');
      const nextKafkaMode = readProfileString(profile, 'kafkaMode', 'host');

      setBackend(nextBackend === 'kafka' ? 'kafka' : 'rabbitmq');
      setRabbitMode(nextRabbitMode === 'management-api' ? 'management-api' : 'rabbitmqctl');
      setRabbitCtlPath(readProfileString(profile, 'rabbitCtlPath', 'rabbitmqctl'));
      setRabbitApiUrl(readProfileString(profile, 'rabbitApiUrl', 'http://127.0.0.1:15672'));
      setRabbitUser(readProfileString(profile, 'rabbitUser', 'guest'));
      setRabbitPassword(readProfileString(profile, 'rabbitPassword', 'guest'));
      setKafkaBootstrap(readProfileString(profile, 'kafkaBootstrap', '127.0.0.1:9092'));
      setKafkaMode(nextKafkaMode === 'docker' ? 'docker' : 'host');
      setKafkaDockerPath(readProfileString(profile, 'kafkaDockerPath', 'docker'));
      setKafkaContainerName(readProfileString(profile, 'kafkaContainerName', ''));
      setKafkaTopicsPath(readProfileString(profile, 'kafkaTopicsPath', DEFAULT_KAFKA_TOPICS_PATH));
      setKafkaGroupsPath(readProfileString(profile, 'kafkaGroupsPath', DEFAULT_KAFKA_CONSUMER_GROUPS_PATH));
      setKafkaConsumerPath(readProfileString(profile, 'kafkaConsumerPath', DEFAULT_KAFKA_CONSOLE_CONSUMER_PATH));
      setKafkaOffsetsPath(readProfileString(profile, 'kafkaOffsetsPath', DEFAULT_KAFKA_GET_OFFSETS_PATH));
      setSampleMaxMessages(readProfileString(profile, 'sampleMaxMessages', '20'));
      setSampleTimeoutMs(readProfileString(profile, 'sampleTimeoutMs', '10000'));
      setSampleFromBeginning(readProfileBoolean(profile, 'sampleFromBeginning', false));
    });

    return () => {
      disposed = true;
    };
  }, [hostId]);

  const refreshRabbit = async () => {
    const command = rabbitMode === 'rabbitmqctl'
      ? createRabbitCtlCommand(rabbitCtlPath, isWindowsHost)
      : createRabbitManagementCommand({ url: rabbitApiUrl, username: rabbitUser, password: rabbitPassword }, isWindowsHost);
    const result = await runCmd(connectionId, command);

    if (result.code !== 0) {
      throw new Error(formatRabbitCommandError(result.stdout, result.stderr, result.code));
    }

    const nextQueues = rabbitMode === 'rabbitmqctl'
      ? parseRabbitCtlQueues(result.stdout)
      : parseRabbitManagementQueues(result.stdout);

    setQueues(nextQueues);
    setSelectedQueueName((current) => current && nextQueues.some((queue) => queue.name === current) ? current : nextQueues[0]?.name ?? '');
    setRawOutput(result.stdout || result.stderr);
    setActiveTab('queues');
    setNotice(tCurrent('auto.remoteMessageQueuePanel.xewr3n', { value0: nextQueues.length, value1: nextQueues.reduce((sum, queue) => sum + queue.messages, 0).toLocaleString(getShellDeskLocale()) }));
  };

  const refreshKafka = async () => {
    const topicsTarget = createKafkaCommandTarget(kafkaMode, kafkaTopicsPath, kafkaContainerName, kafkaDockerPath);
    const lagTarget = createKafkaCommandTarget(kafkaMode, kafkaGroupsPath, kafkaContainerName, kafkaDockerPath);
    const [topicsResult, lagResult] = await Promise.all([
      runCmd(connectionId, createKafkaTopicsCommand(topicsTarget, kafkaBootstrap, isWindowsHost)),
      runCmd(connectionId, createKafkaLagCommand(lagTarget, kafkaBootstrap, isWindowsHost)),
    ]);

    if (topicsResult.code !== 0) {
      throw new Error(topicsResult.stderr || topicsResult.stdout || tCurrent('auto.remoteMessageQueuePanel.fr557x', { value0: topicsResult.code }));
    }

    const nextTopics = parseKafkaTopics(topicsResult.stdout);
    const nextLags = lagResult.code === 0 ? parseKafkaLag(lagResult.stdout) : [];

    setTopics(nextTopics);
    setLags(nextLags);
    setTopicOffsets({});
    setSampleMessages([]);
    setSelectedTopicName((current) => current && nextTopics.some((topic) => topic.name === current) ? current : nextTopics[0]?.name ?? '');
    setRawOutput([topicsResult.stdout, lagResult.stderr, lagResult.stdout].filter(Boolean).join('\n\n'));
    setActiveTab(nextLags.length ? 'lag' : 'topics');

    if (lagResult.code !== 0) {
      setNotice(lagResult.stderr || tCurrent('auto.remoteMessageQueuePanel.lsw4xl'));
    } else {
      setNotice(tCurrent('auto.remoteMessageQueuePanel.uzoao6', { value0: nextTopics.length, value1: nextLags.length }));
    }
  };

  const refreshKafkaTopicOffsets = async () => {
    if (!selectedTopic) {
      setError(tCurrent('messageQueue.kafka.topicRequired'));
      return;
    }

    setOffsetLoading(true);
    setError('');
    setNotice('');

    try {
      const target = createKafkaCommandTarget(kafkaMode, kafkaOffsetsPath, kafkaContainerName, kafkaDockerPath);
      const [earliestResult, latestResult] = await Promise.all([
        runCmd(connectionId, createKafkaOffsetsCommand(target, kafkaBootstrap, selectedTopic.name, '-2', isWindowsHost)),
        runCmd(connectionId, createKafkaOffsetsCommand(target, kafkaBootstrap, selectedTopic.name, '-1', isWindowsHost)),
      ]);

      const failedResult = earliestResult.code !== 0 ? earliestResult : latestResult.code !== 0 ? latestResult : null;
      if (failedResult) {
        throw new Error(failedResult.stderr || failedResult.stdout || tCurrent('messageQueue.kafka.offsetsFailed', { value0: failedResult.code }));
      }

      const summary = summarizeKafkaTopicOffsets(
        parseKafkaPartitionOffsets(earliestResult.stdout),
        parseKafkaPartitionOffsets(latestResult.stdout),
      );

      if (!summary) {
        throw new Error(tCurrent('messageQueue.kafka.offsetsEmpty'));
      }

      setTopicOffsets((current) => ({ ...current, [selectedTopic.name]: summary }));
      setRawOutput([earliestResult.stderr, earliestResult.stdout, latestResult.stderr, latestResult.stdout].filter(Boolean).join('\n\n'));
      setNotice(tCurrent('messageQueue.kafka.offsetsNotice', { value0: formatNumber(summary.messageCount), value1: summary.partitionCount }));
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setOffsetLoading(false);
    }
  };

  const sampleKafkaMessages = async () => {
    if (!selectedTopic) {
      setError(tCurrent('messageQueue.kafka.topicRequired'));
      return;
    }

    setSampling(true);
    setError('');
    setNotice('');

    try {
      const target = createKafkaCommandTarget(kafkaMode, kafkaConsumerPath, kafkaContainerName, kafkaDockerPath);
      const result = await runCmd(connectionId, createKafkaSampleCommand(target, kafkaBootstrap, {
        topicName: selectedTopic.name,
        maxMessages: Number(sampleMaxMessages),
        timeoutMs: Number(sampleTimeoutMs),
        fromBeginning: sampleFromBeginning,
      }, isWindowsHost));

      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || tCurrent('messageQueue.kafka.sampleFailed', { value0: result.code }));
      }

      const nextMessages = parseKafkaSampleMessages(result.stdout);
      setSampleMessages(nextMessages);
      setRawOutput([result.stderr, result.stdout].filter(Boolean).join('\n\n'));
      setActiveTab('messages');
      setNotice(tCurrent('messageQueue.kafka.sampleNotice', { value0: nextMessages.length }));
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setSampling(false);
    }
  };

  const refresh = async () => {
    setLoading(true);
    setError('');
    setNotice('');

    try {
      if (backend === 'rabbitmq') {
        await refreshRabbit();
      } else {
        await refreshKafka();
      }

      setLastRefreshedAt(new Date().toLocaleTimeString(getShellDeskLocale()));
      void saveRemoteConnectionProfile(hostId, 'message-queue', {
        backend,
        rabbitMode,
        rabbitCtlPath,
        rabbitApiUrl,
        rabbitUser,
        rabbitPassword,
        kafkaBootstrap,
        kafkaMode,
        kafkaDockerPath,
        kafkaContainerName,
        kafkaTopicsPath,
        kafkaGroupsPath,
        kafkaConsumerPath,
        kafkaOffsetsPath,
        sampleMaxMessages,
        sampleTimeoutMs,
        sampleFromBeginning,
      }).catch(() => undefined);
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  const copyRaw = async () => {
    await navigator.clipboard.writeText(rawOutput);
    setNotice(tCurrent('auto.remoteMessageQueuePanel.1jag1z9'));
  };

  return (
    <section className="message-queue">
      <header className="mq-toolbar">
        <div className="mq-status">
          <span>{tCurrent('auto.remoteMessageQueuePanel.132u0au')}</span>
          <strong>{backend === 'rabbitmq' ? 'RabbitMQ' : 'Kafka'}</strong>
          <em>{lastRefreshedAt || tCurrent('auto.remoteMessageQueuePanel.1t0b1fu')}</em>
        </div>
        <div className="mq-backend-switch">
          <button type="button" className={backend === 'rabbitmq' ? 'active' : ''} onClick={() => { setBackend('rabbitmq'); setActiveTab('queues'); }}>RabbitMQ</button>
          <button type="button" className={backend === 'kafka' ? 'active' : ''} onClick={() => { setBackend('kafka'); setActiveTab('topics'); }}>Kafka</button>
        </div>
        <button type="button" className="primary" onClick={refresh} disabled={loading}>{loading ? tCurrent('auto.remoteMessageQueuePanel.1taxqz1') : tCurrent('auto.remoteMessageQueuePanel.12qo56a')}</button>
      </header>

      {error ? <DismissibleAlert className="mq-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="mq-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="mq-layout">
        <aside className="mq-config">
          {backend === 'rabbitmq' ? (
            <>
              <div className="mq-mode-switch">
                <button type="button" className={rabbitMode === 'rabbitmqctl' ? 'active' : ''} onClick={() => setRabbitMode('rabbitmqctl')}>rabbitmqctl</button>
                <button type="button" className={rabbitMode === 'management-api' ? 'active' : ''} onClick={() => setRabbitMode('management-api')}>Management API</button>
              </div>
              {rabbitMode === 'rabbitmqctl' ? (
                <label>
                  <span>{tCurrent('auto.remoteMessageQueuePanel.1btc1g3')}</span>
                  <input value={rabbitCtlPath} onChange={(event) => setRabbitCtlPath(event.target.value)} />
                </label>
              ) : (
                <>
                  <label>
                    <span>API URL</span>
                    <input value={rabbitApiUrl} onChange={(event) => setRabbitApiUrl(event.target.value)} />
                  </label>
                  <label>
                    <span>User</span>
                    <input value={rabbitUser} onChange={(event) => setRabbitUser(event.target.value)} />
                  </label>
                  <label>
                    <span>Password</span>
                    <input type="password" value={rabbitPassword} onChange={(event) => setRabbitPassword(event.target.value)} />
                  </label>
                </>
              )}
              <div className="mq-summary">
                <span>{tCurrent('auto.remoteMessageQueuePanel.1m388fv')}</span>
                <strong>{queues.length}</strong>
                <em>{formatNumber(totalRabbitMessages)} messages</em>
              </div>
            </>
          ) : (
            <>
              <div className="mq-mode-switch" role="group" aria-label="Kafka execution mode">
                <button type="button" className={kafkaMode === 'host' ? 'active' : ''} onClick={() => setKafkaMode('host')}>{tCurrent('messageQueue.kafka.mode.host')}</button>
                <button type="button" className={kafkaMode === 'docker' ? 'active' : ''} onClick={() => setKafkaMode('docker')}>{tCurrent('messageQueue.kafka.mode.docker')}</button>
              </div>
              <label>
                <span>{tCurrent('messageQueue.kafka.bootstrap')}</span>
                <input value={kafkaBootstrap} onChange={(event) => setKafkaBootstrap(event.target.value)} />
              </label>
              {kafkaMode === 'docker' ? (
                <>
                  <label>
                    <span>{tCurrent('messageQueue.kafka.container')}</span>
                    <input value={kafkaContainerName} onChange={(event) => setKafkaContainerName(event.target.value)} placeholder="mss-kafka-1 / 91e0f4972d94" />
                  </label>
                  <label>
                    <span>{tCurrent('messageQueue.kafka.dockerPath')}</span>
                    <input value={kafkaDockerPath} onChange={(event) => setKafkaDockerPath(event.target.value)} />
                  </label>
                </>
              ) : null}
              <label>
                <span>{tCurrent('messageQueue.kafka.topicsPath')}</span>
                <input value={kafkaTopicsPath} onChange={(event) => setKafkaTopicsPath(event.target.value)} />
              </label>
              <label>
                <span>{tCurrent('messageQueue.kafka.groupsPath')}</span>
                <input value={kafkaGroupsPath} onChange={(event) => setKafkaGroupsPath(event.target.value)} />
              </label>
              <label>
                <span>{tCurrent('messageQueue.kafka.consumerPath')}</span>
                <input value={kafkaConsumerPath} onChange={(event) => setKafkaConsumerPath(event.target.value)} />
              </label>
              <label>
                <span>{tCurrent('messageQueue.kafka.offsetsPath')}</span>
                <input value={kafkaOffsetsPath} onChange={(event) => setKafkaOffsetsPath(event.target.value)} />
              </label>
              <label>
                <span>{tCurrent('messageQueue.kafka.sampleLimit')}</span>
                <input type="number" min="1" max="100" value={sampleMaxMessages} onChange={(event) => setSampleMaxMessages(event.target.value)} />
              </label>
              <label>
                <span>{tCurrent('messageQueue.kafka.sampleTimeout')}</span>
                <input type="number" min="1000" max="60000" step="1000" value={sampleTimeoutMs} onChange={(event) => setSampleTimeoutMs(event.target.value)} />
              </label>
              <label className="mq-checkbox">
                <input type="checkbox" checked={sampleFromBeginning} onChange={(event) => setSampleFromBeginning(event.target.checked)} />
                <span>{tCurrent('messageQueue.kafka.fromBeginning')}</span>
              </label>
              <div className="mq-summary">
                <span>Lag</span>
                <strong>{formatNumber(totalLag)}</strong>
                <em>{topics.length} topics</em>
              </div>
            </>
          )}
          <label>
            <span>{tCurrent('auto.remoteMessageQueuePanel.367f3v')}</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="queue / topic / group / message" />
          </label>
        </aside>

        <main className="mq-main">
          <nav className="mq-tabs">
            <button type="button" className={activeTab === 'queues' ? 'active' : ''} onClick={() => setActiveTab('queues')} disabled={backend !== 'rabbitmq'}>{tCurrent('auto.remoteMessageQueuePanel.1m388fv2')}</button>
            <button type="button" className={activeTab === 'topics' ? 'active' : ''} onClick={() => setActiveTab('topics')} disabled={backend !== 'kafka'}>Topic</button>
            <button type="button" className={activeTab === 'lag' ? 'active' : ''} onClick={() => setActiveTab('lag')} disabled={backend !== 'kafka'}>Consumer Lag</button>
            <button type="button" className={activeTab === 'messages' ? 'active' : ''} onClick={() => setActiveTab('messages')} disabled={backend !== 'kafka'}>{tCurrent('messageQueue.kafka.messagesTab')}</button>
            <button type="button" onClick={() => void refreshKafkaTopicOffsets()} disabled={backend !== 'kafka' || !selectedTopic || offsetLoading || loading || sampling}>{offsetLoading ? tCurrent('messageQueue.kafka.offsetsLoading') : tCurrent('messageQueue.kafka.refreshOffsets')}</button>
            <button type="button" onClick={() => void sampleKafkaMessages()} disabled={backend !== 'kafka' || !selectedTopic || sampling || loading}>{sampling ? tCurrent('messageQueue.kafka.sampling') : tCurrent('messageQueue.kafka.sampleButton')}</button>
            <button type="button" className={activeTab === 'raw' ? 'active' : ''} onClick={() => setActiveTab('raw')}>{tCurrent('auto.remoteMessageQueuePanel.1sxtwbe')}</button>
            <button type="button" onClick={copyRaw} disabled={!rawOutput}>{tCurrent('auto.remoteMessageQueuePanel.tinpzn')}</button>
          </nav>

          {activeTab === 'queues' ? (
            <section className="mq-table-wrap">
              <table className="mq-table">
                <thead>
                  <tr>
                    <th>Queue</th>
                    <th>VHost</th>
                    <th>Messages</th>
                    <th>Consumers</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredQueues.map((queue) => (
                    <tr key={`${queue.vhost ?? ''}:${queue.name}`} className={selectedQueue?.name === queue.name ? 'selected' : ''} onClick={() => setSelectedQueueName(queue.name)}>
                      <td>{queue.name}</td>
                      <td>{queue.vhost || '-'}</td>
                      <td>{formatNumber(queue.messages)}</td>
                      <td>{formatNumber(queue.consumers)}</td>
                      <td>{queue.state || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredQueues.length ? <div className="mq-empty-state">{tCurrent('auto.remoteMessageQueuePanel.5u0bqv')}</div> : null}
            </section>
          ) : null}

          {activeTab === 'topics' ? (
            <section className="mq-topic-grid">
              {filteredTopics.map((topic) => (
                <button key={topic.name} type="button" className={selectedTopic?.name === topic.name ? 'active' : ''} onClick={() => { setSelectedTopicName(topic.name); setSampleMessages([]); }}>
                  <strong>{topic.name}</strong>
                  <span>{topicOffsets[topic.name] ? tCurrent('messageQueue.kafka.topicCardMeta', { value0: formatNumber(topicOffsets[topic.name].messageCount), value1: lagRowsByTopic[topic.name] ?? 0 }) : tCurrent('messageQueue.kafka.topicCardLag', { value0: lagRowsByTopic[topic.name] ?? 0 })}</span>
                </button>
              ))}
              {!filteredTopics.length ? <div className="mq-empty-state">{tCurrent('auto.remoteMessageQueuePanel.bbz5cc')}</div> : null}
            </section>
          ) : null}

          {activeTab === 'lag' ? (
            <section className="mq-table-wrap">
              <table className="mq-table">
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>Topic</th>
                    <th>Partition</th>
                    <th>Current</th>
                    <th>End</th>
                    <th>Lag</th>
                    <th>Consumer</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLags.map((lag, index) => (
                    <tr key={`${lag.group}-${lag.topic}-${lag.partition}-${index}`}>
                      <td>{lag.group}</td>
                      <td>{lag.topic}</td>
                      <td>{lag.partition}</td>
                      <td>{formatNumber(lag.currentOffset)}</td>
                      <td>{formatNumber(lag.logEndOffset)}</td>
                      <td>{formatNumber(lag.lag)}</td>
                      <td>{lag.consumerId || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredLags.length ? <div className="mq-empty-state">{tCurrent('auto.remoteMessageQueuePanel.1cn0glm')}</div> : null}
            </section>
          ) : null}

          {activeTab === 'messages' ? (
            <section className="mq-message-samples">
              {filteredSampleMessages.map((message, index) => (
                <article key={`${index}-${message.slice(0, 24)}`} className="mq-message-sample">
                  <span>#{index + 1}</span>
                  <pre>{message}</pre>
                </article>
              ))}
              {!filteredSampleMessages.length ? <div className="mq-empty-state">{tCurrent('messageQueue.kafka.sampleEmpty')}</div> : null}
            </section>
          ) : null}

          {activeTab === 'raw' ? <pre className="mq-raw">{rawOutput || tCurrent('auto.remoteMessageQueuePanel.1w2y2p4')}</pre> : null}
        </main>

        <aside className="mq-detail">
          <div className="mq-detail-head">
            <strong>{backend === 'rabbitmq' ? tCurrent('auto.remoteMessageQueuePanel.mvneo6') : tCurrent('auto.remoteMessageQueuePanel.w4ex35')}</strong>
            <span>{backend === 'rabbitmq' ? selectedQueue?.name ?? tCurrent('auto.remoteMessageQueuePanel.1mhzgbz') : selectedTopic?.name ?? tCurrent('auto.remoteMessageQueuePanel.1mhzgbz2')}</span>
          </div>
          {backend === 'rabbitmq' ? (
            <div className="mq-detail-list">
              <span>Name</span><strong>{selectedQueue?.name ?? '-'}</strong>
              <span>VHost</span><strong>{selectedQueue?.vhost ?? '-'}</strong>
              <span>Messages</span><strong>{formatNumber(selectedQueue?.messages)}</strong>
              <span>Consumers</span><strong>{formatNumber(selectedQueue?.consumers)}</strong>
              <span>State</span><strong>{selectedQueue?.state ?? '-'}</strong>
            </div>
          ) : (
            <div className="mq-detail-list">
              <span>Topic</span><strong>{selectedTopic?.name ?? '-'}</strong>
              <span>{tCurrent('messageQueue.kafka.brokerMessages')}</span><strong>{formatNumber(selectedTopicOffsets?.messageCount)}</strong>
              <span>{tCurrent('messageQueue.kafka.partitions')}</span><strong>{formatNumber(selectedTopicOffsets?.partitionCount)}</strong>
              <span>{tCurrent('messageQueue.kafka.consumerLagRows')}</span><strong>{lagForSelectedTopic.length}</strong>
              <span>{tCurrent('messageQueue.kafka.totalConsumerLag')}</span><strong>{formatNumber(lagForSelectedTopic.reduce((sum, lag) => sum + (lag.lag ?? 0), 0))}</strong>
              <span>Groups</span><strong>{new Set(lagForSelectedTopic.map((lag) => lag.group)).size}</strong>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

export default RemoteMessageQueuePanel;
