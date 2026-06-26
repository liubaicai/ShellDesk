export interface AiChatOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface AiMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface AiChatState {
  messages: AiMessage[];
  isBusy: boolean;
  error: string;
}

export interface AiServiceConfig {
  provider: ShellDeskAiProvider;
  apiFormat: ShellDeskAiApiFormat;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiToolContext {
  connectionId?: string;
  hostId?: string;
  systemType?: string;
}
