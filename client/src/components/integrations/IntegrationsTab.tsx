import React, { useState, useEffect, useCallback } from 'react';
import { integrationsAPI, aiAPI, peopleSyncAPI } from '../../services/api';
import logger from '../../utils/logger';
import IntegrationCard from './IntegrationCard';
import AiIntegrationPanel from './AiIntegrationPanel';
import ElvantoIntegrationPanel from './ElvantoIntegrationPanel';
import PlanningCenterIntegrationPanel from './PlanningCenterIntegrationPanel';
import {
  ElvantoStatus,
  AiStatus,
  PlanningCenterStatus,
  IntegrationKey,
} from './types';
import type { PeopleSyncSettings } from '../peopleSync/types';

const defaultPeopleSyncSettings: PeopleSyncSettings = {
  authorityProvider: 'none',
  pendingAuthorityProvider: null,
  elvantoIncludeContacts: true,
  elvantoAlignPeopleType: true,
  fullReconciliationFrequency: 'weekly',
  fullReconciliationDay: 1,
};

const IntegrationsTab: React.FC = () => {
  const [elvantoStatus, setElvantoStatus] = useState<ElvantoStatus>({
    connected: false,
    loading: true,
    elvantoAccount: null,
  });

  const [aiStatus, setAiStatus] = useState<AiStatus>({
    configured: false,
    provider: null,
    loading: true,
  });

  const [pcStatus, setPcStatus] = useState<PlanningCenterStatus>({
    enabled: false,
    configured: false,
    connected: false,
    loading: true,
    planningCenterAccount: null,
  });

  const [selected, setSelected] = useState<IntegrationKey | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<IntegrationKey | null>(null);
  const [peopleSyncSettings, setPeopleSyncSettings] = useState(defaultPeopleSyncSettings);
  const [peopleSyncStatus, setPeopleSyncStatus] = useState<'loading' | 'error' | 'known'>('loading');

  const fetchElvantoStatus = useCallback(async () => {
    try {
      const response = await integrationsAPI.getElvantoStatus();
      const connected = response.data.connected === true;
      setElvantoStatus({
        connected,
        elvantoAccount: response.data.elvantoAccount ?? null,
        loading: false,
      });
    } catch (error) {
      logger.error('Failed to fetch Elvanto status:', error);
      setElvantoStatus(prev => ({ ...prev, loading: false }));
    }
  }, []);

  const fetchAiStatus = useCallback(async () => {
    try {
      const response = await aiAPI.getStatus();
      setAiStatus({ ...response.data, loading: false });
    } catch (error) {
      logger.error('Failed to fetch AI status:', error);
      setAiStatus(prev => ({ ...prev, loading: false }));
    }
  }, []);

  const fetchPlanningCenterStatus = useCallback(async () => {
    try {
      const response = await integrationsAPI.getPlanningCenterStatus();
      setPcStatus({
        enabled: response.data.enabled === true,
        configured: response.data.configured === true,
        connected: response.data.connected === true,
        loading: false,
        planningCenterAccount: response.data.planningCenterAccount ?? null,
        reconnectRequired: response.data.reconnectRequired === true,
        connectionErrorCode: response.data.connectionErrorCode === 'SYNC_SOURCE_AUTH' ? 'SYNC_SOURCE_AUTH' : null,
        fetchFailed: false,
      });
    } catch (error) {
      logger.error('Failed to fetch Planning Center status:', error);
      setPcStatus(prev => ({ ...prev, loading: false, fetchFailed: true }));
    }
  }, []);

  const fetchPeopleSyncSettings = useCallback(async () => {
    try {
      const response = await peopleSyncAPI.getSettings();
      setPeopleSyncSettings(response.data.settings);
      setPeopleSyncStatus('known');
    } catch (error) {
      logger.error('Failed to fetch people-sync settings:', error);
      setPeopleSyncStatus('error');
    }
  }, []);

  const retryPeopleSync = useCallback(async () => {
    setPeopleSyncStatus('loading');
    await fetchPeopleSyncSettings();
  }, [fetchPeopleSyncSettings]);

  // Fetch all statuses on mount
  useEffect(() => {
    fetchElvantoStatus();
    fetchAiStatus();
    fetchPlanningCenterStatus();
    fetchPeopleSyncSettings();
  }, [fetchElvantoStatus, fetchAiStatus, fetchPlanningCenterStatus, fetchPeopleSyncSettings]);

  const providerConnections = {
    planning_center: pcStatus.connected,
    elvanto: elvantoStatus.connected,
  };

  const refreshPeopleSync = useCallback(async () => {
    await Promise.all([fetchPeopleSyncSettings(), fetchElvantoStatus(), fetchPlanningCenterStatus()]);
  }, [fetchPeopleSyncSettings, fetchElvantoStatus, fetchPlanningCenterStatus]);

  // Handle Planning Center OAuth callback
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const pcoSuccess = urlParams.get('pco_success');
    const pcoError = urlParams.get('pco_error');
    if (pcoSuccess === 'true') {
      setSelected('planning-center');
      fetchPlanningCenterStatus();
      window.history.replaceState({}, '', '/app/settings?tab=integrations');
    } else if (pcoError) {
      setSelected('planning-center');
      window.history.replaceState({}, '', '/app/settings?tab=integrations');
    }
  }, [fetchPlanningCenterStatus]);

  const handleBack = () => {
    setSelected(null);
    setPendingDisconnect(null);
  };

  // Render selected panel
  if (selected === 'elvanto') {
    return (
      <ElvantoIntegrationPanel
        status={elvantoStatus}
        refreshStatus={fetchElvantoStatus}
        onBack={handleBack}
        initialAction={pendingDisconnect === 'elvanto' ? 'disconnect' : undefined}
        peopleSyncSettings={peopleSyncSettings}
        peopleSyncStatus={peopleSyncStatus}
        providerConnections={providerConnections}
        refreshPeopleSync={refreshPeopleSync}
        retryPeopleSync={retryPeopleSync}
      />
    );
  }

  if (selected === 'ai') {
    return (
      <AiIntegrationPanel
        status={aiStatus}
        refreshStatus={fetchAiStatus}
        onBack={handleBack}
        initialAction={pendingDisconnect === 'ai' ? 'disconnect' : undefined}
      />
    );
  }

  if (selected === 'planning-center') {
    return (
      <PlanningCenterIntegrationPanel
        status={pcStatus}
        refreshStatus={fetchPlanningCenterStatus}
        onBack={handleBack}
        initialAction={pendingDisconnect === 'planning-center' ? 'disconnect' : undefined}
        peopleSyncSettings={peopleSyncSettings}
        peopleSyncStatus={peopleSyncStatus}
        providerConnections={providerConnections}
        refreshPeopleSync={refreshPeopleSync}
        retryPeopleSync={retryPeopleSync}
      />
    );
  }

  // Card list view
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">External Integrations</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Connect your account with external services to enhance your management experience.
        </p>
      </div>

      <div className="space-y-6">
        {peopleSyncStatus === 'loading' && (
          <p className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">Checking authoritative people source…</p>
        )}
        {peopleSyncStatus === 'error' && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p>Could not load the authoritative people source. Disconnect and source controls are blocked until this is known.</p>
            <button type="button" onClick={() => void retryPeopleSync()} className="mt-2 underline">Retry people source status</button>
          </div>
        )}
        {/* Elvanto */}
        <div className="relative">
          {peopleSyncStatus === 'known' && peopleSyncSettings.authorityProvider === 'elvanto' && <span className="absolute right-6 top-2 rounded-full bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800">Authoritative people source</span>}
          <IntegrationCard
          name="Elvanto"
          description="Import people and families once, or keep LMPG aligned with Elvanto."
          icon={
            <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center">
              <svg aria-hidden="true" className="w-6 h-6 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
          }
          connected={elvantoStatus.connected}
          loading={elvantoStatus.loading}
          connectedLabel={elvantoStatus.elvantoAccount || undefined}
          onOpen={() => setSelected('elvanto')}
          onDisconnect={elvantoStatus.connected ? () => {
            setSelected('elvanto');
            setPendingDisconnect('elvanto');
          } : undefined}
          disconnectDisabled={peopleSyncStatus !== 'known'}
          />
        </div>

        {/* AI Insights */}
        <IntegrationCard
          name="AI Insights"
          description="Ask questions about your attendance data in plain language."
          icon={
            <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
              <svg aria-hidden="true" className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
          }
          connected={aiStatus.configured}
          loading={aiStatus.loading}
          onOpen={() => setSelected('ai')}
          onDisconnect={aiStatus.configured ? () => {
            setSelected('ai');
            setPendingDisconnect('ai');
          } : undefined}
        />

        {/* Planning Center */}
        {!pcStatus.fetchFailed && (
          <div className="relative">
            {peopleSyncStatus === 'known' && peopleSyncSettings.authorityProvider === 'planning_center' && <span className="absolute right-6 top-2 rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-800">Authoritative people source</span>}
            <IntegrationCard
            name="Planning Center"
            description="Import people and check-ins, or use Planning Center as your people source of truth."
            icon={
              <div className="w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                <svg aria-hidden="true" className="w-6 h-6 text-green-600" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                </svg>
              </div>
            }
            connected={pcStatus.connected}
            loading={pcStatus.loading}
            connectedLabel={pcStatus.planningCenterAccount || undefined}
            disabledMessage={!pcStatus.loading && !pcStatus.enabled ? 'Not enabled on this server — ask your administrator to configure Planning Center.' : undefined}
            onOpen={() => setSelected('planning-center')}
            onDisconnect={pcStatus.connected ? () => {
              setSelected('planning-center');
              setPendingDisconnect('planning-center');
            } : undefined}
            disconnectDisabled={peopleSyncStatus !== 'known'}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default IntegrationsTab;
