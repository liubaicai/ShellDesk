import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { getErrorMessage } from './desktopUtils';
import MarkdownReport from './MarkdownReport';
import { isWindowsSystem } from './remoteSystem';
import {
  calculateSecurityScore,
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
  settings: ShellDeskAppSettings;
  systemType?: RemoteSystemType;
  hostLabel?: string;
}

type SecurityAiAuditPhase = 'idle' | 'planning' | 'collecting' | 'requesting' | 'streaming' | 'done' | 'error';

interface SecurityAiPlan {
  ids: string[];
  reason: string;
}

const SECURITY_AI_EVIDENCE_CHAR_LIMIT = 100000;
const SECURITY_AI_RAW_OUTPUT_LIMIT = 7000;

const SECURITY_AI_PLAN_SYSTEM_PROMPT = `你是 ShellDesk 的 SD-Agent 安全巡检规划助手。你只能从用户给出的 allowlist 检查项 ID 中选择要采集的信息，不能要求执行自定义命令、写文件、改配置、安装软件或进行破坏性操作。

请只返回 JSON，不要使用 Markdown 代码块。格式：
{"checks":["ssh-config","open-ports"],"reason":"选择这些检查项的原因"}

checks 必须是 allowlist 中存在的 ID。优先选择能覆盖账号、登录、进程、端口、防火墙、权限、提权面和更新状态的检查项；如果无法判断，应选择全部检查项。`;

const SECURITY_AI_REPORT_SYSTEM_PROMPT = `你是 ShellDesk 的 SD-Agent 安全巡检分析助手。你只能基于用户提供的巡检输出做静态研判，不要假装访问外部情报、扫描文件、查杀病毒或已经完成未提供的数据采集。

请用中文输出 Markdown 报告，重点识别 SSH 暴露、弱账号面、失败登录、异常进程、开放端口、防火墙、敏感权限、提权面和补丁更新风险。每个风险要说明依据、影响、建议核验动作和低破坏性处置建议。`;

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

