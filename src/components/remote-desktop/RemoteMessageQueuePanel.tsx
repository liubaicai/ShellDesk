import { useMemo, useState } from 'react';
import DismissibleAlert from './DismissibleAlert';

import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import {
  createKafkaLagCommand,
  createKafkaTopicsCommand,
  createRabbitCtlCommand,
  createRabbitManagementCommand,
  formatRabbitCommandError,
  parseKafkaLag,
  parseKafkaTopics,
  parseRabbitCtlQueues,
  parseRabbitManagementQueues,
  type KafkaConsumerLag,
  type KafkaTopicSummary,
  type RabbitQueueSummary,
} from './messageQueueParsers';
import { isWindowsSystem } from './remoteSystem';
import type { RemoteSystemType } from './types';
import { tCurrent } from '../../i18n';

interface RemoteMessageQueuePanelProps {
  connectionId: string;
  systemType?: RemoteSystemType;
}

type QueueBackend = 'rabbitmq' | 'kafka';
type RabbitMode = 'rabbitmqctl' | 'management-api';
type QueueTab = 'queues' | 'topics' | 'lag' | 'raw';

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

function RemoteMessageQueuePanel({ connectionId, systemType }: RemoteMessageQueuePanelProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const [backend, setBackend] = useState<QueueBackend>('rabbitmq');
  const [rabbitMode, setRabbitMode] = useState<RabbitMode>('rabbitmqctl');
  const [rabbitCtlPath, setRabbitCtlPath] = useState('rabbitmqctl');
  const [rabbitApiUrl, setRabbitApiUrl] = useState('http://127.0.0.1:15672');
  const [rabbitUser, setRabbitUser] = useState('guest');
  const [rabbitPassword, setRabbitPassword] = useState('guest');
  const [kafkaBootstrap, setKafkaBootstrap] = useState('127.0.0.1:9092');
  const [kafkaTopicsPath, setKafkaTopicsPath] = useState('kafka-topics.sh');
  const [kafkaGroupsPath, setKafkaGroupsPath] = useState('kafka-consumer-groups.sh');
  const [queues, setQueues] = useState<RabbitQueueSummary[]>([]);
  const [topics, setTopics] = useState<KafkaTopicSummary[]>([]);
  const [lags, setLags] = useState<KafkaConsumerLag[]>([]);
  const [selectedQueueName, setSelectedQueueName] = useState('');
  const [selectedTopicName, setSelectedTopicName] = useState('');
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<QueueTab>('queues');
  const [rawOutput, setRawOutput] = useState('');
  const [loading, setLoading] = useState(false);
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

  const selectedQueue = useMemo(() => queues.find((queue) => queue.name === selectedQueueName) ?? queues[0] ?? null, [queues, selectedQueueName]);
  const selectedTopic = useMemo(() => topics.find((topic) => topic.name === selectedTopicName) ?? topics[0] ?? null, [selectedTopicName, topics]);
  const lagForSelectedTopic = useMemo(() => selectedTopic ? lags.filter((lag) => lag.topic === selectedTopic.name) : [], [lags, selectedTopic]);
  const totalRabbitMessages = useMemo(() => queues.reduce((sum, queue) => sum + queue.messages, 0), [queues]);
  const totalLag = useMemo(() => lags.reduce((sum, lag) => sum + (lag.lag ?? 0), 0), [lags]);

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
    const [topicsResult, lagResult] = await Promise.all([
      runCmd(connectionId, createKafkaTopicsCommand(kafkaTopicsPath, kafkaBootstrap, isWindowsHost)),
      runCmd(connectionId, createKafkaLagCommand(kafkaGroupsPath, kafkaBootstrap, isWindowsHost)),
    ]);

    if (topicsResult.code !== 0) {
      throw new Error(topicsResult.stderr || topicsResult.stdout || tCurrent('auto.remoteMessageQueuePanel.fr557x', { value0: topicsResult.code }));
    }

    const nextTopics = parseKafkaTopics(topicsResult.stdout);
    const nextLags = lagResult.code === 0 ? parseKafkaLag(lagResult.stdout) : [];

    setTopics(nextTopics);
    setLags(nextLags);
    setSelectedTopicName((current) => current && nextTopics.some((topic) => topic.name === current) ? current : nextTopics[0]?.name ?? '');
    setRawOutput([topicsResult.stdout, lagResult.stderr, lagResult.stdout].filter(Boolean).join('\n\n'));
    setActiveTab(nextLags.length ? 'lag' : 'topics');

    if (lagResult.code !== 0) {
      setNotice(lagResult.stderr || tCurrent('auto.remoteMessageQueuePanel.lsw4xl'));
    } else {
      setNotice(tCurrent('auto.remoteMessageQueuePanel.uzoao6', { value0: nextTopics.length, value1: nextLags.length }));
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
              <label>
                <span>Bootstrap Server</span>
                <input value={kafkaBootstrap} onChange={(event) => setKafkaBootstrap(event.target.value)} />
              </label>
              <label>
                <span>kafka-topics</span>
                <input value={kafkaTopicsPath} onChange={(event) => setKafkaTopicsPath(event.target.value)} />
              </label>
              <label>
                <span>consumer-groups</span>
                <input value={kafkaGroupsPath} onChange={(event) => setKafkaGroupsPath(event.target.value)} />
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
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="queue / topic / group" />
          </label>
        </aside>

        <main className="mq-main">
          <nav className="mq-tabs">
            <button type="button" className={activeTab === 'queues' ? 'active' : ''} onClick={() => setActiveTab('queues')} disabled={backend !== 'rabbitmq'}>{tCurrent('auto.remoteMessageQueuePanel.1m388fv2')}</button>
            <button type="button" className={activeTab === 'topics' ? 'active' : ''} onClick={() => setActiveTab('topics')} disabled={backend !== 'kafka'}>Topic</button>
            <button type="button" className={activeTab === 'lag' ? 'active' : ''} onClick={() => setActiveTab('lag')} disabled={backend !== 'kafka'}>Consumer Lag</button>
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
                <button key={topic.name} type="button" className={selectedTopic?.name === topic.name ? 'active' : ''} onClick={() => setSelectedTopicName(topic.name)}>
                  <strong>{topic.name}</strong>
                  <span>{lags.filter((lag) => lag.topic === topic.name).length} lag rows</span>
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
              <span>Lag Rows</span><strong>{lagForSelectedTopic.length}</strong>
              <span>Total Lag</span><strong>{formatNumber(lagForSelectedTopic.reduce((sum, lag) => sum + (lag.lag ?? 0), 0))}</strong>
              <span>Groups</span><strong>{new Set(lagForSelectedTopic.map((lag) => lag.group)).size}</strong>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

export default RemoteMessageQueuePanel;
