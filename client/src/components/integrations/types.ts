import type { PeopleSyncSettings, PlanningCenterStatus as PlanningCenterStatusResponse, SyncProvider } from '../peopleSync/types';

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

export interface PlanningCenterStatus extends PlanningCenterStatusResponse {
  loading: boolean;
  /** True when the status fetch itself failed (network/server error), as opposed to a successful response reporting the integration disabled. */
  fetchFailed?: boolean;
}

export type IntegrationKey = 'elvanto' | 'ai' | 'planning-center';

export interface PanelProps<S> {
  status: S;
  refreshStatus: () => void | Promise<void>;
  onBack: () => void;
}

export interface PeopleSyncPanelProps {
  peopleSyncSettings: PeopleSyncSettings;
  peopleSyncStatus: 'loading' | 'error' | 'known';
  providerConnections: Record<SyncProvider, boolean>;
  /** Increments after an authority change so each provider view reloads its server-derived batches. */
  peopleSyncBatchRevision: number;
  refreshPeopleSync: () => void | Promise<void>;
  retryPeopleSync: () => void | Promise<void>;
}
