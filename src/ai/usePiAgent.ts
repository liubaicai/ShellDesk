import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  ToolCall,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';
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
  conversationId?: string;
  initialMessages?: AiMessage[];
}

const AI_PROVIDER_TIMEOUT_MS = 45000;

interface BackendMessageCommitOptions {
  partial?: boolean;
}

type BackendMessageCommit = (message: AssistantMessage, options?: BackendMessageCommitOptions) => void;

interface SendMessageOptions {
  retryFromMessageId?: string;
}

export interface AiToolActivity {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
}

export type AiConversationStatus = 'idle' | 'running' | 'success' | 'error';

interface AgentConversationState {
  messages: AiMessage[];
  isBusy: boolean;
  busyText: string;
  error: string;
  tokenUsage: AiTokenUsage | null;
  toolActivities: AiToolActivity[];
  status: AiConversationStatus;
}

interface AgentRuntime {
  agent: Agent;
  unsubscribe: () => void;
  assistantMessageIds: WeakMap<AssistantMessage, string>;
  messageIdToAgentMessage: Map<string, AgentMessage>;
  modelId: string;
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

function hasToolCalls(message: AssistantMessage): boolean {
  return Array.isArray(message.content) && message.content.some((content) => content.type === 'toolCall');
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

function createAgent(
  config: UsePiAgentConfig,
  onBackendMessage?: BackendMessageCommit,
): Agent | null {
  if (!isAiConfigured(config.settings)) {
    return null;
  }

  const models = createModelsForSettings(config.settings);
  const model = getAiModel(config.settings, models);
  const apiKey = getAiApiKey(config.settings);

  const agent = new Agent({
    initialState: {
      systemPrompt: config.systemPrompt,
      model,
      tools: config.tools ?? [],
    },
    streamFn: (window.guiSSH?.ai?.chatStream || window.guiSSH?.ai?.chat)
      ? createBackendStreamFn(config.settings, onBackendMessage)
      : (streamModel, context, options) => models.streamSimple(streamModel, context, {
        ...options,
        timeoutMs: AI_PROVIDER_TIMEOUT_MS,
        maxRetries: 0,
      }),
    getApiKey: () => apiKey,
    convertToLlm: (messages) => messages.filter(isLlmMessage),
  });

  if (config.initialMessages?.length) {
    agent.state.messages = config.initialMessages.flatMap((message): AgentMessage[] => {
      if (message.role === 'user') {
        return [{ role: 'user', content: message.content, timestamp: Date.parse(message.createdAt) || Date.now() } satisfies UserMessage];
      }
      if (message.role === 'assistant') {
        return [createAssistantMessage(model, message.content, [])];
      }
      return [];
    });
  }

  return agent;
}

function usageZero(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function messageContentText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}

function toolCallSummary(toolCall: ToolCall): string {
  return `Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`;
}

function messageToolCalls(message: AssistantMessage): ShellDeskAiToolCall[] {
  return message.content
    .filter((content): content is ToolCall => content.type === 'toolCall')
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    }));
}

function sanitizeChatToolMessages(messages: ShellDeskAiChatMessage[]): ShellDeskAiChatMessage[] {
  const sanitizedMessages: ShellDeskAiChatMessage[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (message.role === 'tool') {
      index += 1;
      continue;
    }

    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      sanitizedMessages.push(message);
      index += 1;
      continue;
    }

    const toolCallIds = new Set(message.toolCalls.map((toolCall) => toolCall.id));
    const matchingToolMessages: ShellDeskAiChatMessage[] = [];
    let nextIndex = index + 1;

    while (nextIndex < messages.length && messages[nextIndex].role === 'tool') {
      const toolMessage = messages[nextIndex];
      if (toolMessage.toolCallId && toolCallIds.has(toolMessage.toolCallId)) {
        matchingToolMessages.push(toolMessage);
      }
      nextIndex += 1;
    }

    if (matchingToolMessages.length) {
      const matchedToolCallIds = new Set(matchingToolMessages.map((toolMessage) => toolMessage.toolCallId));
      sanitizedMessages.push({
        ...message,
        toolCalls: message.toolCalls.filter((toolCall) => matchedToolCallIds.has(toolCall.id)),
      });
      sanitizedMessages.push(...matchingToolMessages);
      index = nextIndex;
      continue;
    }

    const { toolCalls: _toolCalls, ...messageWithoutToolCalls } = message;
    sanitizedMessages.push(messageWithoutToolCalls);
    index += 1;
  }

  return sanitizedMessages;
}

