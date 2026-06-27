import {
  type Api,
  createModels,
  createProvider,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Models,
  type Usage,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { AgentTool } from '@earendil-works/pi-agent-core';

type PiCustomModel = Model<'openai-completions' | 'anthropic-messages'>;
type PiRequestMessage = {
  role: 'user' | 'assistant' | 'toolResult';
  content: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};
type PiRequestContext = {
  systemPrompt: string;
  messages: PiRequestMessage[];
  tools?: AgentTool[];
  temperature?: number;
};
type PiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
};
type PiUsageSummary = {
  input: number;
  output: number;
  cost: number;
};

const CUSTOM_PROVIDER_ID = 'shelldesk-custom';
const modelsCache = new Map<string, Models>();

function isCustomAiProvider(provider: ShellDeskAiProvider) {
  return provider === 'custom' || provider === 'openai-compatible';
}

function getProviderId(settings: ShellDeskAppSettings): string {
  if (isCustomAiProvider(settings.aiProvider)) {
    return CUSTOM_PROVIDER_ID;
  }

  if (settings.aiProvider === 'anthropic' || settings.aiApiFormat === 'anthropic') {
    return 'anthropic';
  }

  if (settings.aiProvider === 'openai') {
    return 'openai';
  }

  return CUSTOM_PROVIDER_ID;
}

function createOpenAiCompatibleModel(settings: ShellDeskAppSettings): PiCustomModel {
  const modelId = settings.aiModel.trim();
  const baseUrl = settings.aiApiBaseUrl.trim();

  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

function createAnthropicCompatibleModel(settings: ShellDeskAppSettings): PiCustomModel {
  const modelId = settings.aiModel.trim();
  const baseUrl = settings.aiApiBaseUrl.trim();

  return {
    id: modelId,
    name: modelId,
    api: 'anthropic-messages',
    provider: CUSTOM_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

export function isAiConfigured(settings: ShellDeskAppSettings): boolean {
  const hasEndpoint = settings.aiProvider === 'openai' || settings.aiProvider === 'anthropic'
    ? true
    : !!settings.aiApiBaseUrl.trim();

  return !!(
    hasEndpoint
    && settings.aiModel.trim()
    && (settings.aiApiFormat !== 'anthropic' || settings.aiApiKey.trim())
  );
}

export function createModelsForSettings(settings: ShellDeskAppSettings): Models {
  if (isCustomAiProvider(settings.aiProvider)) {
    const models = createModels();
    const isAnthropicCompatible = settings.aiApiFormat === 'anthropic';
    const model = isAnthropicCompatible
      ? createAnthropicCompatibleModel(settings)
      : createOpenAiCompatibleModel(settings);

    models.setProvider(createProvider({
      id: CUSTOM_PROVIDER_ID,
      name: settings.aiProviderName.trim() || 'Custom Provider',
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: settings.aiProviderName.trim() || 'Custom Provider',
          resolve: async () => ({ auth: settings.aiApiKey.trim() ? { apiKey: settings.aiApiKey.trim() } : {} }),
        },
      },
      models: [model],
      api: isAnthropicCompatible ? anthropicMessagesApi() : openAICompletionsApi(),
    }));

    return models;
  }

  return builtinModels();
}

function getModelsCacheKey(settings: ShellDeskAppSettings): string {
  return [
    settings.aiProvider,
    settings.aiApiFormat,
    settings.aiApiBaseUrl.trim(),
    settings.aiProviderName.trim(),
    settings.aiModel.trim(),
  ].join(':');
}

function getCachedModels(settings: ShellDeskAppSettings): Models {
  const key = getModelsCacheKey(settings);
  const cached = modelsCache.get(key);

  if (cached) {
    return cached;
  }

  const models = createModelsForSettings(settings);
  modelsCache.set(key, models);
  return models;
}

export function getAiModel(settings: ShellDeskAppSettings, models = createModelsForSettings(settings)): Model<Api> {
  const providerId = getProviderId(settings);
  const modelId = settings.aiModel.trim();
  const model = models.getModel(providerId, modelId);

  if (!model) {
    // Developer-facing configuration error; the UI localizes user-visible request failures.
    throw new Error(`AI model not found: ${providerId}/${modelId}`);
  }

  return model;
}

export function getAiApiKey(settings: ShellDeskAppSettings): string | undefined {
  const apiKey = settings.aiApiKey.trim();
  return apiKey || undefined;
}

function getBackendAiApiBaseUrl(settings: ShellDeskAppSettings): string {
  const apiBaseUrl = settings.aiApiBaseUrl.trim();

  if (apiBaseUrl) {
    return apiBaseUrl;
  }

  if (settings.aiProvider === 'anthropic' || settings.aiApiFormat === 'anthropic') {
    return 'https://api.anthropic.com';
  }

  if (settings.aiProvider === 'openai') {
    return 'https://api.openai.com/v1';
  }

  return '';
}

function contextToBackendChatMessages(context: PiRequestContext): ShellDeskAiChatMessage[] {
  const messages: ShellDeskAiChatMessage[] = [];

  if (context.systemPrompt.trim()) {
    messages.push({
      role: 'system',
      content: context.systemPrompt,
    });
  }

  for (const message of context.messages) {
    if (!message.content.trim()) {
      continue;
    }

    if (message.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: message.content,
      });
      continue;
    }

    if (message.role === 'toolResult') {
      messages.push({
        role: 'user',
        content: [
          `Tool result${message.toolName ? ` (${message.toolName})` : ''}${message.isError ? ' [error]' : ''}:`,
          message.content,
        ].join('\n'),
      });
      continue;
    }

    messages.push({
      role: 'user',
      content: message.content,
    });
  }

  return messages;
}

