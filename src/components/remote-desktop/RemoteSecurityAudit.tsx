import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import DismissibleAlert from './DismissibleAlert';

import { t, translateStructuredText, type AppLanguage } from '../../i18n';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
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
import { useSudoCommand } from './sudoPrompt';
import type { RemoteSystemType } from './types';

interface RemoteSecurityAuditProps {
  connectionId: string;
  settings: ShellDeskAppSettings;
  systemType?: RemoteSystemType;
  hostLabel?: string;
}

interface SecurityCheckListGroup {
  id: string;
  title: string;
  description: string;
  definitionIds: string[];
}

type SecurityAiAuditPhase = 'idle' | 'planning' | 'collecting' | 'requesting' | 'streaming' | 'done' | 'error';

interface SecurityAiPlan {
  ids: string[];
  reason: string;
}

const SECURITY_AI_EVIDENCE_CHAR_LIMIT = 100000;
const SECURITY_AI_RAW_OUTPUT_LIMIT = 7000;
const securitySeverityRank: Record<SecurityCheckResult['severity'], number> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};
const securityStatusRank: Record<SecurityCheckResult['status'], number> = {
  failed: 4,
  warning: 3,
  unknown: 2,
  passed: 1,
};

function createSecurityCheckListGroups(definitions: SecurityCheckDefinition[], language: AppLanguage): SecurityCheckListGroup[] {
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const createSingleGroup = (definitionId: string): SecurityCheckListGroup | null => {
    const definition = definitionById.get(definitionId);

    return definition
      ? {
          id: definition.id,
          title: definition.title,
          description: definition.description,
          definitionIds: [definition.id],
        }
      : null;
  };

  return [
    createSingleGroup('ssh-config'),
    {
      id: 'identity-access',
      title: t('securityAudit.group.identityAccess.title', language),
      description: t('securityAudit.group.identityAccess.description', language),
      definitionIds: ['privileged-users', 'account-keys'],
    },
    createSingleGroup('failed-logins'),
    {
      id: 'network-exposure',
      title: t('securityAudit.group.networkExposure.title', language),
      description: t('securityAudit.group.networkExposure.description', language),
      definitionIds: ['open-ports', 'firewall-exposure'],
    },
    {
      id: 'runtime-privilege',
      title: t('securityAudit.group.runtimePrivilege.title', language),
      description: t('securityAudit.group.runtimePrivilege.description', language),
      definitionIds: ['process-analysis', 'privilege-surface'],
    },
    createSingleGroup('file-permissions'),
    createSingleGroup('updates'),
    {
      id: 'cis-baseline',
      title: language === 'zh-CN' ? 'CIS 基线' : 'CIS baseline',
      description: language === 'zh-CN' ? '轻量核查 SSH、账户策略、防火墙、审计和系统安全基线。' : 'Lightweight checks for SSH, account policy, firewall, audit, and system hardening baselines.',
      definitionIds: ['cis-baseline'],
    },
  ]
    .filter((group): group is SecurityCheckListGroup => Boolean(group))
    .map((group) => ({
      ...group,
      definitionIds: group.definitionIds.filter((definitionId) => definitionById.has(definitionId)),
    }))
    .filter((group) => group.definitionIds.length > 0);
}

function getWorstSecurityResult(results: SecurityCheckResult[]) {
  return results.reduce<SecurityCheckResult | null>((worstResult, result) => {
    if (!worstResult) {
      return result;
    }

    const statusDelta = securityStatusRank[result.status] - securityStatusRank[worstResult.status];

    if (statusDelta !== 0) {
      return statusDelta > 0 ? result : worstResult;
    }

    return securitySeverityRank[result.severity] > securitySeverityRank[worstResult.severity] ? result : worstResult;
  }, null);
}

function createPendingSecurityResult(definition: SecurityCheckDefinition, language: AppLanguage): SecurityCheckResult {
  return {
    id: definition.id,
    title: definition.title,
    severity: 'info',
    status: 'unknown',
    summary: definition.description,
    details: [t('securityAudit.pending.detail', language)],
    suggestions: [t('securityAudit.pending.suggestion', language)],
    rawOutput: '',
  };
}

