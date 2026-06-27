import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { completeAiRequest, isAiConfigured, streamAiResponse } from '../../ai';
import { t, translateStructuredText, type AppLanguage } from '../../i18n';
import { getErrorMessage } from './desktopUtils';
import {
  createNotepadAiMessageId,
  formatCommandResult,
  getEnvironmentProbeCommand,
  limitAiFileContext,
  MAX_AI_ENVIRONMENT_CHARACTERS,
  MAX_AI_FILE_CONTEXT_CHARACTERS,
  MAX_AI_HISTORY_MESSAGES,
  MAX_AI_SELECTION_CHARACTERS,
  parseAiAction,
  splitAiFileContext,
  stripAiActionBlocks,
  truncateMiddle,
} from './notepadAiUtils';
import type {
  EditorSelectionSnapshot,
  NotepadAiAction,
  NotepadAiMessage,
  NotepadTab,
} from './notepadTypes';
import type { RemoteSystemType } from './types';

interface NotepadAiPanelProps {
  activeTab: NotepadTab;
  connectionId: string;
  cursorLine: number;
  cursorCol: number;
  getCurrentEditorSelection: () => EditorSelectionSnapshot;
  isConfigured: boolean;
  language: AppLanguage;
  settings: ShellDeskAppSettings;
  systemType?: RemoteSystemType;
  onApply: (action: Exclude<NotepadAiAction, { type: 'run_command' }>, selection: EditorSelectionSnapshot) => void;
  onClose: () => void;
}

type NotepadPiMessage = {
  role: 'user' | 'assistant' | 'toolResult';
  content: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

function useAiAutoScroll(
  isBusy: boolean,
  messages: NotepadAiMessage[],
  messagesEndRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [isBusy, messages, messagesEndRef]);
}