function contextToChatMessages(systemPrompt: string | undefined, messages: Message[]): ShellDeskAiChatMessage[] {
  const chatMessages: ShellDeskAiChatMessage[] = [];

  if (systemPrompt?.trim()) {
    chatMessages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  for (const message of messages.slice(-16)) {
    if (message.role === 'user') {
      chatMessages.push({
        role: 'user',
        content: messageContentText(message),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const text = messageContentText(message);
      const toolCalls = messageToolCalls(message);
      const fallbackContent = [text, ...toolCalls.map((toolCall) => toolCallSummary({
        type: 'toolCall',
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      }))].filter(Boolean).join('\n\n');

      if (text.trim() || toolCalls.length > 0) {
        chatMessages.push({
          role: 'assistant',
          content: text || fallbackContent,
          toolCalls,
        });
      }
      continue;
    }

    if (message.role === 'toolResult') {
      chatMessages.push({
        role: 'tool',
        content: messageContentText(message),
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      });
    }
  }

  return sanitizeChatToolMessages(chatMessages.filter((message) => message.content.trim()));
}

function createAssistantMessage(
  model: Model<Api>,
  content: string,
  toolCalls: ShellDeskAiToolCall[],
  stopReason: AssistantMessage['stopReason'] = toolCalls.length ? 'toolUse' : 'stop',
): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [
      ...(content.trim() ? [{ type: 'text' as const, text: content }] : []),
      ...toolCalls.map((toolCall) => ({
        type: 'toolCall' as const,
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      })),
    ],
    usage: usageZero(),
    stopReason,
    timestamp: Date.now(),
  };
}

function createErrorAssistantMessage(model: Model<Api>, error: unknown): AssistantMessage {
  return {
    ...createAssistantMessage(model, '', [], 'error'),
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

async function requestBackendAssistantMessage(
  settings: ShellDeskAppSettings,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  onChunk?: (content: string) => void,
): Promise<AssistantMessage> {
  const backendChat = window.guiSSH?.ai?.chat;
  const backendChatStream = window.guiSSH?.ai?.chatStream;

  if (!backendChat && !backendChatStream) {
    return createErrorAssistantMessage(model, new Error('AI backend is unavailable'));
  }

  let timeoutId: number | undefined;
  let rejectTimeout: ((reason?: unknown) => void) | undefined;

  try {
    if (options?.signal?.aborted) {
      throw new Error('Request was aborted');
    }

    const resetTimeout = () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(() => rejectTimeout?.(new Error('AI request timed out.')), AI_PROVIDER_TIMEOUT_MS);
    };
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
      resetTimeout();
    });
    const request: ShellDeskAiChatRequest = {
      provider: settings.aiProvider,
      apiFormat: settings.aiApiFormat,
      apiBaseUrl: settings.aiApiBaseUrl,
      apiKey: settings.aiApiKey,
      model: settings.aiModel || model.id,
      messages: contextToChatMessages(context.systemPrompt, context.messages),
      tools: context.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      temperature: options?.temperature ?? 0.2,
    };
    let streamedContent = '';
    const requestPromise = backendChatStream
      ? backendChatStream(request, {
        onChunk: (chunk) => {
          if (options?.signal?.aborted) {
            return;
          }
          streamedContent += chunk;
          onChunk?.(streamedContent);
          resetTimeout();
        },
      })
      : backendChat?.(request);

    if (!requestPromise) {
      throw new Error('AI backend is unavailable');
    }

    const result = await Promise.race([requestPromise, timeout]);

    if (options?.signal?.aborted) {
      throw new Error('Request was aborted');
    }

    return createAssistantMessage(model, result.content ?? streamedContent, result.toolCalls ?? []);
  } catch (error) {
    return createErrorAssistantMessage(model, error);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

function createAssistantEvents(message: AssistantMessage): AssistantMessageEvent[] {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    return [{ type: 'error', reason: message.stopReason, error: message }];
  }

  return [{
    type: 'done',
    reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
    message,
  }];
}

function createBackendStreamFn(
  settings: ShellDeskAppSettings,
  onBackendMessage?: BackendMessageCommit,
) {
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const streamingMessage = createAssistantMessage(model, '', [], 'stop');
    const finalMessagePromise = requestBackendAssistantMessage(settings, model, context, options, (content) => {
      Object.assign(streamingMessage, createAssistantMessage(model, content, [], 'stop'));
      onBackendMessage?.(streamingMessage, { partial: true });
    })
      .then((message) => {
        Object.assign(streamingMessage, message);
        onBackendMessage?.(streamingMessage);
        return streamingMessage;
      });
    return {
      async *[Symbol.asyncIterator]() {
        const message = await finalMessagePromise;
        for (const event of createAssistantEvents(message)) {
          yield event;
        }
      },
      result: () => finalMessagePromise,
    } as unknown as AssistantMessageEventStream;
  };
}

