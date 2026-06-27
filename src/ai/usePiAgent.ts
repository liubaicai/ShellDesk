import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssistantMessage, Message, Usage } from '@earendil-works/pi-ai';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { t, type AppLanguage } from '../i18n';
import {
  createMessageId,
  createModelsForSettings,
  getAiApiKey,
  getAiModel,
  isAiConfigured,
} from './PiAgentService';
import type { AiMessage, AiTokenUsage } from './types';

interface UsePiAgentConfig {
  settings: ShellDeskAppSettings;
  language: AppLanguage;
  systemPrompt: string;
  tools?: AgentTool[];
  connectionId?: string;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return typeof message === 'object' && message !== null && 'role' in message && message.role === 'assistant';
}

function isLlmMessage(message: AgentMessage): message is Message {
  return typeof message === 'object'
    && message !== null
    && 'role' in message
    && (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult');
}

function getMessageText(message: AgentMessage): string {
  if (!message || typeof message !== 'object' || !('content' in message)) {
    return '';
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}

function usageToTokenUsage(usage: Usage): AiTokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cost: usage.cost.total,
  };
}

function upsertMessage(messages: AiMessage[], message: AiMessage): AiMessage[] {
  return messages.some((existing) => existing.id === message.id)
    ? messages.map((existing) => (existing.id === message.id ? message : existing))
    : [...messages, message];
}

function createAgent(config: UsePiAgentConfig): Agent | null {
  if (!isAiConfigured(config.settings)) {
    return null;
  }

  const models = createModelsForSettings(config.settings);
  const model = getAiModel(config.settings, models);
  const apiKey = getAiApiKey(config.settings);

  return new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      tools: config.tools ?? [],
    },
    streamFn: models.streamSimple.bind(models),
    getApiKey: () => apiKey,
    convertToLlm: (messages) => messages.filter(isLlmMessage),
  });
}

export function usePiAgent(config: UsePiAgentConfig) {
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState('');
  const [tokenUsage, setTokenUsage] = useState<AiTokenUsage | null>(null);
  const agentRef = useRef<Agent | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const assistantMessageIdsRef = useRef(new WeakMap<AssistantMessage, string>());
  const isMountedRef = useRef(true);
  const isConfigured = isAiConfigured(config.settings);

  const agentKey = useMemo(() => JSON.stringify({
    provider: config.settings.aiProvider,
    apiFormat: config.settings.aiApiFormat,
    apiBaseUrl: config.settings.aiApiBaseUrl,
    apiKey: config.settings.aiApiKey,
    model: config.settings.aiModel,
    systemPrompt: config.systemPrompt,
    connectionId: config.connectionId,
    toolNames: (config.tools ?? []).map((tool) => tool.name),
  }), [config.connectionId, config.settings, config.systemPrompt, config.tools]);

  const disposeAgent = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    agentRef.current?.abort();
    agentRef.current = null;
    assistantMessageIdsRef.current = new WeakMap();
  }, []);

  const ensureAgent = useCallback(() => {
    if (agentRef.current) {
      return agentRef.current;
    }

    const agent = createAgent(config);

    if (!agent) {
      return null;
    }

    unsubscribeRef.current = agent.subscribe((event: AgentEvent) => {
      if (!isMountedRef.current) {
        return;
      }

      if (event.type === 'agent_start') {
        setIsBusy(true);
        setError('');
        return;
      }

      if (event.type === 'message_start' && isAssistantMessage(event.message)) {
        assistantMessageIdsRef.current.set(event.message, createMessageId());
        return;
      }

      if (event.type === 'message_update' && isAssistantMessage(event.message)) {
        const id = assistantMessageIdsRef.current.get(event.message) ?? createMessageId();
        assistantMessageIdsRef.current.set(event.message, id);
        setMessages((prev) => upsertMessage(prev, {
          id,
          role: 'assistant',
          content: getMessageText(event.message),
          createdAt: new Date(event.message.timestamp || Date.now()).toISOString(),
        }));
        return;
      }

      if (event.type === 'message_end' && isAssistantMessage(event.message)) {
        const id = assistantMessageIdsRef.current.get(event.message) ?? createMessageId();
        assistantMessageIdsRef.current.set(event.message, id);
        setMessages((prev) => upsertMessage(prev, {
          id,
          role: 'assistant',
          content: getMessageText(event.message),
          createdAt: new Date(event.message.timestamp || Date.now()).toISOString(),
        }));

        if (event.message.usage) {
          setTokenUsage(usageToTokenUsage(event.message.usage));
        }

        if (event.message.stopReason === 'error' && event.message.errorMessage) {
          setError(event.message.errorMessage);
        }
        return;
      }

      if (event.type === 'tool_execution_start') {
        setMessages((prev) => [...prev, {
          id: createMessageId(),
          role: 'assistant',
          content: t('auto.aiChat.toolRunning', config.language, { value0: event.toolName }),
          createdAt: new Date().toISOString(),
        }]);
        return;
      }

      if (event.type === 'tool_execution_end' && event.isError) {
        setError(t('auto.aiChat.toolFailed', config.language, { value0: event.toolName }));
        return;
      }

      if (event.type === 'agent_end') {
        setIsBusy(false);
      }
    });

    agentRef.current = agent;
    return agent;
  }, [config]);

  useEffect(() => {
    disposeAgent();
    setMessages([]);
    setError('');
    setIsBusy(false);
    setTokenUsage(null);

    return disposeAgent;
  }, [agentKey, disposeAgent]);

  useEffect(() => () => {
    isMountedRef.current = false;
    disposeAgent();
  }, [disposeAgent]);

  const sendMessage = useCallback(async (content: string) => {
    const trimmedContent = content.trim();

    if (!trimmedContent || isBusy) {
      return;
    }

    if (!isConfigured) {
      setError(t('auto.aiChat.notConfiguredError', config.language));
      return;
    }

    const agent = ensureAgent();

    if (!agent) {
      setError(t('auto.aiChat.notConfiguredError', config.language));
      return;
    }

    const userMessage: AiMessage = {
      id: createMessageId(),
      role: 'user',
      content: trimmedContent,
      createdAt: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setError('');
    setIsBusy(true);

    try {
      await agent.prompt(trimmedContent);
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (isMountedRef.current) {
        setIsBusy(false);
      }
    }
  }, [config.language, ensureAgent, isBusy, isConfigured]);

  const cancelRequest = useCallback(() => {
    agentRef.current?.abort();
    setIsBusy(false);
  }, []);

  const clearHistory = useCallback(() => {
    disposeAgent();
    setMessages([]);
    setError('');
    setIsBusy(false);
    setTokenUsage(null);
  }, [disposeAgent]);

  return {
    messages,
    isBusy,
    error,
    isConfigured,
    sendMessage,
    cancelRequest,
    clearHistory,
    tokenUsage,
  };
}
