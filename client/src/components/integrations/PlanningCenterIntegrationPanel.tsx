import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  LinkIcon,
  LinkSlashIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
  CheckCircleIcon,
  InformationCircleIcon,
  XMarkIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { integrationsAPI, peopleSyncAPI, settingsAPI } from '../../services/api';
import Modal from '../Modal';
import logger from '../../utils/logger';
import PCOCheckinImport from '../PCOCheckinImport';
import PlanningCenterBatchEditor from '../planningCenter/PlanningCenterBatchEditor';
import PeopleSourceControl from '../peopleSync/PeopleSourceControl';
import { PlanningCenterStatus, PanelProps, PeopleSyncPanelProps } from './types';
import type { BatchOperationalState, PeopleSyncBatch } from '../peopleSync/types';
import { planningCenterBatchErrorMessage } from '../../utils/pcoBatchError';

const PCO_SYNC_RESULT_LABELS: Record<string, [string, string]> = {
  addPeople: ['person added', 'people added'],
  updateManagedFields: ['person updated', 'people updated'],
  linkPeople: ['person linked', 'people linked'],
  archive: ['person archived', 'people archived'],
  reactivate: ['person reactivated', 'people reactivated'],
  addFamilies: ['family added', 'families added'],
  linkFamilies: ['family linked', 'families linked'],
  gatheringAssigned: ['gathering assignment added', 'gathering assignments added'],
  gatheringRemoved: ['gathering assignment removed', 'gathering assignments removed'],
};

const BATCH_OPERATIONAL_STATE_LABELS: Record<BatchOperationalState, string> = {
  active: 'Active',
  prepared: 'Prepared for source switch',
  disabled: 'Disabled',
  source_review_required: 'Source review required',
};

function formatLastSyncResult(result: PeopleSyncBatch['lastSyncResult']): string | null {
  if (typeof result === 'string') return result.replaceAll('_', ' ');
  if (!result) return null;

  const counts = Object.entries(result)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .map(([key, count]) => {
      const labels = PCO_SYNC_RESULT_LABELS[key];
      const label = labels?.[count === 1 ? 0 : 1] || key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
      return `${count} ${label}`;
    });

  return counts.length > 0 ? counts.join(' · ') : 'completed';
}

