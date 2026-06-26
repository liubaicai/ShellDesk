import { useCallback, useRef, useState } from 'react';
import { t } from '../i18n';
import { createMessageId, getAiConfig, isAiConfigured, sendChat, sendChatStream } from './aiService';
import type { AppLanguage } from '../i18n';
import type { AiChatOptions, AiMessage } from './types';

interface UseAiChatOptions {
  settings: ShellDeskAppSettings;
  language: AppLanguage;
  systemPrompt?: string;
  chatOptions?: AiChatOptions;
  maxHistory?: number;
}

export function useAiChat({
  settings,
  language,
  systemPrompt,
  chatOptions,
  maxHistory = 50,
}: UseAiChatOptions) {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const isConfigured = isAiConfigured(settings);

  const sendMessage = useCallback(async (userContent: string) => {
    if (!isConfigured) {
      setError(t('auto.aiChat.notConfiguredError', language));
      return;
    }

    const trimmedContent = userContent.trim();

    if (!trimmedContent || isBusy) {
      return;
    }

    const userMessage: AiMessage = {
      id: createMessageId(),
      role: 'user',
      content: trimmedContent,
      createdAt: new Date().toISOString(),
    };
    const historySnapshot = [...messages, userMessage].slice(-maxHistory);

    setMessages((prev) => [...prev, userMessage]);
    setIsBusy(true);
    setError('');
    abortRef.current = new AbortController();

    try {
      const config = getAiConfig(settings);
      const assistantId = createMessageId();
      const assistantCreatedAt = new Date().toISOString();
      const apiMessages: ShellDeskAiChatMessage[] = [];
      const effectiveSystemPrompt = chatOptions?.systemPrompt ?? systemPrompt;

      if (effectiveSystemPrompt) {
        apiMessages.push({ role: 'system', content: effectiveSystemPrompt });
      }

      for (const message of historySnapshot) {
        apiMessages.push({ role: message.role, content: message.content });
      }

      let streamedContent = '';

      try {
        const result = await sendChatStream(config, apiMessages, (chunk) => {
          streamedContent += chunk;
          setMessages((prev) => {
            const assistantMessage: AiMessage = {
              id: assistantId,
              role: 'assistant',
              content: streamedContent,
              createdAt: assistantCreatedAt,
            };

            return prev.some((message) => message.id === assistantId)
              ? prev.map((message) => (message.id === assistantId ? assistantMessage : message))
              : [...prev, assistantMessage];
          });
        }, chatOptions);

        if (result && result !== streamedContent) {
          setMessages((prev) => {
            const assistantMessage: AiMessage = {
              id: assistantId,
              role: 'assistant',
              content: result,
              createdAt: assistantCreatedAt,
            };

            return prev.some((message) => message.id === assistantId)
              ? prev.map((message) => (message.id === assistantId ? assistantMessage : message))
              : [...prev, assistantMessage];
          });
        }
      } catch {
        if (!streamedContent) {
          const result = await sendChat(config, apiMessages, chatOptions);
          setMessages((prev) => [...prev, {
            id: assistantId,
            role: 'assistant',
            content: result,
            createdAt: assistantCreatedAt,
          }]);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
      setIsBusy(false);
    }
  }, [chatOptions, isBusy, isConfigured, language, maxHistory, messages, settings, systemPrompt]);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setError('');
  }, []);

  const cancelRequest = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsBusy(false);
  }, []);

  return {
    messages,
    isBusy,
    error,
    isConfigured,
    sendMessage,
    clearHistory,
    cancelRequest,
    setError,
    setMessages,
  };
}
