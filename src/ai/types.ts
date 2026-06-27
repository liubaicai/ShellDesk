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

export interface AiToolContext {
  connectionId?: string;
  hostId?: string;
  systemType?: string;
}

export interface AiToolDetails {
  command?: string;
  exitCode?: number;
  stderr?: string;
}

export interface AiTokenUsage {
  input: number;
  output: number;
  cost: number;
}