function createGroupedSecurityResult(
  group: SecurityCheckListGroup,
  definitions: SecurityCheckDefinition[],
  results: SecurityCheckResult[],
  language: AppLanguage,
): SecurityCheckResult {
  if (definitions.length === 1) {
    return results[0] ?? createPendingSecurityResult(definitions[0], language);
  }

  const worstResult = getWorstSecurityResult(results);
  const completedLabel = `${results.length}/${definitions.length}`;
  const summary = worstResult
    ? `${completedLabel} · ${worstResult.title}: ${worstResult.summary}`
    : group.description;
  const details = definitions.map((definition) => {
    const result = results.find((item) => item.id === definition.id);

    return result
      ? `${definition.title} · ${getStatusLabel(result.status, language)} · ${result.summary}`
      : `${definition.title} · ${t('securityAudit.ui.pendingRun', language)} · ${definition.description}`;
  });
  const suggestions = results.length
    ? results.flatMap((result) => result.suggestions.map((suggestion) => `${result.title}: ${suggestion}`))
    : [t('securityAudit.pending.suggestion', language)];
  const rawOutput = results
    .map((result) => `# ${result.title}\n${result.rawOutput || t('securityAudit.ui.noRawOutput', language)}`)
    .join('\n\n');

  return {
    id: group.id,
    title: group.title,
    severity: worstResult?.severity ?? 'info',
    status: worstResult?.status ?? 'unknown',
    summary,
    details,
    suggestions,
    rawOutput,
  };
}

function createFailedResult(definition: SecurityCheckDefinition, error: unknown, language: AppLanguage): SecurityCheckResult {
  return {
    id: definition.id,
    title: definition.title,
    severity: 'info',
    status: 'unknown',
    summary: getErrorMessage(error),
    details: [t('securityAudit.failed.detail', language)],
    rawOutput: '',
    suggestions: [t('securityAudit.failed.suggestion', language)],
  };
}

