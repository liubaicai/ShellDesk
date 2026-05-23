import { useMemo, useState } from 'react';

import { getErrorMessage } from './desktopUtils';
import { isWindowsSystem } from './remoteSystem';
import {
  createSecurityCheckDefinitions,
  formatSecurityReport,
  getSeverityLabel,
  getStatusLabel,
  type SecurityCheckDefinition,
  type SecurityCheckResult,
} from './securityChecks';
import type { RemoteSystemType } from './types';

interface RemoteSecurityAuditProps {
  connectionId: string;
  systemType?: RemoteSystemType;
  hostLabel?: string;
}

function runCmd(connectionId: string, command: string) {
  const api = window.guiSSH?.connections;

  if (!api) {
    throw new Error('ShellDesk IPC 未就绪。');
  }

  return api.runCommand(connectionId, command);
}

function createFailedResult(definition: SecurityCheckDefinition, error: unknown): SecurityCheckResult {
  return {
    id: definition.id,
    title: definition.title,
    severity: 'info',
    status: 'unknown',
    summary: getErrorMessage(error),
    details: ['该检查项执行失败，其他检查项不受影响。'],
    rawOutput: '',
    suggestions: ['确认远程命令权限和目标系统工具是否可用后重试。'],
  };
}

function RemoteSecurityAudit({ connectionId, systemType, hostLabel = '当前连接' }: RemoteSecurityAuditProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const definitions = useMemo(() => createSecurityCheckDefinitions(isWindowsHost), [isWindowsHost]);
  const [results, setResults] = useState<SecurityCheckResult[]>([]);
  const [selectedId, setSelectedId] = useState(definitions[0]?.id ?? '');
  const [runningAll, setRunningAll] = useState(false);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scannedAt, setScannedAt] = useState('');

  const selectedDefinition = definitions.find((definition) => definition.id === selectedId) ?? definitions[0];
  const selectedResult = results.find((result) => result.id === selectedId) ?? null;
  const currentResult = selectedResult ?? (selectedDefinition
    ? {
        id: selectedDefinition.id,
        title: selectedDefinition.title,
        severity: 'info' as const,
        status: 'unknown' as const,
        summary: selectedDefinition.description,
        details: ['尚未运行该检查项。'],
        suggestions: ['点击单项重跑或运行全部。'],
        rawOutput: '',
      }
    : null);
  const stats = useMemo(() => ({
    high: results.filter((result) => result.severity === 'high').length,
    medium: results.filter((result) => result.severity === 'medium').length,
    low: results.filter((result) => result.severity === 'low').length,
    info: results.filter((result) => result.severity === 'info').length,
    warning: results.filter((result) => result.status === 'warning' || result.status === 'failed').length,
  }), [results]);

  const upsertResult = (nextResult: SecurityCheckResult) => {
    setResults((currentResults) => {
      const exists = currentResults.some((result) => result.id === nextResult.id);
      if (exists) {
        return currentResults.map((result) => (result.id === nextResult.id ? nextResult : result));
      }
      return [...currentResults, nextResult];
    });
  };

  const runCheck = async (definition: SecurityCheckDefinition) => {
    setRunningIds((current) => new Set(current).add(definition.id));
    setError('');
    setNotice('');

    try {
      const command = definition.createCommand();
      const commandResult = await runCmd(connectionId, command);
      const result = definition.evaluate(commandResult);
      upsertResult(result);
      setSelectedId(result.id);
      setScannedAt(new Date().toLocaleString('zh-CN'));
      return result;
    } catch (error) {
      const result = createFailedResult(definition, error);
      upsertResult(result);
      setSelectedId(result.id);
      return result;
    } finally {
      setRunningIds((current) => {
        const next = new Set(current);
        next.delete(definition.id);
        return next;
      });
    }
  };

  const runAllChecks = async () => {
    setRunningAll(true);
    setError('');
    setNotice('');
    setResults([]);

    try {
      for (const definition of definitions) {
        await runCheck(definition);
      }
      setScannedAt(new Date().toLocaleString('zh-CN'));
      setNotice('巡检完成，报告已刷新。');
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setRunningAll(false);
    }
  };

  const copyReport = async () => {
    if (!results.length) {
      return;
    }

    await navigator.clipboard.writeText(formatSecurityReport(results, hostLabel, scannedAt));
    setNotice('已复制 Markdown 巡检报告。');
  };

  return (
    <section className="security-audit">
      <header className="security-toolbar">
        <div className="security-title">
          <span>{isWindowsHost ? 'Windows' : 'Linux/Unix'} 安全巡检</span>
          <strong>{hostLabel}</strong>
          <em>{scannedAt || '尚未运行'}</em>
        </div>
        <div className="security-actions">
          <button type="button" className="primary" onClick={runAllChecks} disabled={runningAll}>
            {runningAll ? '巡检中' : '运行全部'}
          </button>
          <button type="button" onClick={copyReport} disabled={!results.length}>复制报告</button>
        </div>
      </header>

      {error ? <div className="security-alert danger">{error}</div> : null}
      {notice ? <div className="security-alert info">{notice}</div> : null}

      <div className="security-summary">
        <div><span>高风险</span><strong>{stats.high}</strong></div>
        <div><span>中风险</span><strong>{stats.medium}</strong></div>
        <div><span>低风险</span><strong>{stats.low}</strong></div>
        <div><span>信息</span><strong>{stats.info}</strong></div>
        <div><span>需关注</span><strong>{stats.warning}</strong></div>
      </div>

      <div className="security-layout">
        <aside className="security-check-list">
          {definitions.map((definition) => {
            const result = results.find((item) => item.id === definition.id);
            const isRunning = runningIds.has(definition.id);

            return (
              <button
                key={definition.id}
                type="button"
                className={`${selectedId === definition.id ? 'active' : ''} ${result?.severity ?? 'info'}`}
                onClick={() => setSelectedId(definition.id)}
              >
                <span>
                  <strong>{definition.title}</strong>
                  <small>{result?.summary ?? definition.description}</small>
                </span>
                <em className={result?.status ?? 'unknown'}>{isRunning ? '...' : result ? getStatusLabel(result.status) : '待运行'}</em>
              </button>
            );
          })}
        </aside>

        <main className="security-detail-panel">
          {currentResult ? (
            <>
              <div className="security-detail-head">
                <div>
                  <span>{getStatusLabel(currentResult.status)}</span>
                  <strong>{currentResult.title}</strong>
                </div>
                <div className="security-detail-actions">
                  <span className={`security-severity ${currentResult.severity}`}>{getSeverityLabel(currentResult.severity)}</span>
                  <button
                    type="button"
                    onClick={() => selectedDefinition ? runCheck(selectedDefinition) : undefined}
                    disabled={!selectedDefinition || runningIds.has(currentResult.id)}
                  >
                    {runningIds.has(currentResult.id) ? '运行中' : '单项重跑'}
                  </button>
                </div>
              </div>

              <div className="security-result-summary">{currentResult.summary}</div>

              <section className="security-section">
                <h3>发现</h3>
                <ul>
                  {currentResult.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              </section>

              <section className="security-section">
                <h3>建议</h3>
                <ul>
                  {currentResult.suggestions.map((suggestion) => (
                    <li key={suggestion}>{suggestion}</li>
                  ))}
                </ul>
              </section>

              <section className="security-section raw">
                <h3>原始输出</h3>
                <pre>{currentResult.rawOutput || '没有原始输出。'}</pre>
              </section>
            </>
          ) : (
            <div className="security-empty">暂无检查项。</div>
          )}
        </main>
      </div>
    </section>
  );
}

export default RemoteSecurityAudit;
