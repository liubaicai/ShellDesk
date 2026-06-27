import {
  type Api,
  createModels,
  createProvider,
  type Context,
  type Model,
  type Models,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { AgentTool } from '@earendil-works/pi-agent-core';

type PiCustomModel = Model<'openai-completions'>;

const CUSTOM_PROVIDER_ID = 'shelldesk-openai-compatible';

function getProviderId(settings: ShellDeskAppSettings): string {
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
    const model = createOpenAiCompatibleModel(settings);

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
      api: openAICompletionsApi(),
    }));

    return models;
  }

  return builtinModels();
}

export function getAiModel(settings: ShellDeskAppSettings, models = createModelsForSettings(settings)): Model<Api> {
  const providerId = getProviderId(settings);
  const modelId = settings.aiModel.trim();
  const model = models.getModel(providerId, modelId);

  if (!model) {
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

export const PiAgentService = {
  createContext,
  createModelsForSettings,
  getAiApiKey,
  getAiModel,
  isAiConfigured,
};

export function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
