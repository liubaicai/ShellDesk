import type { AiChatOptions, AiServiceConfig } from './types';

export function isAiConfigured(settings: ShellDeskAppSettings): boolean {
  return !!(
    settings.aiApiBaseUrl.trim()
    && settings.aiModel.trim()
    && (settings.aiApiFormat !== 'anthropic' || settings.aiApiKey.trim())
  );
}

export function getAiConfig(settings: ShellDeskAppSettings): AiServiceConfig {
  return {
    provider: settings.aiProvider,
    apiFormat: settings.aiApiFormat,
    apiBaseUrl: settings.aiApiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
  };
}

export function buildChatRequest(
  config: AiServiceConfig,
  messages: ShellDeskAiChatMessage[],
  options?: AiChatOptions,
): ShellDeskAiChatRequest {
  return {
    provider: config.provider,
    apiFormat: config.apiFormat,
    apiBaseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    model: config.model,
    temperature: options?.temperature ?? 0.7,
    messages,
  };
}

export async function sendChat(
  config: AiServiceConfig,
  messages: ShellDeskAiChatMessage[],
  options?: AiChatOptions,
): Promise<string> {
  const ai = window.guiSSH?.ai;

  if (!ai?.chat) {
    throw new Error('AI chat not available');
  }

  const request = buildChatRequest(config, messages, options);
  const result = await ai.chat(request);
  return result.content;
}

export async function sendChatStream(
  config: AiServiceConfig,
  messages: ShellDeskAiChatMessage[],
  onChunk: (chunk: string) => void,
  options?: AiChatOptions,
): Promise<string> {
  const ai = window.guiSSH?.ai;

  if (!ai?.chatStream) {
    throw new Error('AI chat stream not available');
  }

  const request = buildChatRequest(config, messages, options);
  const result = await ai.chatStream(request, { onChunk });
  return result.content;
}

export function createMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