const PlanningCenterIntegrationPanel: React.FC<PanelProps<PlanningCenterStatus> & PeopleSyncPanelProps & { initialAction?: 'disconnect' }> = ({
  status,
  refreshStatus,
  onBack,
  initialAction,
  peopleSyncSettings,
  peopleSyncStatus,
  providerConnections,
  refreshPeopleSync,
  retryPeopleSync,
}) => {
  const navigate = useNavigate();
  const [planningCenterConnecting, setPlanningCenterConnecting] = useState(false);
  const [planningCenterError, setPlanningCenterError] = useState<string | null>(null);
  const [showPlanningCenterDisconnectModal, setShowPlanningCenterDisconnectModal] = useState(false);

  useEffect(() => {
    if (initialAction === 'disconnect') setShowPlanningCenterDisconnectModal(true);
  }, [initialAction]);
  const [pcSyncEnabled, setPcSyncEnabled] = useState(false);
  const [pcTrackBackgroundChecks, setPcTrackBackgroundChecks] = useState(false);
  const [pcSettingsStatus, setPcSettingsStatus] = useState<'loading' | 'known' | 'error'>('loading');
  const [pcSettingsError, setPcSettingsError] = useState<string | null>(null);
  const [pcSettingsUpdating, setPcSettingsUpdating] = useState(false);
  const [batches, setBatches] = useState<PeopleSyncBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [batchesError, setBatchesError] = useState<string | null>(null);
  const [batchNotice, setBatchNotice] = useState<string | null>(null);
  const [syncStats, setSyncStats] = useState<{ totalPeople: number; syncedPeople: number } | null>(null);
  const [editingBatch, setEditingBatch] = useState<PeopleSyncBatch | 'new' | null>(null);
  const [legacyBatchPendingDelete, setLegacyBatchPendingDelete] = useState<PeopleSyncBatch | null>(null);
  const [legacyBatchDeleting, setLegacyBatchDeleting] = useState(false);
  const [legacyBatchDeleteError, setLegacyBatchDeleteError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [checkinAvailable, setCheckinAvailable] = useState(false);
  const [peopleLinked, setPeopleLinked] = useState(true);
  const reconnectRequired = status.reconnectRequired === true;
  const batchLoadGeneration = useRef(0);
  const settingsGeneration = useRef(0);
  const settingsMutationInFlight = useRef(false);

  const loadBatches = useCallback(async () => {
    const generation = ++batchLoadGeneration.current;
    setBatchesLoading(true); setBatchesError(null);
    try {
      const res = await integrationsAPI.getPlanningCenterSyncBatches();
      if (generation !== batchLoadGeneration.current) return;
      setBatches(res.data.batches || []);
    } catch (e: any) {
      if (generation !== batchLoadGeneration.current) return;
      setBatchesError(e.response?.data?.error || 'Failed to load sync batches.');
    } finally {
      if (generation === batchLoadGeneration.current) setBatchesLoading(false);
    }
  }, []);

  const loadSyncStats = useCallback(async () => {
    try {
      const res = await integrationsAPI.getPlanningCenterSyncStats();
      setSyncStats({ totalPeople: res.data.totalPeople, syncedPeople: res.data.syncedPeople });
    } catch {
      // Silent — this is a nice-to-have gap indicator, not worth an error banner.
      setSyncStats(null);
    }
  }, []);

  const reloadAfterBatchMutation = useCallback(async () => {
    setBatches([]);
    await loadBatches();
    await loadSyncStats();
  }, [loadBatches, loadSyncStats]);

  const loadPcSettings = useCallback(async () => {
    const generation = ++settingsGeneration.current;
    setPcSettingsStatus('loading');
    setPcSettingsError(null);
    try {
      const response = await settingsAPI.getIntegrationSettings();
      if (generation !== settingsGeneration.current) return;
      setPcSyncEnabled(!!response.data.planningCenterSyncEnabled);
      setPcTrackBackgroundChecks(!!response.data.planningCenterTrackBackgroundChecks);
      setPcSettingsStatus('known');
    } catch (error: any) {
      if (generation !== settingsGeneration.current) return;
      setPcSettingsStatus('error');
      setPcSettingsError(error.response?.data?.error || 'Could not load the automatic sync setting.');
    }
  }, []);

  const toggleMasterSync = async (value: boolean) => {
    if (pcSettingsStatus !== 'known' || settingsMutationInFlight.current) return;
    settingsMutationInFlight.current = true;
    const generation = ++settingsGeneration.current;
    const confirmed = pcSyncEnabled;
    setPcSettingsUpdating(true);
    setPcSettingsError(null);
    setPcSyncEnabled(value);
    try {
      await settingsAPI.updateIntegrationSettings({ planningCenterSyncEnabled: value });
    } catch (error: any) {
      if (generation !== settingsGeneration.current) return;
      logger.error('Failed to update master sync switch:', error);
      setPcSyncEnabled(confirmed);
      setPcSettingsError(error.response?.data?.error || 'Could not update the automatic sync setting.');
    } finally {
      if (generation === settingsGeneration.current) {
        settingsMutationInFlight.current = false;
        setPcSettingsUpdating(false);
      }
    }
  };

  const toggleTrackBackgroundChecks = async (value: boolean) => {
    if (pcSettingsStatus !== 'known' || settingsMutationInFlight.current) return;
    settingsMutationInFlight.current = true;
    const generation = ++settingsGeneration.current;
    const confirmed = pcTrackBackgroundChecks;
    setPcSettingsUpdating(true);
    setPcSettingsError(null);
    setPcTrackBackgroundChecks(value);
    try {
      await settingsAPI.updateIntegrationSettings({ planningCenterTrackBackgroundChecks: value });
    } catch (error: any) {
      if (generation !== settingsGeneration.current) return;
      logger.error('Failed to update background-check tracking setting:', error);
      setPcTrackBackgroundChecks(confirmed);
      setPcSettingsError(error.response?.data?.error || 'Could not update the Planning Center setting.');
    } finally {
      if (generation === settingsGeneration.current) {
        settingsMutationInFlight.current = false;
        setPcSettingsUpdating(false);
      }
    }
  };

  const deleteBatch = async (batchId: number) => {
    try {
      await integrationsAPI.deletePlanningCenterSyncBatch(batchId);
      await reloadAfterBatchMutation();
    } catch (e: any) {
      setPlanningCenterError(planningCenterBatchErrorMessage(e, 'Failed to delete sync batch.'));
    }
  };

  const deleteLegacyBatch = async () => {
    if (!legacyBatchPendingDelete || legacyBatchDeleting) return;
    setLegacyBatchDeleting(true);
    setLegacyBatchDeleteError(null);
    try {
      await integrationsAPI.deletePlanningCenterSyncBatch(legacyBatchPendingDelete.id);
      setLegacyBatchPendingDelete(null);
      await reloadAfterBatchMutation();
    } catch (e: any) {
      setLegacyBatchDeleteError(planningCenterBatchErrorMessage(e, 'Failed to delete retired legacy batch.'));
    } finally {
      setLegacyBatchDeleting(false);
    }
  };

  const discardDraft = async (batchId: number) => {
    try {
      await peopleSyncAPI.discardSourceDraft('planning_center', batchId);
      await reloadAfterBatchMutation();
    } catch (e: any) {
      setBatchesError(planningCenterBatchErrorMessage(e, 'Failed to discard the people source draft.'));
    }
  };

  // Handle Planning Center connect (OAuth flow)
  const handlePlanningCenterConnect = async () => {
    try {
      setPlanningCenterConnecting(true);
      setPlanningCenterError(null);
      const response = await integrationsAPI.authorizePlanningCenter();
      window.location.href = response.data.authUrl;
    } catch (error: any) {
      logger.error('Failed to authorize Planning Center:', error);
      setPlanningCenterError(error.response?.data?.error || 'Failed to start authorization.');
      setPlanningCenterConnecting(false);
    }
  };

  // Handle Planning Center disconnect
  const confirmPlanningCenterDisconnect = async () => {
    setShowPlanningCenterDisconnectModal(false);
    try {
      await integrationsAPI.disconnectPlanningCenter();
      refreshStatus();
    } catch (error: any) {
      logger.error('Failed to disconnect Planning Center:', error);
      setPlanningCenterError(error.response?.data?.error || 'Failed to disconnect.');
      refreshStatus();
    }
  };

  // Load batches, sync indicator, and master switch when connected
  useEffect(() => {
    if (!status.connected) {
      batchLoadGeneration.current += 1;
      settingsGeneration.current += 1;
      settingsMutationInFlight.current = false;
      setBatches([]);
      setBatchesLoading(false);
      setBatchesError(null);
      setPcSettingsStatus('loading');
      setPcSettingsError(null);
      setPcSettingsUpdating(false);
      return;
    }

    setBatches([]);
    loadBatches();
    loadSyncStats();
    void loadPcSettings();
    // Cheap probe: nudge to import check-ins only if data exists and none has
    // been imported yet.
    integrationsAPI.getCheckinAvailability()
      .then(r => {
        setCheckinAvailable(!!r.data.available && !r.data.hasImported);
        setPeopleLinked(r.data.peopleLinked !== false);
      })
      .catch(() => setCheckinAvailable(false));
    return () => {
      batchLoadGeneration.current += 1;
      settingsGeneration.current += 1;
    };
  }, [status.connected, loadBatches, loadSyncStats, loadPcSettings]);

  const modernBatches = batches.filter((batch) => batch.legacyProviderBatchId === null);
  const legacyBatches = batches.filter((batch) => batch.legacyProviderBatchId !== null);

  const peopleSourceControl = peopleSyncStatus === 'known' ? (
    <PeopleSourceControl
      provider="planning_center"
      hasEnabledBatch={status.connected && !batchesLoading && modernBatches.length > 0}
      settings={peopleSyncSettings}
      connections={providerConnections}
      onRefresh={refreshPeopleSync}
    />
  ) : (
    <section role={peopleSyncStatus === 'error' ? 'alert' : undefined} className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <p>{peopleSyncStatus === 'loading' ? 'Checking authoritative people source…' : 'Could not load the authoritative people source. Source controls are blocked.'}</p>
      {peopleSyncStatus === 'error' && <button type="button" onClick={() => void retryPeopleSync()} className="mt-2 underline">Retry people source status</button>}
    </section>
  );

  return (
    <div>
      <button
        onClick={onBack}
        className="inline-flex items-center text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 mb-4"
      >
        <ArrowLeftIcon className="h-4 w-4 mr-1.5" />
        Back to integrations
      </button>

      {showImport && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
          <button
            type="button"
            onClick={() => setShowImport(false)}
            className="inline-flex items-center text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 mb-4"
          >
            <ArrowLeftIcon className="h-4 w-4 mr-1.5" />
            Back to Planning Center
          </button>
          <PCOCheckinImport onComplete={() => setCheckinAvailable(false)} />
        </div>
      )}

      {!showImport && status.enabled && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center space-x-4">
              <div className="shrink-0">
                <div className="w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                  <svg className="w-6 h-6 text-green-600" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                  </svg>
                </div>
              </div>
              <div>
                <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">Planning Center</h4>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Connect to Planning Center Online to import people and check-ins.
                </p>
                {status.connected && (
                  <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center">
                    <CheckCircleIcon className="w-3 h-3 mr-1" />
                    {status.planningCenterAccount || 'Connected'}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-3">
              {status.loading ? (
                <ArrowPathIcon className="w-5 h-5 animate-spin text-gray-400" />
              ) : status.connected ? (
                <>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                    <ShieldCheckIcon className="w-3 h-3 mr-1" />
                    Connected
                  </span>
                  <button
                    onClick={() => setShowPlanningCenterDisconnectModal(true)}
                    disabled={peopleSyncStatus !== 'known'}
                    className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500"
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                  <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                  Not Connected
                </span>
              )}
            </div>
          </div>

          {/* Connection Form - Only show when not connected */}
          {!status.connected && !status.loading && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
              <h5 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-4">
                {reconnectRequired ? 'Reconnect Planning Center' : 'Connect to Planning Center'}
              </h5>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                {reconnectRequired
                  ? 'Reconnect to replace the stored credentials. Your Lists, batches, and linked people will remain unchanged.'
                  : "You'll be redirected to Planning Center to authorize access. We'll only access your people and check-in data."}
              </p>

              {planningCenterError && (
                <div className="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                  <div className="flex">
                    <ShieldExclamationIcon className="h-5 w-5 text-red-400 shrink-0" />
                    <div className="ml-2">
                      <p className="text-sm text-red-700 dark:text-red-400">{planningCenterError}</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={handlePlanningCenterConnect}
                  disabled={planningCenterConnecting}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {planningCenterConnecting ? (
                    <>
                      <ArrowPathIcon className="h-4 w-4 mr-2 animate-spin" />
                      {reconnectRequired ? 'Reconnecting...' : 'Connecting...'}
                    </>
                  ) : (
                    <>
                      <LinkIcon className="h-4 w-4 mr-2" />
                      {reconnectRequired ? 'Reconnect Planning Center' : 'Connect Planning Center'}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {!status.connected && (
            <div className="mt-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
              <div className="flex">
                <div className="shrink-0">
                  <InformationCircleIcon className="h-5 w-5 text-green-400" />
                </div>
                <div className="ml-3">
                  <h4 className="text-sm font-medium text-green-800 dark:text-green-300">What you'll get</h4>
                  <div className="mt-2 text-sm text-green-700 dark:text-green-400">
                    <ul className="list-disc list-inside space-y-1">
                      <li>Import people with household grouping</li>
                      <li>Import historical check-in data as a one-time attendance backfill</li>
                      <li>Seamless integration with Planning Center Online</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          )}

          {status.connected && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4 space-y-4">
              {/* Sync batches */}
              <div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Enable Planning Center sync</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Controls automatic scheduled sync for the batches below. When off, manual Review &amp; sync remains available.
                    </p>
                  </div>
                  {pcSettingsStatus === 'known' ? (
                    <button
                      type="button"
                      aria-label="Automatic Planning Center sync"
                      onClick={() => toggleMasterSync(!pcSyncEnabled)}
                      disabled={pcSettingsUpdating}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${pcSyncEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                      role="switch"
                      aria-checked={pcSyncEnabled}
                    >
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${pcSyncEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  ) : (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {pcSettingsStatus === 'loading' ? 'Loading automatic sync setting…' : 'Automatic sync setting unavailable'}
                    </span>
                  )}
                </div>

                {pcSettingsError && (
                  <div role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
                    <p>{pcSettingsError}</p>
                    {pcSettingsStatus === 'error' && (
                      <button type="button" onClick={() => void loadPcSettings()} className="mt-1 underline">
                        Retry automatic sync setting
                      </button>
                    )}
                  </div>
                )}

                {syncStats && (
                  <div className="mt-4">
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {syncStats.totalPeople === 0
                        ? 'No active people yet'
                        : `${syncStats.syncedPeople} of ${syncStats.totalPeople} people synced with Planning Center`}
                    </p>
                    {syncStats.totalPeople > 0 && (
                      <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-600">
                        <div
                          className="h-1.5 rounded-full bg-green-600"
                          style={{ width: `${Math.min(100, (syncStats.syncedPeople / syncStats.totalPeople) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-4 flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Sync batches</p>
                  {editingBatch === null && (
                    <button type="button" onClick={() => { setBatchNotice(null); setEditingBatch('new'); }}
                      className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700">
                      New batch
                    </button>
                  )}
                </div>

                {batchesError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{batchesError}</p>}
                {batchNotice && <p role="status" className="mt-2 text-sm text-green-700 dark:text-green-300">{batchNotice}</p>}
                {batchesLoading && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Loading batches…</p>}

                {editingBatch !== null && (
                  <div className="mt-3">
                    <PlanningCenterBatchEditor
                      batch={editingBatch === 'new' ? null : editingBatch}
                      onSaved={(savedBatch) => {
                        if (editingBatch === 'new') {
                          if (peopleSyncSettings.authorityProvider === 'none') {
                            navigate('/app/settings/integrations/planning-center/authority-review?reason=first-batch');
                            return;
                          }
                          if (peopleSyncSettings.authorityProvider === 'planning_center') {
                            navigate(`/app/settings/integrations/planning-center/batches/${savedBatch.id}/review`);
                            return;
                          }
                          setEditingBatch(null);
                          setBatchNotice('Batch prepared. Switch source of truth to review and activate it.');
                          void reloadAfterBatchMutation();
                          return;
                        }
                        setEditingBatch(null);
                        void reloadAfterBatchMutation();
                      }}
                      onCancel={() => setEditingBatch(null)}
                    />
                  </div>
                )}

                {!batchesLoading && modernBatches.length === 0 && editingBatch === null && (
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No sync batches yet — create one to start importing people from Planning Center.</p>
                )}

                <ul className="mt-3 space-y-3">
                  {modernBatches.map((batch) => (
                    <li key={batch.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{batch.name}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {batch.gatheringTypeId ? 'Assigns to a gathering · ' : ''}
                            {batch.scheduleEnabled
                              ? pcSettingsStatus === 'known'
                                ? (pcSyncEnabled ? `Runs ${batch.scheduleFrequency}` : 'Automatic sync paused')
                                : pcSettingsStatus === 'loading' ? 'Automatic sync status loading' : 'Automatic sync status unavailable'
                              : 'Manual only'}
                          </p>
                          {batch.lastSyncAt && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              Last run {new Date(batch.lastSyncAt).toLocaleString()}{batch.lastSyncResult ? `: ${formatLastSyncResult(batch.lastSyncResult)}` : ''}.
                            </p>
                          )}
                          {batch.source && <p className="mt-1 text-xs text-gray-500">{batch.source.kind === 'planning_center_list' ? 'Planning Center List' : batch.source.kind}: {batch.source.name}</p>}
                          {batch.sourceStatus === 'missing' && <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-300">Source missing</p>}
                          {batch.sourceStatus === 'error' && <p role="status" className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">Source check failed{batch.sourceStatusErrorCode ? ` · ${batch.sourceStatusErrorCode}` : ''}</p>}
                          <p className="mt-1 text-xs font-medium text-gray-700 dark:text-gray-300">{BATCH_OPERATIONAL_STATE_LABELS[batch.operationalState]}</p>
                          {batch.operationalState === 'prepared' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Switch source of truth to activate this batch.</p>}
                          {batch.operationalState === 'source_review_required' && <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">Needs full review · the selected people source will not run until reviewed.</p>}
                        </div>
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setEditingBatch(batch)} className="text-sm underline text-gray-600 dark:text-gray-300">Edit</button>
                          {batch.reviewable && (
                            <button
                              type="button"
                              onClick={() => navigate(`/app/settings/integrations/planning-center/batches/${batch.id}/review`)}
                              aria-label={`${batch.operationalState === 'source_review_required' ? 'Review source & sync' : 'Review & sync'} ${batch.name}`}
                              className="rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
                            >
                              {batch.operationalState === 'source_review_required' ? 'Review source & sync' : 'Review & sync'}
                            </button>
                          )}
                          {batch.needsSourceReview && !batch.initialSourceReviewPending && <button type="button" onClick={() => void discardDraft(batch.id)} className="text-sm underline text-gray-600 dark:text-gray-300">Discard source draft</button>}
                          <button type="button" onClick={() => deleteBatch(batch.id)} className="text-sm underline text-red-600 dark:text-red-400">Delete</button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>

                {legacyBatches.length > 0 && (
                  <section className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                    <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">Retired legacy batches</h5>
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">These historical Planning Center batches are retained for reference and no longer run.</p>
                    <ul className="mt-3 space-y-3">
                      {legacyBatches.map((batch) => (
                        <li key={batch.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{batch.name}</p>
                              <p className="text-xs text-gray-500 dark:text-gray-400">This retired legacy batch no longer runs and cannot be edited or reviewed.</p>
                              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                Prior settings: {batch.priorScheduleEnabled
                                  ? `scheduled ${batch.priorScheduleFrequency}${batch.priorScheduleFrequency === 'daily' || batch.priorScheduleDay === null || batch.priorScheduleDay === undefined ? '' : ` (day ${batch.priorScheduleDay})`}`
                                  : 'manual only'} · {batch.gatheringTypeId ? 'assigned to a gathering' : 'no gathering assignment'} · new people were added as {batch.defaultPeopleType.replace('_', ' ')}.
                              </p>
                              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                Last run {batch.lastSyncAt ? `${new Date(batch.lastSyncAt).toLocaleString()}${batch.lastSyncResult ? `: ${formatLastSyncResult(batch.lastSyncResult)}` : ''}` : 'Never run'}.
                              </p>
                            </div>
                            <button type="button" onClick={() => { setLegacyBatchPendingDelete(batch); setLegacyBatchDeleteError(null); }} className="shrink-0 text-sm underline text-red-600 dark:text-red-400">Delete</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>

              {peopleSourceControl}

              {/* PCO-specific background-check tracking remains independent of people authority. */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">Track background check status</h5>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      Syncs Planning Center's background-check status for linked people. To use it,
                      also flag specific gathering types as "Requires background check" in Manage
                      Gatherings — the status only shows there and on the People page. Status is only
                      as current as the last sync (see each batch's "Last run" time above) — not real-time.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleTrackBackgroundChecks(!pcTrackBackgroundChecks)}
                    disabled={pcSettingsStatus !== 'known' || pcSettingsUpdating}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${pcTrackBackgroundChecks ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                    role="switch"
                    aria-checked={pcTrackBackgroundChecks}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${pcTrackBackgroundChecks ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>
              </div>

              {/* Check-in attendance import */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                {!peopleLinked ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Link your people to Planning Center first — add a sync batch above and run it — before importing
                    check-in history. This keeps imported attendance matched to the right person instead of creating
                    duplicates.
                  </p>
                ) : (
                  <>
                    {checkinAvailable && (
                      <div className="mb-3 rounded-md bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 px-4 py-3 flex items-center justify-between gap-3">
                        <p className="text-sm text-blue-800 dark:text-blue-200">
                          Check-in data is available in Planning Center — would you like to import it?
                        </p>
                        <button
                          type="button"
                          onClick={() => setShowImport(true)}
                          className="shrink-0 inline-flex items-center px-3 py-2 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                        >
                          Import now
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowImport(true)}
                      className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      Import attendance history
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Planning Center Disconnect Confirmation Modal */}
      <Modal
        isOpen={showPlanningCenterDisconnectModal}
        onClose={() => setShowPlanningCenterDisconnectModal(false)}
      >
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Disconnect Planning Center
              </h3>
              <button
                onClick={() => setShowPlanningCenterDisconnectModal(false)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <XMarkIcon className="h-6 w-6" />
              </button>
            </div>

            <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4 bg-yellow-100 dark:bg-yellow-900/30 rounded-full">
              <ExclamationTriangleIcon className="h-8 w-8 text-yellow-600" />
            </div>

            <div className="text-center mb-6">
              {peopleSyncStatus !== 'known' ? (
                <p className="text-sm text-amber-700">The authoritative people source is not known, so disconnect is blocked.</p>
              ) : peopleSyncSettings.authorityProvider === 'planning_center' ? (
                <p className="text-sm text-amber-700">
                  Planning Center is your authoritative people source. Choose None or Elvanto and complete that reviewed change before disconnecting.
                </p>
              ) : (
                <>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                    Are you sure you want to disconnect from Planning Center?
                  </p>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Your OAuth tokens will be removed. You can reconnect at any time.
                  </p>
                </>
              )}
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowPlanningCenterDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors"
              >
                Cancel
              </button>
              {peopleSyncStatus === 'known' && peopleSyncSettings.authorityProvider !== 'planning_center' && <button
                onClick={confirmPlanningCenterDisconnect}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
              >
                <LinkSlashIcon className="h-4 w-4 mr-2" />
                Disconnect
              </button>}
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={legacyBatchPendingDelete !== null}
        onClose={() => { if (!legacyBatchDeleting) { setLegacyBatchPendingDelete(null); setLegacyBatchDeleteError(null); } }}
      >
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">Delete retired legacy batch?</h3>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">This permanently removes the old batch records. People already imported and gathering assignments already created will remain.</p>
          {legacyBatchDeleteError && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{legacyBatchDeleteError}</p>}
          <div className="mt-6 flex gap-3">
            <button type="button" disabled={legacyBatchDeleting} onClick={() => { setLegacyBatchPendingDelete(null); setLegacyBatchDeleteError(null); }} className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50">Cancel</button>
            <button type="button" disabled={legacyBatchDeleting} onClick={() => void deleteLegacyBatch()} className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 disabled:opacity-50">{legacyBatchDeleting ? 'Deleting retired batch…' : 'Delete retired batch'}</button>
          </div>
        </div>
      </Modal>

    </div>
  );
};

export default PlanningCenterIntegrationPanel;