function compactAiText(value: string | undefined, maxLength: number) {
  const normalizedValue = (value ?? '').trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength)}\n[内容过长，已截断 ${normalizedValue.length - maxLength} 字符]`;
}

function getAiReadinessError(settings: ShellDeskAppSettings) {
  const aiControls = window.guiSSH?.ai;

  if (!aiControls?.chat && !aiControls?.chatStream) {
    return '当前运行环境未提供 SD-Agent 对话接口。';
  }

  if (!settings.aiApiBaseUrl.trim() || !settings.aiApiKey.trim() || !settings.aiModel.trim()) {
    return '请先在设置中完成 SD-Agent 提供商、API 密钥和模型配置。';
  }

  return '';
}

function createAiChatRequest(
  settings: ShellDeskAppSettings,
  messages: ShellDeskAiChatMessage[],
  temperature = 0.2,
): ShellDeskAiChatRequest {
  return {
    provider: settings.aiProvider,
    apiFormat: settings.aiApiFormat,
    apiBaseUrl: settings.aiApiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
    temperature,
    messages,
  };
}

function createSecurityAiCatalog(definitions: SecurityCheckDefinition[]) {
  return definitions.map((definition) => (
    `- ${definition.id}: ${definition.title} - ${definition.description}`
  )).join('\n');
}

function extractJsonObject(text: string) {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = (fencedMatch?.[1] ?? text).trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');

  if (start >= 0 && end > start) {
    return source.slice(start, end + 1);
  }

  return source;
}

function parseSecurityAiPlan(content: string, definitions: SecurityCheckDefinition[]): SecurityAiPlan {
  const validIds = new Set(definitions.map((definition) => definition.id));
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJsonObject(content));
  } catch {
    parsed = null;
  }

  const objectValue = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const rawIds = Array.isArray(objectValue.checks)
    ? objectValue.checks
    : Array.isArray(objectValue.checkIds)
      ? objectValue.checkIds
      : [];
  const parsedIds = rawIds
    .map((id) => String(id))
    .filter((id) => validIds.has(id));
  const idsFromText = definitions
    .map((definition) => definition.id)
    .filter((id) => content.includes(id));
  const ids = [...new Set(parsedIds.length ? parsedIds : idsFromText)];
  const reason = typeof objectValue.reason === 'string' && objectValue.reason.trim()
    ? objectValue.reason.trim()
    : 'SD-Agent 已根据当前系统类型和可用检查项选择采集范围。';

  return {
    ids: ids.length ? ids : definitions.map((definition) => definition.id),
    reason,
  };
}

function createSecurityAiEvidence(
  results: SecurityCheckResult[],
  hostLabel: string,
  scannedAt: string,
  planReason: string,
  isWindowsHost: boolean,
) {
  const header = [
    `主机：${hostLabel || '当前连接'}`,
    `系统：${isWindowsHost ? 'Windows' : 'Linux/Unix'}`,
    `采集时间：${scannedAt || new Date().toLocaleString('zh-CN')}`,
    `AI 规划理由：${planReason}`,
    `采集项数量：${results.length}`,
  ].join('\n');
  let text = `${header}\n\n`;
  let includedCount = 0;

  for (const result of results) {
    const section = [
      `## ${result.title} (${result.id})`,
      `等级：${result.severity}`,
      `状态：${result.status}`,
      `摘要：${result.summary}`,
      '',
      '发现：',
      ...result.details.map((detail) => `- ${detail}`),
      '',
      '建议：',
      ...result.suggestions.map((suggestion) => `- ${suggestion}`),
      '',
      '原始输出：',
      compactAiText(result.rawOutput || '没有原始输出。', SECURITY_AI_RAW_OUTPUT_LIMIT),
      '',
    ].join('\n');

    if (text.length + section.length > SECURITY_AI_EVIDENCE_CHAR_LIMIT) {
      text += `\n[注意] 后续 ${results.length - includedCount} 个检查项因消息长度限制未发送给 SD-Agent。请在报告里说明该限制。\n`;
      break;
    }

    text += `${section}\n`;
    includedCount += 1;
  }

  return {
    text,
    includedCount,
    omittedCount: Math.max(0, results.length - includedCount),
  };
}

function getSecurityAiPhaseLabel(phase: SecurityAiAuditPhase) {
  if (phase === 'planning') return '正在规划采集项...';
  if (phase === 'collecting') return '正在采集远端信息...';
  if (phase === 'requesting') return '正在请求 SD-Agent...';
  if (phase === 'streaming') return '正在生成巡检报告...';
  if (phase === 'done') return 'AI 巡检完成';
  if (phase === 'error') return 'AI 巡检失败';
  return '等待开始';
}

function createSecurityAiReportDocument(report: string, generatedAt: string, planNote: string, snapshotNote: string) {
  return [
    '# ShellDesk AI 安全巡检报告',
    generatedAt ? `生成时间：${generatedAt}` : '',
    planNote,
    snapshotNote,
    '',
    report.trim(),
  ].filter(Boolean).join('\n');
}

function createSecurityAiReportFileName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `shelldesk-security-ai-report-${timestamp}.md`;
}

function createStreamedTextUpdater(setText: (value: string) => void, fallbackText: string) {
  let nextText = '';
  let timerId: number | undefined;

  const doFlush = () => {
    timerId = undefined;
    setText(nextText || fallbackText);
  };

  return {
    append(chunk: string) {
      nextText += chunk;

      if (timerId !== undefined) {
        return;
      }

      timerId = window.setTimeout(doFlush, 250);
    },
    cancel() {
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
        timerId = undefined;
      }
    },
    flush() {
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }

      doFlush();
    },
  };
}