function compactAiText(value: string | undefined, maxLength: number, language: AppLanguage) {
  const normalizedValue = (value ?? '').trim();

  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength)}\n${t('securityAudit.ai.truncated', language, { count: normalizedValue.length - maxLength })}`;
}

function getAiReadinessError(settings: ShellDeskAppSettings, language: AppLanguage) {
  const aiControls = window.guiSSH?.ai;

  if (!aiControls?.chat && !aiControls?.chatStream) {
    return t('securityAudit.ai.noChat', language);
  }

  if (
    !settings.aiApiBaseUrl.trim() ||
    (settings.aiApiFormat === 'anthropic' && !settings.aiApiKey.trim()) ||
    !settings.aiModel.trim()
  ) {
    return t('securityAudit.ai.configRequired', language);
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
    messages: messages.map((message) => ({
      ...message,
      content: translateStructuredText(message.content, settings.language),
    })),
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

function parseSecurityAiPlan(content: string, definitions: SecurityCheckDefinition[], language: AppLanguage): SecurityAiPlan {
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
    : t('securityAudit.ai.planFallback', language);

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
  language: AppLanguage,
) {
  const header = [
    t('securityAudit.ai.evidence.host', language, { host: hostLabel || t('securityCheck.report.currentConnection', language) }),
    t('securityAudit.ai.evidence.system', language, { system: isWindowsHost ? 'Windows' : 'Linux/Unix' }),
    t('securityAudit.ai.evidence.collectedAt', language, { time: scannedAt || new Date().toLocaleString(getShellDeskLocale()) }),
    t('securityAudit.ai.evidence.planReason', language, { reason: planReason }),
    t('securityAudit.ai.evidence.count', language, { count: results.length }),
  ].join('\n');
  let text = `${header}\n\n`;
  let includedCount = 0;

  for (const result of results) {
    const section = [
      `## ${result.title} (${result.id})`,
      t('securityAudit.ai.evidence.severity', language, { severity: result.severity }),
      t('securityAudit.ai.evidence.status', language, { status: result.status }),
      t('securityAudit.ai.evidence.summary', language, { summary: result.summary }),
      '',
      t('securityAudit.ai.evidence.findings', language),
      ...result.details.map((detail) => `- ${detail}`),
      '',
      t('securityAudit.ai.evidence.suggestions', language),
      ...result.suggestions.map((suggestion) => `- ${suggestion}`),
      '',
      t('securityAudit.ai.evidence.rawOutput', language),
      compactAiText(result.rawOutput || t('securityAudit.ai.evidence.noRawOutput', language), SECURITY_AI_RAW_OUTPUT_LIMIT, language),
      '',
    ].join('\n');

    if (text.length + section.length > SECURITY_AI_EVIDENCE_CHAR_LIMIT) {
      text += `\n${t('securityAudit.ai.evidence.omitted', language, { count: results.length - includedCount })}\n`;
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

function getSecurityAiPhaseLabel(phase: SecurityAiAuditPhase, language: AppLanguage) {
  if (phase === 'planning') return t('securityAudit.ai.phase.planning', language);
  if (phase === 'collecting') return t('securityAudit.ai.phase.collecting', language);
  if (phase === 'requesting') return t('securityAudit.ai.phase.requesting', language);
  if (phase === 'streaming') return t('securityAudit.ai.phase.streaming', language);
  if (phase === 'done') return t('securityAudit.ai.phase.done', language);
  if (phase === 'error') return t('securityAudit.ai.phase.error', language);
  return t('securityAudit.ai.phase.idle', language);
}

function createSecurityAiReportDocument(report: string, generatedAt: string, planNote: string, snapshotNote: string, language: AppLanguage) {
  return [
    t('securityAudit.ai.report.documentTitle', language),
    generatedAt ? t('securityAudit.ai.report.generatedAt', language, { time: generatedAt }) : '',
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

function RemoteSecurityAudit({ connectionId, settings, systemType, hostLabel }: RemoteSecurityAuditProps) {
  const language = settings.language;
  const effectiveHostLabel = hostLabel || t('securityCheck.report.currentConnection', language);
  const isWindowsHost = isWindowsSystem(systemType);
  const { runCommand, sudoPrompt } = useSudoCommand(connectionId, systemType);
  const definitions = useMemo(() => createSecurityCheckDefinitions(isWindowsHost, language), [isWindowsHost, language]);
  const checkGroups = useMemo(() => createSecurityCheckListGroups(definitions, language), [definitions, language]);
  const [results, setResults] = useState<SecurityCheckResult[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState(checkGroups[0]?.id ?? '');
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

  const selectedGroup = checkGroups.find((group) => group.id === selectedGroupId) ?? checkGroups[0];
  const selectedDefinitions = selectedGroup
    ? selectedGroup.definitionIds
        .map((definitionId) => definitions.find((definition) => definition.id === definitionId) ?? null)
        .filter((definition): definition is SecurityCheckDefinition => Boolean(definition))
    : [];
  const selectedResults = selectedDefinitions
    .map((definition) => results.find((result) => result.id === definition.id) ?? null)
    .filter((result): result is SecurityCheckResult => Boolean(result));
  const currentResult = selectedGroup
    ? createGroupedSecurityResult(selectedGroup, selectedDefinitions, selectedResults, language)
    : null;
  const isSelectedGroupRunning = selectedDefinitions.some((definition) => runningIds.has(definition.id));
  const stats = useMemo(() => ({
    high: results.filter((result) => result.severity === 'high').length,
    medium: results.filter((result) => result.severity === 'medium').length,
    low: results.filter((result) => result.severity === 'low').length,
    info: results.filter((result) => result.severity === 'info').length,
    warning: results.filter((result) => result.status === 'warning' || result.status === 'failed').length,
  }), [results]);
  const score = useMemo(() => calculateSecurityScore(results, language), [language, results]);
  const isAiAuditBusy = aiAuditPhase === 'planning' || aiAuditPhase === 'collecting' || aiAuditPhase === 'requesting' || aiAuditPhase === 'streaming';

  useEffect(() => {
    if (!checkGroups.length) {
      setSelectedGroupId('');
      return;
    }

    if (!checkGroups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(checkGroups[0].id);
    }
  }, [checkGroups, selectedGroupId]);

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
      const commandResult = await runCommand(command);
      const result = definition.evaluate(commandResult);
      upsertResult(result);
      setScannedAt(new Date().toLocaleString(getShellDeskLocale()));
      return result;
    } catch (error) {
      const result = createFailedResult(definition, error, language);
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
      setScannedAt(new Date().toLocaleString(getShellDeskLocale()));
      setNotice(t('securityAudit.notice.completed', language));
    } catch (error) {
      setError(getErrorMessage(error));
    } finally {
      setRunningAll(false);
    }
  };

  const runSelectedGroup = async () => {
    if (!selectedDefinitions.length || isSelectedGroupRunning) {
      return;
    }

    for (const definition of selectedDefinitions) {
      await runCheck(definition);
    }
  };

  const copyReport = async () => {
    if (!results.length) {
      return;
    }

    await navigator.clipboard.writeText(formatSecurityReport(results, effectiveHostLabel, scannedAt, language));
    setNotice(t('securityAudit.notice.copiedMarkdown', language));
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

    const readinessError = getAiReadinessError(settings, language);

    if (readinessError) {
      setAiAuditPhase('error');
      setAiAuditError(readinessError);
      return;
    }

    const aiControls = window.guiSSH?.ai;

    if (!aiControls?.chat) {
      setAiAuditPhase('error');
      setAiAuditError(t('securityAudit.ai.noChat', language));
      return;
    }

    let plan: SecurityAiPlan;

    try {
      const planResult = await aiControls.chat(createAiChatRequest(settings, [
        {
          role: 'system',
          content: t('ai.security.plan.systemPrompt', language),
        },
        {
          role: 'user',
          content: [
            t('securityAudit.ai.plan.host', language, { host: effectiveHostLabel }),
            t('securityAudit.ai.plan.systemType', language, { system: isWindowsHost ? 'Windows' : 'Linux/Unix' }),
            t('securityAudit.ai.plan.allowlist', language),
            createSecurityAiCatalog(definitions),
            '',
            results.length ? t('securityAudit.ai.plan.currentSummary', language) : t('securityAudit.ai.plan.noSummary', language),
            ...results.map((result) => `- ${result.id}: ${result.status}/${result.severity} - ${result.summary}`),
          ].join('\n'),
        },
      ], 0.1));

      plan = parseSecurityAiPlan(planResult.content, definitions, language);
    } catch (err) {
      setAiAuditPhase('error');
      setAiAuditError(t('securityAudit.ai.error.planFailed', language, { error: getErrorMessage(err) }));
      return;
    }

    const aiSelectedDefinitions = plan.ids
      .map((id) => definitions.find((definition) => definition.id === id))
      .filter((definition): definition is SecurityCheckDefinition => Boolean(definition));

    if (!aiSelectedDefinitions.length) {
      setAiAuditPhase('error');
      setAiAuditError(t('securityAudit.ai.error.noSelection', language));
      return;
    }

    const planNote = t('securityAudit.ai.plan.note', language, {
      count: aiSelectedDefinitions.length,
      items: aiSelectedDefinitions.map((definition) => definition.title).join(language === 'zh-CN' ? '、' : ', '),
      reason: plan.reason,
    });
    const completedResults: SecurityCheckResult[] = [];

    setAiAuditPlanNote(planNote);
    setAiAuditPhase('collecting');
    const firstAiGroup = checkGroups.find((group) => group.definitionIds.includes(aiSelectedDefinitions[0].id));
    setSelectedGroupId(firstAiGroup?.id ?? checkGroups[0]?.id ?? '');

    for (const [index, definition] of aiSelectedDefinitions.entries()) {
      setAiAuditSnapshotNote(t('securityAudit.ai.collectingItem', language, { index: index + 1, total: aiSelectedDefinitions.length, title: definition.title }));
      completedResults.push(await runCheck(definition));
    }

    const generatedAt = new Date().toLocaleString(getShellDeskLocale());
    const evidence = createSecurityAiEvidence(completedResults, effectiveHostLabel, generatedAt, plan.reason, isWindowsHost, language);
    const snapshotNote = evidence.omittedCount > 0
      ? t('securityAudit.ai.snapshot.partial', language, { included: evidence.includedCount, total: completedResults.length, omitted: evidence.omittedCount })
      : t('securityAudit.ai.snapshot.all', language, { included: evidence.includedCount });
    const analysisRequest = createAiChatRequest(settings, [
      {
        role: 'system',
        content: t('ai.security.report.systemPrompt', language),
      },
      {
        role: 'user',
        content: [
          t('securityAudit.ai.report.userPrompt', language),
          '',
          t('securityAudit.ai.report.planLabel', language),
          planNote,
          '',
          t('securityAudit.ai.report.dataLabel', language),
          evidence.text,
        ].join('\n'),
      },
    ], 0.1);
    let streamedContent = '';
    const streamedTextUpdater = createStreamedTextUpdater(setAiAuditText, t('securityAudit.ai.report.generating', language));

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

      setAiAuditText(resultContent || t('securityAudit.ai.report.empty', language));
      setAiAuditGeneratedAt(generatedAt);
      setAiAuditPhase('done');
      setNotice(t('securityAudit.ai.notice.completed', language));
    } catch (err) {
      setAiAuditPhase('error');
      setAiAuditError(t('securityAudit.ai.error.requestFailed', language, { error: getErrorMessage(err) }));
    }
  };

  const copyAiAuditReport = async () => {
    if (!aiAuditText.trim()) {
      return;
    }

    setAiAuditNotice('');
    setAiAuditError('');

    try {
      await navigator.clipboard.writeText(createSecurityAiReportDocument(aiAuditText, aiAuditGeneratedAt, aiAuditPlanNote, aiAuditSnapshotNote, language));
      setAiAuditNotice(t('securityAudit.ai.notice.copied', language));
    } catch (err) {
      setAiAuditError(t('securityAudit.ai.error.copyFailed', language, { error: getErrorMessage(err) }));
    }
  };

  const exportAiAuditReport = async () => {
    if (!aiAuditText.trim()) {
      return;
    }

    const saveTextFile = window.guiSSH?.files?.saveTextFile;

    if (!saveTextFile) {
      setAiAuditError(t('securityAudit.ai.error.exportUnsupported', language));
      return;
    }

    setAiAuditNotice('');
    setAiAuditError('');

    try {
      const filePath = await saveTextFile({
        title: t('securityAudit.ai.export.title', language),
        defaultFileName: createSecurityAiReportFileName(),
        content: createSecurityAiReportDocument(aiAuditText, aiAuditGeneratedAt, aiAuditPlanNote, aiAuditSnapshotNote, language),
      });

      if (filePath) {
        setAiAuditNotice(t('securityAudit.ai.notice.exported', language, { path: filePath }));
      }
    } catch (err) {
      setAiAuditError(t('securityAudit.ai.error.exportFailed', language, { error: getErrorMessage(err) }));
    }
  };

  return (
    <section className="security-audit">
      <header className="security-toolbar">
        <div className="security-title">
          <strong>{effectiveHostLabel}</strong>
          <em>{scannedAt || t('securityAudit.ui.notRun', language)}</em>
        </div>
        <div className="security-summary">
          <div className={`security-score-card ${score.tone}`}>
            <span>{t('securityAudit.ui.score', language)}</span>
            <strong>{score.score ?? '--'}</strong>
            <em>{score.label}</em>
          </div>
          <div><span>{t('securityAudit.ui.highRisk', language)}</span><strong>{stats.high}</strong></div>
          <div><span>{t('securityAudit.ui.mediumRisk', language)}</span><strong>{stats.medium}</strong></div>
          <div><span>{t('securityAudit.ui.lowRisk', language)}</span><strong>{stats.low}</strong></div>
          <div><span>{t('securityAudit.ui.info', language)}</span><strong>{stats.info}</strong></div>
          <div><span>{t('securityAudit.ui.needsAttention', language)}</span><strong>{stats.warning}</strong></div>
        </div>
        <div className="security-actions">
          <button type="button" className="primary" onClick={runAllChecks} disabled={runningAll || isAiAuditBusy}>
            {runningAll ? t('securityAudit.ui.running', language) : t('securityAudit.ui.runAll', language)}
          </button>
          <button type="button" className="ai" onClick={() => void requestAiAudit()} disabled={runningAll && !isAiAuditBusy}>
            {isAiAuditBusy ? t('securityAudit.ui.aiRunning', language) : t('securityAudit.ui.aiAudit', language)}
          </button>
          <button type="button" onClick={copyReport} disabled={!results.length}>{t('securityAudit.ui.copyReport', language)}</button>
        </div>
      </header>

      {error ? <DismissibleAlert className="security-alert danger" onDismiss={() => setError('')} role="alert">{error}</DismissibleAlert> : null}
      {notice ? <DismissibleAlert className="security-alert info" onDismiss={() => setNotice('')}>{notice}</DismissibleAlert> : null}

      <div className="security-layout">
        <aside className="security-check-list">
          {checkGroups.map((group) => {
            const groupDefinitions = group.definitionIds
              .map((definitionId) => definitions.find((definition) => definition.id === definitionId) ?? null)
              .filter((definition): definition is SecurityCheckDefinition => Boolean(definition));
            const groupResults = groupDefinitions
              .map((definition) => results.find((item) => item.id === definition.id) ?? null)
              .filter((result): result is SecurityCheckResult => Boolean(result));
            const groupResult = createGroupedSecurityResult(group, groupDefinitions, groupResults, language);
            const isRunning = groupDefinitions.some((definition) => runningIds.has(definition.id));
            const statusLabel = groupResults.length
              ? getStatusLabel(groupResult.status, language)
              : t('securityAudit.ui.pendingRun', language);

            return (
              <button
                key={group.id}
                type="button"
                className={`${selectedGroupId === group.id ? 'active' : ''} ${groupResult.severity}`}
                onClick={() => setSelectedGroupId(group.id)}
              >
                <span>
                  <strong>{group.title}</strong>
                  <small>{groupResult.summary}</small>
                </span>
                <em className={groupResult.status}>{isRunning ? '...' : statusLabel}</em>
              </button>
            );
          })}
        </aside>

        <main className="security-detail-panel">
          {currentResult ? (
            <>
              <div className="security-detail-head">
                <div>
                  <span>{getStatusLabel(currentResult.status, language)}</span>
                  <strong>{currentResult.title}</strong>
                </div>
                <div className="security-detail-actions">
                  <span className={`security-severity ${currentResult.severity}`}>{getSeverityLabel(currentResult.severity, language)}</span>
                  <button
                    type="button"
                    onClick={() => void runSelectedGroup()}
                    disabled={!selectedDefinitions.length || isSelectedGroupRunning}
                  >
                    {isSelectedGroupRunning
                      ? t('securityAudit.ui.rerunning', language)
                      : t(selectedDefinitions.length > 1 ? 'securityAudit.ui.rerunGroup' : 'securityAudit.ui.rerunOne', language)}
                  </button>
                </div>
              </div>

              <div className="security-result-summary">{currentResult.summary}</div>

              <section className="security-section">
                <h3>{t('securityAudit.ui.findings', language)}</h3>
                <ul>
                  {currentResult.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              </section>

              <section className="security-section">
                <h3>{t('securityAudit.ui.suggestions', language)}</h3>
                <ul>
                  {currentResult.suggestions.map((suggestion) => (
                    <li key={suggestion}>{suggestion}</li>
                  ))}
                </ul>
              </section>

              <section className="security-section raw">
                <h3>{t('securityAudit.ui.rawOutput', language)}</h3>
                <pre>{currentResult.rawOutput || t('securityAudit.ui.noRawOutput', language)}</pre>
              </section>
            </>
          ) : (
            <div className="security-empty">{t('securityAudit.ui.empty', language)}</div>
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
                <strong id="security-ai-report-title">{t('securityAudit.ai.modal.title', language)}</strong>
              </div>
              <button type="button" className="security-ai-close" onClick={() => setAiAuditOpen(false)} aria-label={t('securityAudit.ai.modal.closeAria', language)}>×</button>
            </div>

            <div className={`security-ai-progress ${aiAuditPhase}`}>
              <div className="security-ai-progress-bar" aria-hidden="true">
                <span />
              </div>
              <strong>{getSecurityAiPhaseLabel(aiAuditPhase, language)}</strong>
              <em>{aiAuditSnapshotNote || aiAuditPlanNote || t('securityAudit.ai.modal.intro', language)}</em>
            </div>

            {aiAuditError ? <DismissibleAlert className="security-alert danger" onDismiss={() => setAiAuditError('')} role="alert">{aiAuditError}</DismissibleAlert> : null}
            {aiAuditNotice ? <DismissibleAlert className="security-alert success" onDismiss={() => setAiAuditNotice('')}>{aiAuditNotice}</DismissibleAlert> : null}

            <MarkdownReport
              className="security-ai-report"
              content={aiAuditText}
              placeholder={isAiAuditBusy ? t('securityAudit.ai.modal.placeholderGenerating', language) : t('securityAudit.ai.modal.placeholderEmpty', language)}
              renderMarkdown={!isAiAuditBusy}
              stickToBottom={isAiAuditBusy}
            />

            <div className="security-modal-actions">
              <button type="button" className="security-modal-btn" onClick={() => setAiAuditOpen(false)}>{t('common.close', language)}</button>
              <button type="button" className="security-modal-btn" onClick={() => void copyAiAuditReport()} disabled={!aiAuditText.trim()}>
                {t('securityAudit.ai.modal.copyReport', language)}
              </button>
              <button type="button" className="security-modal-btn primary" onClick={() => void exportAiAuditReport()} disabled={!aiAuditText.trim()}>
                {t('securityAudit.ai.modal.exportReport', language)}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {sudoPrompt}
    </section>
  );
}

export default RemoteSecurityAudit;
