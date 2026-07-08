export interface ElvantoStatus {
  connected: boolean;
  loading: boolean;
  elvantoAccount: string | null;
  error?: string | null;
}

export interface AiStatus {
  configured: boolean;
  provider: 'openai' | 'anthropic' | 'grok' | null;
  loading: boolean;
}

export interface PlanningCenterStatus {
  enabled: boolean;
  connected: boolean;
  loading: boolean;
  planningCenterAccount: string | null;
}

export type IntegrationKey = 'elvanto' | 'ai' | 'planning-center';

export interface PanelProps<S> {
  status: S;
  refreshStatus: () => void | Promise<void>;
  onBack: () => void;
}