export default function NotepadAiPanel({
  activeTab,
  connectionId,
  cursorLine,
  cursorCol,
  getCurrentEditorSelection,
  isConfigured,
  language,
  settings,
  systemType,
  onApply,
  onClose,
}: NotepadAiPanelProps) {
  const [aiInput, setAiInput] = useState('');
  const [aiMessages, setAiMessages] = useState<NotepadAiMessage[]>([]);
  const [isAiBusy, setIsAiBusy] = useState(false);
  const [isAiProbing, setIsAiProbing] = useState(false);
  const [aiError, setAiError] = useState('');
  const [remoteEnvironment, setRemoteEnvironment] = useState('');
  const [includeAiFileContext, setIncludeAiFileContext] = useState(true);
  const [lastAiSelection, setLastAiSelection] = useState<EditorSelectionSnapshot | null>(null);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);
  const aiMessagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    aiInputRef.current?.focus();
  }, []);

  useAiAutoScroll(isAiBusy, aiMessages, aiMessagesEndRef);

  const buildAiContextMessage = useCallback((
    selection: EditorSelectionSnapshot,
    options?: { environmentOverride?: string },
  ) => {
    const filePath = activeTab.filePath || t('notepad.ai.context.unsavedFile', language);
    const selectedText = selection.text
      ? truncateMiddle(selection.text, MAX_AI_SELECTION_CHARACTERS, language)
      : t('notepad.ai.context.noSelection', language);
    const environmentSource = options?.environmentOverride ?? remoteEnvironment;
    const environmentContext = environmentSource
      ? truncateMiddle(environmentSource, MAX_AI_ENVIRONMENT_CHARACTERS, language)
      : t('notepad.ai.context.notProbed', language);
    let fileContextState = t('notepad.ai.context.fileContextCancelled', language);

    if (includeAiFileContext) {
      const fileContext = limitAiFileContext(activeTab.content, language);
      const chunkCount = splitAiFileContext(fileContext.content).length;
      fileContextState = fileContext.truncated
        ? t('notepad.ai.context.fileContextTruncated', language, {
            limit: MAX_AI_FILE_CONTEXT_CHARACTERS,
            chunks: chunkCount,
            omitted: fileContext.omittedCharacters,
          })
        : t('notepad.ai.context.fileContextComplete', language, { chunks: chunkCount });
    }

    return [
      t('notepad.ai.context.header', language),
      t('notepad.ai.context.fileTitle', language, { title: activeTab.title }),
      t('notepad.ai.context.remotePath', language, { path: filePath }),
      t('notepad.ai.context.languageMode', language, { language: activeTab.language }),
      t('notepad.ai.context.fileCharacters', language, { count: activeTab.content.length }),
      t('notepad.ai.context.readOnlyStatus', language, {
        status: activeTab.readOnly
          ? t('notepad.ai.context.readOnly', language)
          : t('notepad.ai.context.editable', language),
      }),
      t('notepad.ai.context.cursor', language, { line: cursorLine, column: cursorCol }),
      t('notepad.ai.context.selectionRange', language, { start: selection.start, end: selection.end }),
      '',
      t('notepad.ai.context.selectedTextHeader', language),
      selectedText,
      '',
      t('notepad.ai.context.environmentHeader', language),
      environmentContext,
      '',
      t('notepad.ai.context.fileContextHeader', language),
      fileContextState,
    ].join('\n');
  }, [activeTab, cursorCol, cursorLine, includeAiFileContext, language, remoteEnvironment]);

  const buildAiFileContextMessages = useCallback((): NotepadPiMessage[] => {
    if (!includeAiFileContext) {
      return [];
    }

    const { content, truncated, omittedCharacters } = limitAiFileContext(activeTab.content, language);
    const chunks = splitAiFileContext(content);
    const filePath = activeTab.filePath || t('notepad.ai.context.unsavedFile', language);

    return chunks.map((chunk, index) => ({
      role: 'user',
      content: [
        t('notepad.ai.context.chunkHeader', language, { index: index + 1, total: chunks.length }),
        t('notepad.ai.context.fileTitle', language, { title: activeTab.title }),
        t('notepad.ai.context.remotePath', language, { path: filePath }),
        t('notepad.ai.context.languageMode', language, { language: activeTab.language }),
        t('notepad.ai.context.fullCharacters', language, { count: activeTab.content.length }),
        truncated
          ? t('notepad.ai.context.truncationTruncated', language, { limit: MAX_AI_FILE_CONTEXT_CHARACTERS, omitted: omittedCharacters })
          : t('notepad.ai.context.truncationNone', language),
        '```',
        chunk,
        '```',
      ].join('\n'),
    }));
  }, [activeTab, includeAiFileContext, language]);

  const createAiContext = useCallback((
    nextMessages: NotepadAiMessage[],
    selection: EditorSelectionSnapshot,
    options?: { environmentOverride?: string },
  ): { systemPrompt: string; messages: NotepadPiMessage[]; temperature: number } => {
    const recentMessages = nextMessages.slice(-MAX_AI_HISTORY_MESSAGES).map<NotepadPiMessage>((message) => {
      if (message.role === 'tool') {
        return {
          role: 'toolResult',
          toolCallId: message.id,
          toolName: 'shelldesk',
          content: `${t('ai.tool.resultPrefix', language)}\n${message.content}`,
        };
      }

      return {
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      };
    });
    const fileContextMessages = buildAiFileContextMessages().map((message) => ({
      ...message,
      content: translateStructuredText(message.content, settings.language),
    }));

    return {
      systemPrompt: translateStructuredText(t('ai.notepad.systemPrompt', language), language),
      messages: [
        { role: 'user', content: translateStructuredText(buildAiContextMessage(selection, options), language) },
        ...fileContextMessages,
        ...recentMessages,
      ],
      temperature: 0.2,
    };
  }, [buildAiContextMessage, buildAiFileContextMessages, language, settings.language]);

  const runRemoteEnvironmentProbe = useCallback(async () => {
    const command = getEnvironmentProbeCommand(systemType);
    const result = await window.guiSSH!.connections.runCommand(connectionId, command);
    return formatCommandResult(command, result, language);
  }, [connectionId, language, systemType]);

  const requestAiAssistant = useCallback(async (
    nextMessages: NotepadAiMessage[],
    selection: EditorSelectionSnapshot,
    options?: { environmentOverride?: string },
  ) => {
    if (!isAiConfigured(settings)) {
      setAiError(t('notepad.error.aiConfigRequired', language));
      return;
    }

    setIsAiBusy(true);
    setAiError('');

    try {
      const context = createAiContext(nextMessages, selection, options);
      const assistantMessageId = createNotepadAiMessageId();
      const assistantCreatedAt = new Date().toISOString();
      let streamedContent = '';

      const updatePartialMessage = (content: string) => {
        streamedContent = content;
        const partialContent = stripAiActionBlocks(content) || t('notepad.ai.generating', language);
        const partialMessage: NotepadAiMessage = {
          id: assistantMessageId,
          role: 'assistant',
          content: partialContent,
          createdAt: assistantCreatedAt,
        };

        setAiMessages((currentMessages) => {
          const existingIndex = currentMessages.findIndex((message) => message.id === assistantMessageId);

          if (existingIndex >= 0) {
            return currentMessages.map((message) => (
              message.id === assistantMessageId ? { ...message, content: partialContent } : message
            ));
          }

          return [...currentMessages, partialMessage];
        });
      };
      const resultContent = await streamAiResponse(settings, context, updatePartialMessage)
        .catch(async (streamError) => {
          if (streamedContent) {
            throw streamError;
          }

          return completeAiRequest(settings, context);
        });

      const action = parseAiAction(resultContent);
      const displayContent = stripAiActionBlocks(resultContent) || (action ? t('notepad.ai.actionReady', language) : resultContent);
      const assistantMessage: NotepadAiMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: displayContent,
        createdAt: assistantCreatedAt,
        action,
      };

      setAiMessages([...nextMessages, assistantMessage]);
    } catch (error) {
      setAiError(t('notepad.error.aiRequestFailed', language, { error: getErrorMessage(error) }));
      setAiMessages(nextMessages);
    } finally {
      setIsAiBusy(false);
    }
  }, [
    createAiContext,
    language,
    settings,
  ]);

  const handleAiSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const prompt = aiInput.trim();
    if (!prompt || isAiBusy || isAiProbing) {
      return;
    }

    if (!isConfigured) {
      setAiError(t('notepad.error.aiConfigRequired', language));
      return;
    }

    const selection = getCurrentEditorSelection();
    setLastAiSelection(selection);
    const userMessage: NotepadAiMessage = {
      id: createNotepadAiMessageId(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
    };
    let nextMessages = [...aiMessages, userMessage];
    let environmentOverride = remoteEnvironment || undefined;

    setAiInput('');
    setAiMessages(nextMessages);

    if (!environmentOverride) {
      setIsAiProbing(true);
      setAiError('');

      try {
        const toolContent = await runRemoteEnvironmentProbe();

        environmentOverride = toolContent;
        setRemoteEnvironment(toolContent);
      } catch (error) {
        const errorMessage = t('notepad.ai.probe.failed', language, { error: getErrorMessage(error) });

        environmentOverride = errorMessage;
        setAiError(errorMessage);
      } finally {
        setIsAiProbing(false);
      }
    }

    await requestAiAssistant(nextMessages, selection, { environmentOverride });
  }, [
    aiInput,
    aiMessages,
    getCurrentEditorSelection,
    isAiBusy,
    isConfigured,
    isAiProbing,
    language,
    remoteEnvironment,
    requestAiAssistant,
    runRemoteEnvironmentProbe,
  ]);

  const markAiActionApplied = useCallback((messageId: string) => {
    setAiMessages((currentMessages) => currentMessages.map((message) => (
      message.id === messageId ? { ...message, actionApplied: true } : message
    )));
  }, []);

  const applyAiTextAction = useCallback((message: NotepadAiMessage) => {
    const action = message.action;

    if (!action || action.type === 'run_command') {
      return;
    }

    if (activeTab.readOnly) {
      setAiError(t('notepad.error.aiReadOnlyApply', language));
      return;
    }

    const selection = lastAiSelection ?? getCurrentEditorSelection();
    onApply(action, selection);
    markAiActionApplied(message.id);
  }, [activeTab.readOnly, getCurrentEditorSelection, language, lastAiSelection, markAiActionApplied, onApply]);

  const runAiCommandAction = useCallback(async (message: NotepadAiMessage) => {
    const action = message.action;

    if (!action || action.type !== 'run_command' || isAiBusy) {
      return;
    }

    setIsAiBusy(true);
    setAiError('');

    try {
      const result = await window.guiSSH!.connections.runCommand(connectionId, action.command);
      const toolContent = formatCommandResult(action.command, result, language);
      const toolMessage: NotepadAiMessage = {
        id: createNotepadAiMessageId(),
        role: 'tool',
        content: toolContent,
        createdAt: new Date().toISOString(),
      };
      const selection = getCurrentEditorSelection();
      const nextMessages = aiMessages.map((currentMessage) => (
        currentMessage.id === message.id ? { ...currentMessage, actionApplied: true } : currentMessage
      ));
      const continuedMessages = [...nextMessages, toolMessage];

      setLastAiSelection(selection);
      setRemoteEnvironment((currentEnvironment) => (
        currentEnvironment ? `${currentEnvironment}\n\n${toolContent}` : toolContent
      ));
      setAiMessages(continuedMessages);
      await requestAiAssistant(continuedMessages, selection);
    } catch (error) {
      setAiError(t('notepad.error.commandFailed', language, { error: getErrorMessage(error) }));
    } finally {
      setIsAiBusy(false);
    }
  }, [aiMessages, connectionId, getCurrentEditorSelection, isAiBusy, language, requestAiAssistant]);

  return (
    <aside className="notepad-ai-sidebar" aria-label={t('notepad.ai.sidebar.aria', language)}>
      <div className="notepad-ai-header">
        <span>
          <strong>SD-Agent</strong>
        </span>
        <button type="button" className="notepad-ai-close" onClick={onClose} aria-label={t('notepad.ai.sidebar.closeAria', language)}>×</button>
      </div>

      {!isConfigured ? (
        <div className="notepad-ai-warning">
          {t('notepad.ai.configWarning', language)}
        </div>
      ) : null}

      {aiError ? <div className="notepad-ai-error">{aiError}</div> : null}

      <div className="notepad-ai-messages">
        {aiMessages.length === 0 ? (
          <div className="notepad-ai-empty">
            <strong>{t('notepad.ai.empty.title', language)}</strong>
            <span>{t('notepad.ai.empty.summary', language)}</span>
          </div>
        ) : null}

        {aiMessages.map((message) => (
          <div key={message.id} className={`notepad-ai-message ${message.role}`}>
            <div className="notepad-ai-message-role">
              {message.role === 'assistant' ? 'SD-Agent' : message.role === 'tool' ? t('notepad.ai.role.tool', language) : t('notepad.ai.role.user', language)}
            </div>
            <div className="notepad-ai-message-content">{message.content}</div>
            {message.action ? (
              <div className="notepad-ai-action">
                {message.action.type === 'run_command' ? (
                  <>
                    <strong>{t('notepad.ai.requestCommand', language)}</strong>
                    {message.action.reason ? <span>{message.action.reason}</span> : null}
                    <code>{message.action.command}</code>
                    <button
                      type="button"
                      className="notepad-modal-btn primary"
                      onClick={() => void runAiCommandAction(message)}
                      disabled={message.actionApplied || isAiBusy}
                    >
                      {message.actionApplied ? t('notepad.ai.executed', language) : t('notepad.ai.confirmExecute', language)}
                    </button>
                  </>
                ) : (
                  <>
                    <strong>{message.action.summary || t('notepad.ai.applyFallback', language)}</strong>
                    <span>
                      {message.action.type === 'replace_content'
                        ? t('notepad.ai.action.replaceContent', language)
                        : message.action.type === 'replace_selection'
                          ? t('notepad.ai.action.replaceSelection', language)
                          : message.action.type === 'append_content'
                            ? t('notepad.ai.action.appendContent', language)
                            : t('notepad.ai.action.insertAtCursor', language)}
                    </span>
                    <button
                      type="button"
                      className="notepad-modal-btn primary"
                      onClick={() => applyAiTextAction(message)}
                      disabled={message.actionApplied || activeTab.readOnly}
                    >
                      {message.actionApplied ? t('notepad.ai.applied', language) : t('notepad.ai.applyChange', language)}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ))}
        {isAiProbing ? <div className="notepad-ai-thinking">{t('notepad.ai.probing', language)}</div> : null}
        {!isAiProbing && isAiBusy ? <div className="notepad-ai-thinking">{t('notepad.ai.thinking', language)}</div> : null}
        <div ref={aiMessagesEndRef} />
      </div>

      <form className="notepad-ai-compose" onSubmit={handleAiSubmit}>
        <textarea
          ref={aiInputRef}
          value={aiInput}
          onChange={(event) => setAiInput(event.target.value)}
          placeholder={t('notepad.ai.placeholder', language)}
          rows={4}
          disabled={isAiBusy || isAiProbing}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="notepad-ai-compose-footer">
          <label className="notepad-ai-context-toggle">
            <input
              type="checkbox"
              checked={includeAiFileContext}
              onChange={(event) => setIncludeAiFileContext(event.target.checked)}
            />
            <span>{t('notepad.ai.includeFileContext', language)}</span>
          </label>
          <button type="submit" className="notepad-modal-btn primary" disabled={!aiInput.trim() || isAiBusy || isAiProbing || !isConfigured}>
            {t('notepad.ai.send', language)}
          </button>
        </div>
      </form>
    </aside>
  );
}