function createConversationState(initialMessages: AiMessage[] = []): AgentConversationState {
  return {
    messages: initialMessages,
    isBusy: false,
    busyText: '',
    error: '',
    tokenUsage: null,
    toolActivities: [],
    status: 'idle',
  };
}

export function usePiAgent(config: UsePiAgentConfig) {
  const conversationId = config.conversationId ?? '__default__';
  const configRef = useRef(config);
  configRef.current = config;
  const [conversationStates, setConversationStates] = useState<Record<string, AgentConversationState>>(() => ({
    [conversationId]: createConversationState(config.initialMessages ?? []),
  }));
  const conversationStatesRef = useRef(conversationStates);
  const runtimesRef = useRef(new Map<string, AgentRuntime>());
  const isMountedRef = useRef(true);
  const isConfigured = isAiConfigured(config.settings);

  const updateConversationState = useCallback((id: string, updater: (current: AgentConversationState) => AgentConversationState) => {
    setConversationStates((current) => {
      const next = { ...current, [id]: updater(current[id] ?? createConversationState()) };
      conversationStatesRef.current = next;
      return next;
    });
  }, []);

  const disposeRuntime = useCallback((id: string) => {
    const runtime = runtimesRef.current.get(id);
    if (!runtime) return;
    runtime.unsubscribe();
    runtime.agent.abort();
    runtimesRef.current.delete(id);
  }, []);

  const ensureAgent = useCallback((id: string, initialState: AgentConversationState) => {
    const existing = runtimesRef.current.get(id);
    const requestedModelId = configRef.current.settings.aiModel.trim();
    if (existing?.modelId === requestedModelId) return existing;
    if (existing) {
      if (initialState.isBusy) return existing;
      disposeRuntime(id);
    }

    const runtimeConfig = { ...configRef.current, conversationId: id, initialMessages: initialState.messages };
    const commitAssistantMessage: BackendMessageCommit = (message, options) => {
      const runtime = runtimesRef.current.get(id);
      if (!runtime) return;
      const messageId = runtime.assistantMessageIds.get(message) ?? createMessageId();
      runtime.assistantMessageIds.set(message, messageId);
      const content = getMessageText(message);

      updateConversationState(id, (current) => {
        const next = content.trim() ? {
          ...current,
          messages: upsertMessage(current.messages, {
            id: messageId,
            role: 'assistant',
            content,
            createdAt: new Date(message.timestamp || Date.now()).toISOString(),
          }),
        } : current;

        if (options?.partial) return next;
        if (message.stopReason === 'error' && message.errorMessage) {
          return { ...next, error: message.errorMessage, isBusy: false, busyText: '', status: 'error' };
        }
        if (!hasToolCalls(message)) {
          return { ...next, tokenUsage: message.usage ? usageToTokenUsage(message.usage) : next.tokenUsage, isBusy: false, busyText: '', status: 'success' };
        }
        return message.usage ? { ...next, tokenUsage: usageToTokenUsage(message.usage) } : next;
      });
      if (content.trim()) runtime.messageIdToAgentMessage.set(messageId, message);
    };

    const agent = createAgent(runtimeConfig, commitAssistantMessage);
    if (!agent) return null;

    const runtime: AgentRuntime = {
      agent,
      unsubscribe: () => undefined,
      assistantMessageIds: new WeakMap(),
      messageIdToAgentMessage: new Map(),
      modelId: requestedModelId,
    };
    const restoredMessages = runtimeConfig.initialMessages.filter((message) => message.role === 'user' || message.role === 'assistant');
    for (const [index, message] of restoredMessages.entries()) {
      const agentMessage = agent.state.messages[index];
      if (agentMessage) runtime.messageIdToAgentMessage.set(message.id, agentMessage);
    }
    runtime.unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (!isMountedRef.current) return;

      if (event.type === 'agent_start') {
        updateConversationState(id, (current) => ({ ...current, isBusy: true, busyText: t('auto.aiChat.thinking', runtimeConfig.language), error: '', status: 'running' }));
      } else if (event.type === 'message_start' && isAssistantMessage(event.message)) {
        if (!runtime.assistantMessageIds.has(event.message)) runtime.assistantMessageIds.set(event.message, createMessageId());
      } else if ((event.type === 'message_update' || event.type === 'message_end') && isAssistantMessage(event.message)) {
        commitAssistantMessage(event.message);
      } else if (event.type === 'tool_execution_start') {
        updateConversationState(id, (current) => ({
          ...current,
          isBusy: true,
          busyText: t('auto.aiChat.toolRunning', runtimeConfig.language, { value0: event.toolName }),
          status: 'running',
          toolActivities: [...current.toolActivities, { id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: event.toolName, status: 'running', startedAt: new Date().toISOString() }],
        }));
      } else if (event.type === 'tool_execution_end') {
        updateConversationState(id, (current) => event.isError
          ? { ...current, toolActivities: updateLatestToolActivity(current.toolActivities, event.toolName, 'failed'), error: t('auto.aiChat.toolFailed', runtimeConfig.language, { value0: event.toolName }), isBusy: false, busyText: '', status: 'error' }
          : { ...current, toolActivities: updateLatestToolActivity(current.toolActivities, event.toolName, 'completed'), busyText: t('auto.aiChat.thinking', runtimeConfig.language), status: 'running' });
      } else if (event.type === 'agent_end') {
        updateConversationState(id, (current) => ({ ...current, isBusy: false, busyText: '', status: current.status === 'error' ? 'error' : 'success' }));
      }
    });
    runtimesRef.current.set(id, runtime);
    return runtime;
  }, [disposeRuntime, updateConversationState]);

  useEffect(() => {
    if (conversationStatesRef.current[conversationId]) return;
    updateConversationState(conversationId, () => createConversationState(config.initialMessages ?? []));
  }, [config.initialMessages, conversationId, updateConversationState]);

  useEffect(() => () => {
    isMountedRef.current = false;
    for (const runtime of runtimesRef.current.values()) {
      runtime.unsubscribe();
      runtime.agent.abort();
    }
    runtimesRef.current.clear();
  }, []);

  const sendMessage = useCallback(async (content: string, options?: SendMessageOptions) => {
    const trimmedContent = content.trim();
    const currentState = conversationStatesRef.current[conversationId] ?? createConversationState(configRef.current.initialMessages ?? []);

    if (!trimmedContent || currentState.isBusy) {
      return;
    }

    if (!isConfigured) {
      updateConversationState(conversationId, (current) => ({ ...current, error: t('auto.aiChat.notConfiguredError', config.language), status: 'error' }));
      return;
    }

    const runtime = ensureAgent(conversationId, currentState);

    if (!runtime) {
      updateConversationState(conversationId, (current) => ({ ...current, error: t('auto.aiChat.notConfiguredError', config.language), status: 'error' }));
      return;
    }

    const timestamp = Date.now();
    const userMessage: AiMessage = {
      id: createMessageId(),
      role: 'user',
      content: trimmedContent,
      createdAt: new Date(timestamp).toISOString(),
    };
    const agentUserMessage: UserMessage = {
      role: 'user',
      content: trimmedContent,
      timestamp,
    };

    if (options?.retryFromMessageId) {
      const targetAgentMessage = runtime.messageIdToAgentMessage.get(options.retryFromMessageId);
      const targetAgentIndex = targetAgentMessage ? runtime.agent.state.messages.indexOf(targetAgentMessage) : -1;

      if (targetAgentIndex >= 0) {
        runtime.agent.state.messages = runtime.agent.state.messages.slice(0, targetAgentIndex);
      } else {
        runtime.agent.state.messages = [];
      }
    }

    runtime.messageIdToAgentMessage.set(userMessage.id, agentUserMessage);
    updateConversationState(conversationId, (current) => {
      const targetUiIndex = options?.retryFromMessageId
        ? current.messages.findIndex((message) => message.id === options.retryFromMessageId)
        : -1;
      const nextMessages = targetUiIndex >= 0 ? current.messages.slice(0, targetUiIndex) : current.messages;
      return { ...current, messages: [...nextMessages, userMessage], error: '', isBusy: true, busyText: t('auto.aiChat.thinking', config.language), status: 'running' };
    });

    try {
      await runtime.agent.prompt(agentUserMessage);
    } catch (err) {
      if (isMountedRef.current) {
        updateConversationState(conversationId, (current) => ({ ...current, error: err instanceof Error ? err.message : String(err), isBusy: false, busyText: '', status: 'error' }));
      }
    } finally {
      if (isMountedRef.current) {
        updateConversationState(conversationId, (current) => ({ ...current, isBusy: false, busyText: '', status: current.status === 'error' ? 'error' : 'success' }));
      }
    }
  }, [config.language, conversationId, ensureAgent, isConfigured, updateConversationState]);

  const cancelRequest = useCallback(() => {
    runtimesRef.current.get(conversationId)?.agent.abort();
    updateConversationState(conversationId, (current) => ({ ...current, isBusy: false, busyText: '', status: 'idle' }));
  }, [conversationId, updateConversationState]);

  const clearHistory = useCallback(() => {
    disposeRuntime(conversationId);
    updateConversationState(conversationId, () => createConversationState());
  }, [conversationId, disposeRuntime, updateConversationState]);

  const activeState = conversationStates[conversationId] ?? createConversationState(config.initialMessages ?? []);
  const conversationStatuses = Object.fromEntries(Object.entries(conversationStates).map(([id, state]) => [id, state.status]));
  const conversationMessages = Object.fromEntries(Object.entries(conversationStates).map(([id, state]) => [id, state.messages]));

  return {
    messages: activeState.messages,
    messageConversationId: conversationId,
    isBusy: activeState.isBusy,
    busyText: activeState.busyText,
    error: activeState.error,
    isConfigured,
    sendMessage,
    cancelRequest,
    clearHistory,
    tokenUsage: activeState.tokenUsage,
    toolActivities: activeState.toolActivities,
    conversationStatuses,
    conversationMessages,
  };
}

function updateLatestToolActivity(
  activities: AiToolActivity[],
  name: string,
  status: Extract<AiToolActivity['status'], 'completed' | 'failed'>,
) {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity.name === name && activity.status === 'running') {
      return activities.map((current, currentIndex) => (
        currentIndex === index
          ? { ...current, status, completedAt: new Date().toISOString() }
          : current
      ));
    }
  }

  return activities;
}
