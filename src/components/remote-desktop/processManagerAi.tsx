import { useCallback, useState } from 'react';
import { t, translateStructuredText, type AppLanguage } from '../../i18n';
import { getErrorMessage, getShellDeskLocale } from './desktopUtils';
import { compactAiField, formatCpu, formatMemory } from './processManagerParsers';
import type {
  ProcessAiInsight,
  ProcessAiReportPhase,
  ProcessAiSnapshot,
  ProcessDetail,
  RemoteProcessEntry,
} from './processManagerTypes';

const PROCESS_AI_SNAPSHOT_CHAR_LIMIT = 100000;

function getAiReadinessError(settings: ShellDeskAppSettings, language: AppLanguage) {
  const aiControls = window.guiSSH?.ai;

  if (!aiControls?.chat && !aiControls?.chatStream) {
    return t('process.error.noAiChat', language);
  }

  if (
    !settings.aiApiBaseUrl.trim() ||
    (settings.aiApiFormat === 'anthropic' && !settings.aiApiKey.trim()) ||
    !settings.aiModel.trim()
  ) {
    return t('process.error.aiConfigRequired', language);
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

function formatProcessAiLine(process: RemoteProcessEntry, isWindowsHost: boolean, index: number) {
  return [
    `#${index + 1}`,
    `pid=${process.pid}`,
    `ppid=${process.ppid ?? '-'}`,
    `user=${compactAiField(process.user)}`,
    `cpu=${compactAiField(formatCpu(process, isWindowsHost))}`,
    `memory=${compactAiField(formatMemory(process, isWindowsHost))}`,
    `state=${compactAiField(process.state)}`,
    `start=${compactAiField(process.startTime)}`,
    `runtime=${compactAiField(process.runtime || process.cpuTime)}`,
    `tty=${compactAiField(process.tty)}`,
    `path=${compactAiField(process.executablePath)}`,
    `command=${compactAiField(process.command)}`,
  ].join('\t');
}

function createProcessAiSnapshot(processes: RemoteProcessEntry[], isWindowsHost: boolean, language: AppLanguage): ProcessAiSnapshot {
  const header = [
    `system=${isWindowsHost ? 'Windows' : 'Linux/Unix'}`,
    `processCount=${processes.length}`,
    `snapshotAt=${new Date().toISOString()}`,
    'fields=index, pid, ppid, user, cpu, memory, state, start, runtime, tty, path, command',
  ].join('\n');
  let text = `${header}\n`;
  let includedCount = 0;

  for (const [index, process] of processes.entries()) {
    const line = formatProcessAiLine(process, isWindowsHost, index);

    if (text.length + line.length + 1 > PROCESS_AI_SNAPSHOT_CHAR_LIMIT) {
      break;
    }

    text += `${line}\n`;
    includedCount += 1;
  }

  const omittedCount = Math.max(0, processes.length - includedCount);

  if (omittedCount > 0) {
    text += `\n${t('process.ai.snapshotOmitted', language, { count: omittedCount })}\n`;
  }

  return {
    text,
    includedCount,
    omittedCount,
  };
}

function formatProcessContextForAi(
  process: RemoteProcessEntry,
  isWindowsHost: boolean,
  detail: ProcessDetail | null,
  parent: RemoteProcessEntry | null,
  children: RemoteProcessEntry[],
  language: AppLanguage,
) {
  return [
    t('process.ai.context.system', language, { system: isWindowsHost ? 'Windows' : 'Linux/Unix' }),
    `PID：${process.pid}`,
    `PPID：${process.ppid ?? '-'}`,
    t('process.ai.context.user', language, { user: compactAiField(process.user) }),
    `CPU：${formatCpu(process, isWindowsHost)}`,
    t('process.ai.context.memory', language, { memory: formatMemory(process, isWindowsHost) }),
    t('process.ai.context.state', language, { state: compactAiField(process.state) }),
    t('process.ai.context.start', language, { start: compactAiField(process.startTime) }),
    t('process.ai.context.runtime', language, { runtime: compactAiField(process.runtime || process.cpuTime) }),
    `TTY：${compactAiField(process.tty)}`,
    t('process.ai.context.path', language, { path: compactAiField(detail?.executablePath || process.executablePath, 500) }),
    t('process.ai.context.cwd', language, { cwd: compactAiField(detail?.cwd, 500) }),
    t('process.ai.context.command', language, { command: compactAiField(process.command, 900) }),
    t('process.ai.context.parent', language, { parent: parent ? `${parent.pid} ${compactAiField(parent.command, 300)}` : '-' }),
    t('process.ai.context.children', language, {
      children: children.length ? children.slice(0, 8).map((child) => `${child.pid} ${compactAiField(child.command, 180)}`).join(' | ') : '-',
    }),
    t('process.ai.context.ports', language, {
      ports: detail?.ports.length ? detail.ports.slice(0, 12).map((port) => compactAiField(port, 180)).join(' | ') : '-',
    }),
  ].join('\n');
}

function createAiReportDocument(report: string, generatedAt: string, snapshotNote: string, language: AppLanguage) {
  return [
    t('process.ai.report.documentTitle', language),
    generatedAt ? t('process.ai.report.generatedAt', language, { time: generatedAt }) : '',
    snapshotNote,
    '',
    report.trim(),
  ].filter(Boolean).join('\n');
}

function createAiReportFileName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `shelldesk-process-ai-report-${timestamp}.md`;
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

interface UseProcessManagerAiOptions {
  settings: ShellDeskAppSettings;
  language: AppLanguage;
  processes: RemoteProcessEntry[];
  isWindowsHost: boolean;
  selectedProcess: RemoteProcessEntry | null;
  processDetail: ProcessDetail | null;
  selectedParent: RemoteProcessEntry | null;
  selectedChildren: RemoteProcessEntry[];
}

export function useProcessManagerAi({
  settings,
  language,
  processes,
  isWindowsHost,
  selectedProcess,
  processDetail,
  selectedParent,
  selectedChildren,
}: UseProcessManagerAiOptions) {
  const [aiReportOpen, setAiReportOpen] = useState(false);
  const [aiReportPhase, setAiReportPhase] = useState<ProcessAiReportPhase>('idle');
  const [aiReportText, setAiReportText] = useState('');
  const [aiReportError, setAiReportError] = useState('');
  const [aiReportNotice, setAiReportNotice] = useState('');
  const [aiReportGeneratedAt, setAiReportGeneratedAt] = useState('');
  const [aiReportSnapshotNote, setAiReportSnapshotNote] = useState('');
  const [processInsight, setProcessInsight] = useState<ProcessAiInsight | null>(null);
  const [processInsightLoadingPid, setProcessInsightLoadingPid] = useState<number | null>(null);
  const isAiReportBusy = aiReportPhase === 'preparing' || aiReportPhase === 'requesting' || aiReportPhase === 'streaming';

  const requestAiReport = useCallback(async () => {
    if (isAiReportBusy) {
      setAiReportOpen(true);
      return;
    }

    setAiReportOpen(true);
    setAiReportPhase('preparing');
    setAiReportText('');
    setAiReportError('');
    setAiReportNotice('');
    setAiReportGeneratedAt('');
    setAiReportSnapshotNote('');

    if (!processes.length) {
      setAiReportPhase('error');
      setAiReportError(t('process.ai.noSnapshot', language));
      return;
    }

    const readinessError = getAiReadinessError(settings, language);

    if (readinessError) {
      setAiReportPhase('error');
      setAiReportError(readinessError);
      return;
    }

    const aiControls = window.guiSSH?.ai;
    const snapshot = createProcessAiSnapshot(processes, isWindowsHost, language);
    const snapshotNote = snapshot.omittedCount > 0
      ? t('process.ai.snapshotNotePartial', language, { included: snapshot.includedCount, total: processes.length, omitted: snapshot.omittedCount })
      : t('process.ai.snapshotNoteAll', language, { included: snapshot.includedCount });
    const request = createAiChatRequest(settings, [
      { role: 'system', content: t('ai.process.report.systemPrompt', language) },
      { role: 'user', content: [t('process.ai.report.userPrompt', language), '', snapshot.text].join('\n') },
    ], 0.1);
    let streamedContent = '';
    const streamedTextUpdater = createStreamedTextUpdater(setAiReportText, t('process.ai.report.generating', language));

    setAiReportSnapshotNote(snapshotNote);
    setAiReportPhase(aiControls?.chatStream ? 'streaming' : 'requesting');

    try {
      let resultContent = '';

      if (aiControls?.chatStream) {
        try {
          const result = await aiControls.chatStream(request, {
            onChunk: (chunk) => {
              streamedContent += chunk;
              streamedTextUpdater.append(chunk);
            },
          });
          streamedTextUpdater.flush();
          resultContent = result.content || streamedContent;
        } catch (streamError) {
          streamedTextUpdater.cancel();

          if (streamedContent || !aiControls.chat) {
            throw streamError;
          }

          setAiReportPhase('requesting');
          const result = await aiControls.chat(request);
          resultContent = result.content;
        }
      } else if (aiControls?.chat) {
        const result = await aiControls.chat(request);
        resultContent = result.content;
      }

      setAiReportText(resultContent || t('process.ai.report.empty', language));
      setAiReportGeneratedAt(new Date().toLocaleString(getShellDeskLocale()));
      setAiReportPhase('done');
    } catch (err) {
      setAiReportPhase('error');
      setAiReportError(t('process.ai.requestFailed', language, { error: getErrorMessage(err) }));
    }
  }, [isAiReportBusy, isWindowsHost, language, processes, settings]);

  const requestProcessInsight = useCallback(async () => {
    if (!selectedProcess || processInsightLoadingPid !== null) {
      return;
    }

    const readinessError = getAiReadinessError(settings, language);

    if (readinessError) {
      setProcessInsight({ pid: selectedProcess.pid, content: '', error: readinessError });
      return;
    }

    const aiControls = window.guiSSH?.ai;
    const detail = processDetail?.pid === selectedProcess.pid ? processDetail : null;
    const request = createAiChatRequest(settings, [
      { role: 'system', content: t('ai.process.insight.systemPrompt', language) },
      {
        role: 'user',
        content: [
          t('process.ai.insight.userPrompt', language),
          '',
          formatProcessContextForAi(selectedProcess, isWindowsHost, detail, selectedParent, selectedChildren, language),
        ].join('\n'),
      },
    ], 0.2);
    let streamedContent = '';

    setProcessInsightLoadingPid(selectedProcess.pid);
    setProcessInsight({ pid: selectedProcess.pid, content: t('process.ai.insight.loading', language) });

    try {
      let resultContent = '';

      if (aiControls?.chatStream) {
        try {
          const result = await aiControls.chatStream(request, {
            onChunk: (chunk) => {
              streamedContent += chunk;
              setProcessInsight({
                pid: selectedProcess.pid,
                content: streamedContent || t('process.ai.insight.loading', language),
              });
            },
          });
          resultContent = result.content || streamedContent;
        } catch (streamError) {
          if (streamedContent || !aiControls.chat) {
            throw streamError;
          }

          const result = await aiControls.chat(request);
          resultContent = result.content;
        }
      } else if (aiControls?.chat) {
        const result = await aiControls.chat(request);
        resultContent = result.content;
      }

      setProcessInsight({ pid: selectedProcess.pid, content: resultContent || t('process.ai.insight.empty', language) });
    } catch (err) {
      setProcessInsight({
        pid: selectedProcess.pid,
        content: '',
        error: t('process.ai.requestFailed', language, { error: getErrorMessage(err) }),
      });
    } finally {
      setProcessInsightLoadingPid(null);
    }
  }, [
    isWindowsHost,
    language,
    processDetail,
    processInsightLoadingPid,
    selectedChildren,
    selectedParent,
    selectedProcess,
    settings,
  ]);

  const copyAiReport = useCallback(async () => {
    if (!aiReportText.trim()) {
      return;
    }

    setAiReportNotice('');
    setAiReportError('');

    try {
      await navigator.clipboard.writeText(createAiReportDocument(aiReportText, aiReportGeneratedAt, aiReportSnapshotNote, language));
      setAiReportNotice(t('process.ai.report.copied', language));
    } catch (err) {
      setAiReportError(t('process.error.copyFailed', language, { error: getErrorMessage(err) }));
    }
  }, [aiReportGeneratedAt, aiReportSnapshotNote, aiReportText, language]);

  const exportAiReport = useCallback(async () => {
    if (!aiReportText.trim()) {
      return;
    }

    const saveTextFile = window.guiSSH?.files?.saveTextFile;

    if (!saveTextFile) {
      setAiReportError(t('process.ai.exportUnsupported', language));
      return;
    }

    setAiReportNotice('');
    setAiReportError('');

    try {
      const filePath = await saveTextFile({
        title: t('process.ai.exportTitle', language),
        defaultFileName: createAiReportFileName(),
        content: createAiReportDocument(aiReportText, aiReportGeneratedAt, aiReportSnapshotNote, language),
      });

      if (filePath) {
        setAiReportNotice(t('process.ai.exported', language, { path: filePath }));
      }
    } catch (err) {
      setAiReportError(t('process.ai.exportFailed', language, { error: getErrorMessage(err) }));
    }
  }, [aiReportGeneratedAt, aiReportSnapshotNote, aiReportText, language]);

  return {
    aiReportOpen,
    setAiReportOpen,
    aiReportPhase,
    aiReportText,
    aiReportError,
    setAiReportError,
    aiReportNotice,
    setAiReportNotice,
    aiReportSnapshotNote,
    processInsight,
    processInsightLoadingPid,
    isAiReportBusy,
    requestAiReport,
    requestProcessInsight,
    copyAiReport,
    exportAiReport,
  };
}