function contextToolsToBackendTools(tools: AgentTool[] | undefined): ShellDeskAiChatTool[] | undefined {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => {
    const toolRecord = tool as AgentTool & {
      description?: string;
      label?: string;
      parameters?: unknown;
    };

    return {
      name: tool.name,
      description: toolRecord.description || toolRecord.label || tool.name,
      parameters: toolRecord.parameters,
    };
  });
}

function createBackendChatRequest(settings: ShellDeskAppSettings, context: PiRequestContext): ShellDeskAiChatRequest | null {
  const apiBaseUrl = getBackendAiApiBaseUrl(settings);

  if (!apiBaseUrl) {
    return null;
  }

  return {
    provider: settings.aiProvider,
    apiFormat: settings.aiApiFormat,
    apiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
    messages: contextToBackendChatMessages(context),
    tools: contextToolsToBackendTools(context.tools),
    temperature: context.temperature ?? 0.2,
  };
}

export function createContext(
  messages: Context['messages'],
  systemPrompt: string,
  tools?: AgentTool[],
): Context {
  return {
    systemPrompt,
    messages,
    tools,
  };
}

function createRequestMessage(message: PiRequestMessage, model: Model<Api>, timestamp: number): Message {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: 'text', text: message.content }],
      stopReason: 'stop',
      usage: {
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
      },
      timestamp,
    };
  }

  if (message.role === 'toolResult') {
    return {
      role: 'toolResult',
      toolCallId: message.toolCallId || 'shelldesk-tool-result',
      toolName: message.toolName || 'shelldesk',
      content: [{ type: 'text', text: message.content }],
      isError: !!message.isError,
      timestamp,
    };
  }

  return {
    role: 'user',
    content: message.content,
    timestamp,
  };
}

function createRequestContext(context: PiRequestContext, model: Model<Api>): Context {
  const timestamp = Date.now();

  return {
    systemPrompt: context.systemPrompt,
    messages: context.messages.map((message) => createRequestMessage(message, model, timestamp)),
    tools: context.tools,
  };
}

function extractAssistantText(message: AssistantMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('');
}

function assertAssistantResponseOk(message: AssistantMessage) {
  if (message.stopReason !== 'error') {
    return;
  }

  const errorMessage = message.errorMessage?.trim() || 'AI request failed';
  throw new Error(errorMessage);
}

function usageToSummary(usage: Usage): PiUsageSummary {
  return {
    input: usage.input,
    output: usage.output,
    cost: usage.cost.total,
  };
}

export async function completeAiRequest(
  settings: ShellDeskAppSettings,
  context: PiRequestContext,
  options?: PiRequestOptions,
): Promise<string> {
  const backendChat = window.guiSSH?.ai?.chat;
  const backendRequest = createBackendChatRequest(settings, context);

  if (backendChat && backendRequest) {
    const result = await backendChat(backendRequest);
    return result.content ?? '';
  }

  const models = getCachedModels(settings);
  const model = getAiModel(settings, models);
  const result = await models.complete(model, createRequestContext(context, model), {
    apiKey: getAiApiKey(settings),
    temperature: context.temperature,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
  });

  assertAssistantResponseOk(result);

  return extractAssistantText(result);
}

export async function streamAiResponse(
  settings: ShellDeskAppSettings,
  context: PiRequestContext,
  onChunk: (text: string) => void,
  onUsage?: (usage: PiUsageSummary) => void,
  options?: PiRequestOptions,
): Promise<string> {
  const backendChat = window.guiSSH?.ai?.chat;
  const backendChatStream = window.guiSSH?.ai?.chatStream;
  const backendRequest = createBackendChatRequest(settings, context);

  if (backendChatStream && backendRequest) {
    let fullContent = '';
    const result = await backendChatStream(backendRequest, {
      onChunk: (chunk) => {
        if (options?.signal?.aborted) {
          return;
        }
        fullContent += chunk;
        onChunk(fullContent);
      },
    });
    return result.content ?? fullContent;
  }

  if (backendChat && backendRequest) {
    const result = await backendChat(backendRequest);
    const content = result.content ?? '';

    if (content) {
      onChunk(content);
    }

    return content;
  }

  const models = getCachedModels(settings);
  const model = getAiModel(settings, models);
  const stream = models.stream(model, createRequestContext(context, model), {
    apiKey: getAiApiKey(settings),
    temperature: context.temperature,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
  });
  let fullContent = '';

  for await (const event of stream) {
    if (event.type === 'text_delta') {
      fullContent += event.delta;
      onChunk(fullContent);
    }

    if (event.type === 'done') {
      assertAssistantResponseOk(event.message);
      fullContent = extractAssistantText(event.message) || fullContent;
      onUsage?.(usageToSummary(event.message.usage));
    }

    if (event.type === 'error') {
      throw new Error(event.error.errorMessage || 'AI stream error');
    }
  }

  return fullContent;
}

export const PiAgentService = {
  completeAiRequest,
  createContext,
  createModelsForSettings,
  getCachedModels,
  getAiApiKey,
  getAiModel,
  isAiConfigured,
  streamAiResponse,
};

export function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
