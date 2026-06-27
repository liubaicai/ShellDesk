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
type PiUsageSummary = {
  input: number;
  output: number;
  cost: number;
};

const CUSTOM_PROVIDER_ID = 'shelldesk-openai-compatible';
const modelsCache = new Map<string, Models>();

function getProviderId(settings: ShellDeskAppSettings): string {
  if (settings.aiProvider === 'custom' || settings.aiProvider === 'openai-compatible') {
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
  if (settings.aiProvider === 'custom' || settings.aiProvider === 'openai-compatible') {
    const models = createModels();
    const isAnthropicCompatible = settings.aiApiFormat === 'anthropic';
    const model = isAnthropicCompatible
      ? createAnthropicCompatibleModel(settings)
      : createOpenAiCompatibleModel(settings);

    models.setProvider(createProvider({
      id: CUSTOM_PROVIDER_ID,
      name: settings.aiProviderName.trim() || 'OpenAI Compatible',
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: settings.aiProviderName.trim() || 'OpenAI Compatible',
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
): Promise<string> {
  const models = getCachedModels(settings);
  const model = getAiModel(settings, models);
  const result = await models.complete(model, createRequestContext(context, model), {
    apiKey: getAiApiKey(settings),
    temperature: context.temperature,
  });

  return extractAssistantText(result);
}

export async function streamAiResponse(
  settings: ShellDeskAppSettings,
  context: PiRequestContext,
  onChunk: (text: string) => void,
  onUsage?: (usage: PiUsageSummary) => void,
): Promise<string> {
  const models = getCachedModels(settings);
  const model = getAiModel(settings, models);
  const stream = models.stream(model, createRequestContext(context, model), {
    apiKey: getAiApiKey(settings),
    temperature: context.temperature,
  });
  let fullContent = '';

  for await (const event of stream) {
    if (event.type === 'text_delta') {
      fullContent += event.delta;
      onChunk(fullContent);
    }

    if (event.type === 'done') {
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