function RemoteSecurityAudit({ connectionId, settings, systemType, hostLabel = '当前连接' }: RemoteSecurityAuditProps) {
  const isWindowsHost = isWindowsSystem(systemType);
  const definitions = useMemo(() => createSecurityCheckDefinitions(isWindowsHost), [isWindowsHost]);
  const [results, setResults] = useState<SecurityCheckResult[]>([]);
  const [selectedId, setSelectedId] = useState(definitions[0]?.id ?? '');
  const [runningAll, setRunningAll] = useState(false);
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scannedAt, setScannedAt] = useState('');
  const [aiAuditOpen, setAiAuditOpen] = useState(false);
  const [aiAuditPhase, setAiAuditPhase] = useState<SecurityAiAuditPhase>('idle');
  const [aiAuditText, setAiAuditText] = useState('');
  const [aiAuditError, setAiAuditError] = useState('');
  const [aiAuditNotice, setAiAuditNotice] = useState('');
  const [aiAuditGeneratedAt, setAiAuditGeneratedAt] = useState('');
  const [aiAuditPlanNote, setAiAuditPlanNote] = useState('');
  const [aiAuditSnapshotNote, setAiAuditSnapshotNote] = useState('');

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
  const score = useMemo(() => calculateSecurityScore(results), [results]);
  const isAiAuditBusy = aiAuditPhase === 'planning' || aiAuditPhase === 'collecting' || aiAuditPhase === 'requesting' || aiAuditPhase === 'streaming';

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
      setScannedAt(new Date().toLocaleString('zh-CN'));
      return result;
    } catch (error) {
      const result = createFailedResult(definition, error);
      upsertResult(result);
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
    const completedResults: SecurityCheckResult[] = [];

    try {
      for (const definition of definitions) {
        const result = await runCheck(definition);
        completedResults.push(result);
        setResults([...completedResults]);
      }
      setResults(completedResults);
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

  const requestAiAudit = async () => {
    if (isAiAuditBusy) {
      setAiAuditOpen(true);
      return;
    }

    setAiAuditOpen(true);
    setAiAuditPhase('planning');
    setAiAuditText('');
    setAiAuditError('');
    setAiAuditNotice('');
    setAiAuditGeneratedAt('');
    setAiAuditPlanNote('');
    setAiAuditSnapshotNote('');
    setError('');
    setNotice('');

    const readinessError = getAiReadinessError(settings);

    if (readinessError) {
      setAiAuditPhase('error');
      setAiAuditError(readinessError);
      return;
    }

    const aiControls = window.guiSSH?.ai;

    if (!aiControls?.chat) {
      setAiAuditPhase('error');
      setAiAuditError('当前运行环境未提供 SD-Agent 对话接口。');
      return;
    }

    let plan: SecurityAiPlan;

    try {
      const planResult = await aiControls.chat(createAiChatRequest(settings, [
        {
          role: 'system',
          content: SECURITY_AI_PLAN_SYSTEM_PROMPT,
        },
        {
          role: 'user',
          content: [
            `目标主机：${hostLabel || '当前连接'}`,
            `系统类型：${isWindowsHost ? 'Windows' : 'Linux/Unix'}`,
            '可采集检查项 allowlist：',
            createSecurityAiCatalog(definitions),
            '',
            results.length ? '当前已有巡检摘要：' : '当前没有已有巡检结果。',
            ...results.map((result) => `- ${result.id}: ${result.status}/${result.severity} - ${result.summary}`),
          ].join('\n'),
        },
      ], 0.1));

      plan = parseSecurityAiPlan(planResult.content, definitions);
    } catch (err) {
      setAiAuditPhase('error');
      setAiAuditError(`SD-Agent 规划采集项失败：${getErrorMessage(err)}`);
      return;
    }

    const selectedDefinitions = plan.ids
      .map((id) => definitions.find((definition) => definition.id === id))
      .filter((definition): definition is SecurityCheckDefinition => Boolean(definition));

    if (!selectedDefinitions.length) {
      setAiAuditPhase('error');
      setAiAuditError('SD-Agent 没有选择可执行的巡检项。');
      return;
    }

    const planNote = `AI 计划采集 ${selectedDefinitions.length} 项：${selectedDefinitions.map((definition) => definition.title).join('、')}。${plan.reason}`;
    const completedResults: SecurityCheckResult[] = [];

    setAiAuditPlanNote(planNote);
    setAiAuditPhase('collecting');
    setSelectedId(selectedDefinitions[0].id);

    for (const [index, definition] of selectedDefinitions.entries()) {
      setAiAuditSnapshotNote(`正在采集 ${index + 1} / ${selectedDefinitions.length}：${definition.title}`);
      completedResults.push(await runCheck(definition));
    }

    const generatedAt = new Date().toLocaleString('zh-CN');
    const evidence = createSecurityAiEvidence(completedResults, hostLabel, generatedAt, plan.reason, isWindowsHost);
    const snapshotNote = evidence.omittedCount > 0
      ? `已发送 ${evidence.includedCount} / ${completedResults.length} 个检查项；${evidence.omittedCount} 个检查项因单条消息长度限制未发送。`
      : `已发送 ${evidence.includedCount} 个检查项。`;
    const analysisRequest = createAiChatRequest(settings, [
      {
        role: 'system',
        content: SECURITY_AI_REPORT_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: [
          '请根据下面由 SD-Agent 规划并采集的 ShellDesk 安全巡检数据生成最终报告。',
          '输出格式：',
          '1. 总体结论：2-4 句话说明主机当前安全态势。',
          '2. 关键风险：用表格列出风险、等级、证据、影响、建议动作；没有明确风险时写“未发现明确高风险项”。',
          '3. 已采集信息：说明本次 AI 选择采集了哪些信息，以及是否存在采集限制。',
          '4. 修复与加固优先级：按高/中/低优先级列出低破坏性的核验和处置步骤。',
          '5. 继续核验：列出仅凭当前输出无法确认、但建议人工复核的事项。',
          '',
          'AI 采集规划：',
          planNote,
          '',
          '巡检数据：',
          evidence.text,
        ].join('\n'),
      },
    ], 0.1);
    let streamedContent = '';
    const streamedTextUpdater = createStreamedTextUpdater(setAiAuditText, '正在生成报告...');

    setAiAuditSnapshotNote(snapshotNote);
    setAiAuditPhase(aiControls.chatStream ? 'streaming' : 'requesting');

    try {
      let resultContent = '';

      if (aiControls.chatStream) {
        try {
          const result = await aiControls.chatStream(analysisRequest, {
            onChunk: (chunk) => {
              streamedContent += chunk;
              streamedTextUpdater.append(chunk);
            },
          });
          streamedTextUpdater.flush();
          resultContent = result.content || streamedContent;
        } catch (streamError) {
          streamedTextUpdater.cancel();

          if (streamedContent) {
            throw streamError;
          }

          setAiAuditPhase('requesting');
          const result = await aiControls.chat(analysisRequest);
          resultContent = result.content;
        }
      } else {
        const result = await aiControls.chat(analysisRequest);
        resultContent = result.content;
      }

      setAiAuditText(resultContent || 'SD-Agent 没有返回报告内容。');
      setAiAuditGeneratedAt(generatedAt);
      setAiAuditPhase('done');
      setNotice('AI 巡检完成，报告已生成。');
    } catch (err) {
      setAiAuditPhase('error');
      setAiAuditError(`SD-Agent 请求失败：${getErrorMessage(err)}`);
    }
  };

  const copyAiAuditReport = async () => {
    if (!aiAuditText.trim()) {
      return;
    }

    setAiAuditNotice('');
    setAiAuditError('');

    try {
      await navigator.clipboard.writeText(createSecurityAiReportDocument(aiAuditText, aiAuditGeneratedAt, aiAuditPlanNote, aiAuditSnapshotNote));
      setAiAuditNotice('已复制 AI 巡检报告。');
    } catch (err) {
      setAiAuditError(`复制失败：${getErrorMessage(err)}`);
    }
  };

  const exportAiAuditReport = async () => {
    if (!aiAuditText.trim()) {
      return;
    }

    const saveTextFile = window.guiSSH?.files?.saveTextFile;

    if (!saveTextFile) {
      setAiAuditError('当前运行环境不支持导出报告。');
      return;
    }

    setAiAuditNotice('');
    setAiAuditError('');

    try {
      const filePath = await saveTextFile({
        title: '导出 AI 安全巡检报告',
        defaultFileName: createSecurityAiReportFileName(),
        content: createSecurityAiReportDocument(aiAuditText, aiAuditGeneratedAt, aiAuditPlanNote, aiAuditSnapshotNote),
      });

      if (filePath) {
        setAiAuditNotice(`已导出 AI 巡检报告：${filePath}`);
      }
    } catch (err) {
      setAiAuditError(`导出失败：${getErrorMessage(err)}`);
    }
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
          <button type="button" className="primary" onClick={runAllChecks} disabled={runningAll || isAiAuditBusy}>
            {runningAll ? '巡检中' : '运行全部'}
          </button>
          <button type="button" className="ai" onClick={() => void requestAiAudit()} disabled={runningAll && !isAiAuditBusy}>
            {isAiAuditBusy ? 'AI 巡检中' : 'AI巡检'}
          </button>
          <button type="button" onClick={copyReport} disabled={!results.length}>复制报告</button>
        </div>
      </header>

      {error ? <div className="security-alert danger">{error}</div> : null}
      {notice ? <div className="security-alert info">{notice}</div> : null}

      <div className="security-summary">
        <div className={`security-score-card ${score.tone}`}>
          <span>安全评分</span>
          <strong>{score.score ?? '--'}</strong>
          <em>{score.label}</em>
        </div>
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

      {aiAuditOpen ? createPortal(
        <div className="security-modal-overlay" role="presentation" onClick={() => setAiAuditOpen(false)}>
          <div
            className="security-ai-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="security-ai-report-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="security-ai-modal-header">
              <div>
                <span>SD-Agent</span>
                <strong id="security-ai-report-title">AI 安全巡检</strong>
              </div>
              <button type="button" className="security-ai-close" onClick={() => setAiAuditOpen(false)} aria-label="关闭 AI 巡检弹窗">×</button>
            </div>

            <div className={`security-ai-progress ${aiAuditPhase}`}>
              <div className="security-ai-progress-bar" aria-hidden="true">
                <span />
              </div>
              <strong>{getSecurityAiPhaseLabel(aiAuditPhase)}</strong>
              <em>{aiAuditSnapshotNote || aiAuditPlanNote || 'SD-Agent 会先选择需要采集的检查项，再生成安全巡检报告。'}</em>
            </div>

            {aiAuditError ? <div className="security-alert danger">{aiAuditError}</div> : null}
            {aiAuditNotice ? <div className="security-alert success">{aiAuditNotice}</div> : null}

            <MarkdownReport
              className="security-ai-report"
              content={aiAuditText}
              placeholder={isAiAuditBusy ? '报告生成中...' : '点击 AI巡检 后会在这里显示报告。'}
              renderMarkdown={!isAiAuditBusy}
              stickToBottom={isAiAuditBusy}
            />

            <div className="security-modal-actions">
              <button type="button" className="security-modal-btn" onClick={() => setAiAuditOpen(false)}>关闭</button>
              <button type="button" className="security-modal-btn" onClick={() => void copyAiAuditReport()} disabled={!aiAuditText.trim()}>
                复制报告
              </button>
              <button type="button" className="security-modal-btn primary" onClick={() => void exportAiAuditReport()} disabled={!aiAuditText.trim()}>
                导出报告
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}

export default RemoteSecurityAudit;
