import React, { useReducer, useState } from 'react';
import { integrationsAPI } from '../../services/api';
import OnboardingPeopleImport from '../peopleImport/OnboardingPeopleImport';

interface Props {
  onContinueToGatherings: () => void;
}

interface ElvantoConnectionState { apiKey: string; connected: boolean }
type ElvantoConnectionAction = { type: 'api-key-changed'; value: string } | { type: 'connected' };

export function reduceElvantoConnection(state: ElvantoConnectionState, action: ElvantoConnectionAction): ElvantoConnectionState {
  if (action.type === 'api-key-changed') return { ...state, apiKey: action.value };
  return { apiKey: '', connected: true };
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const responseMessage = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
    if (responseMessage) return responseMessage;
  }
  return error instanceof Error ? error.message : fallback;
}

export default function ElvantoOnboarding({ onContinueToGatherings }: Props) {
  const [{ apiKey, connected }, dispatchConnection] = useReducer(reduceElvantoConnection, { apiKey: '', connected: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError('Enter an Elvanto API key.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await integrationsAPI.connectElvanto(key);
      dispatchConnection({ type: 'connected' });
    } catch (cause) {
      setError(errorMessage(cause, 'Failed to connect to Elvanto.'));
    } finally {
      setBusy(false);
    }
  };

  if (connected) {
    return (
      <OnboardingPeopleImport
        provider="elvanto"
        onComplete={onContinueToGatherings}
        onSkip={onContinueToGatherings}
      />
    );
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Connect Elvanto</h2>
        <p className="mt-1 text-sm text-gray-600">Connect securely, then choose and review the people you want to bring into LMPG.</p>
      </div>
      <label htmlFor="onboarding-elvanto-api-key" className="block text-sm font-medium text-gray-700">
        Elvanto API key
        <input
          id="onboarding-elvanto-api-key"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={(event) => dispatchConnection({ type: 'api-key-changed', value: event.target.value })}
          className="mt-1 block w-full rounded-md border-gray-300"
        />
      </label>
      <p className="text-xs text-gray-500">The key is encrypted after validation and is never displayed again.</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => void connect()} disabled={busy || !apiKey.trim()} className="rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? 'Connecting…' : 'Connect Elvanto'}
        </button>
        <button type="button" onClick={onContinueToGatherings} disabled={busy} className="text-sm underline">Skip Elvanto</button>
      </div>
    </section>
  );
}
