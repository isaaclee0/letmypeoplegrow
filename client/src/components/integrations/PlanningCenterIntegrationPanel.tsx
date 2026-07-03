import React, { useState, useEffect, useCallback } from 'react';
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
import { integrationsAPI, settingsAPI, SyncBatch } from '../../services/api';
import Modal from '../Modal';
import logger from '../../utils/logger';
import PCOCheckinImport from '../PCOCheckinImport';
import PlanningCenterSyncReview from '../planningCenter/PlanningCenterSyncReview';
import PlanningCenterReconciliationReview from '../planningCenter/PlanningCenterReconciliationReview';
import PlanningCenterBatchEditor from '../planningCenter/PlanningCenterBatchEditor';
import { PlanningCenterStatus, PanelProps } from './types';

const PlanningCenterIntegrationPanel: React.FC<PanelProps<PlanningCenterStatus> & { initialAction?: 'disconnect' }> = ({
  status,
  refreshStatus,
  onBack,
  initialAction,
}) => {
  const [planningCenterConnecting, setPlanningCenterConnecting] = useState(false);
  const [planningCenterError, setPlanningCenterError] = useState<string | null>(null);
  const [showPlanningCenterDisconnectModal, setShowPlanningCenterDisconnectModal] = useState(false);

  useEffect(() => {
    if (initialAction === 'disconnect') setShowPlanningCenterDisconnectModal(true);
  }, [initialAction]);
  const [pcSyncIndicator, setPcSyncIndicator] = useState(false);
  const [pcSyncEnabled, setPcSyncEnabled] = useState(false);
  const [batches, setBatches] = useState<SyncBatch[]>([]);
  const [batchesLoading, setBatchesLoading] = useState(false);
  const [batchesError, setBatchesError] = useState<string | null>(null);
  const [editingBatch, setEditingBatch] = useState<SyncBatch | 'new' | null>(null);
  const [reviewingBatchId, setReviewingBatchId] = useState<number | null>(null);
  const [runningBatchId, setRunningBatchId] = useState<number | null>(null);
  const [reconciliationScheduleEnabled, setReconciliationScheduleEnabled] = useState(false);
  const [reconciliationFrequency, setReconciliationFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [reconciliationDay, setReconciliationDay] = useState(1);
  const [reconciliationLastResult, setReconciliationLastResult] = useState<any>(null);
  const [reconciliationDirty, setReconciliationDirty] = useState(false);
  const [reconciliationSaving, setReconciliationSaving] = useState(false);
  const [showReconciliationReview, setShowReconciliationReview] = useState(false);

  const loadBatches = useCallback(async () => {
    setBatchesLoading(true); setBatchesError(null);
    try {
      const res = await integrationsAPI.getPlanningCenterSyncBatches();
      setBatches(res.data.batches || []);
    } catch (e: any) {
      setBatchesError(e.response?.data?.error || 'Failed to load sync batches.');
    } finally {
      setBatchesLoading(false);
    }
  }, []);

  const handlePcSyncIndicatorToggle = async (value: boolean) => {
    setPcSyncIndicator(value);
    try {
      await settingsAPI.updateIntegrationSettings({ planningCenterSyncIndicator: value });
    } catch (error) {
      logger.error('Failed to update sync indicator setting:', error);
      setPcSyncIndicator(!value); // revert
    }
  };

  const toggleMasterSync = async (value: boolean) => {
    setPcSyncEnabled(value);
    try {
      await settingsAPI.updateIntegrationSettings({ planningCenterSyncEnabled: value });
    } catch (error) {
      logger.error('Failed to update master sync switch:', error);
      setPcSyncEnabled(!value);
    }
  };

  const runBatchNow = async (batchId: number) => {
    setRunningBatchId(batchId);
    try {
      await integrationsAPI.applyPlanningCenterBatch(batchId, {});
      await loadBatches();
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Sync failed.');
    } finally {
      setRunningBatchId(null);
    }
  };

  const deleteBatch = async (batchId: number) => {
    try {
      await integrationsAPI.deletePlanningCenterSyncBatch(batchId);
      await loadBatches();
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Failed to delete sync batch.');
    }
  };

  const saveReconciliationConfig = async () => {
    setReconciliationSaving(true);
    try {
      await settingsAPI.updateIntegrationSettings({
        planningCenterReconciliationScheduleEnabled: reconciliationScheduleEnabled,
        planningCenterReconciliationFrequency: reconciliationFrequency,
        planningCenterReconciliationDay: reconciliationDay,
      });
      setReconciliationDirty(false);
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Failed to save reconciliation schedule.');
    } finally {
      setReconciliationSaving(false);
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

  // Load batches, sync indicator, master switch, and reconciliation config when connected
  useEffect(() => {
    if (status.connected) {
      loadBatches();
      settingsAPI.getIntegrationSettings().then(r => {
        setPcSyncIndicator(!!r.data.planningCenterSyncIndicator);
        setPcSyncEnabled(!!r.data.planningCenterSyncEnabled);
        setReconciliationScheduleEnabled(!!r.data.planningCenterReconciliationScheduleEnabled);
        setReconciliationFrequency(r.data.planningCenterReconciliationFrequency || 'weekly');
        setReconciliationDay(typeof r.data.planningCenterReconciliationDay === 'number' ? r.data.planningCenterReconciliationDay : 1);
        setReconciliationLastResult(r.data.planningCenterReconciliationLastResult || null);
      }).catch(() => {});
    }
  }, [status.connected, loadBatches]);

  return (
    <div>
      <button
        onClick={onBack}
        className="inline-flex items-center text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 mb-4"
      >
        <ArrowLeftIcon className="h-4 w-4 mr-1.5" />
        Back to integrations
      </button>

      {status.enabled && (
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
                    Connected
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
              <h5 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-4">Connect to Planning Center</h5>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                You'll be redirected to Planning Center to authorize access. We'll only access your people and check-in data.
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
                      Connecting...
                    </>
                  ) : (
                    <>
                      <LinkIcon className="h-4 w-4 mr-2" />
                      Connect Planning Center
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

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
                    <li>Sync check-in data for attendance tracking</li>
                    <li>Seamless integration with Planning Center Online</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {status.connected && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mt-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h5 className="text-sm font-medium text-gray-900 dark:text-gray-100">Show sync indicator</h5>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Show a Planning Center badge on families imported from PCO
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handlePcSyncIndicatorToggle(!pcSyncIndicator)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${pcSyncIndicator ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                  role="switch"
                  aria-checked={pcSyncIndicator}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${pcSyncIndicator ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* Sync batches */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Enable Planning Center sync</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Master switch — turns off all batches and the "check for people who left" schedule below.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleMasterSync(!pcSyncEnabled)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${pcSyncEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                    role="switch"
                    aria-checked={pcSyncEnabled}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${pcSyncEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Sync batches</p>
                  {editingBatch === null && (
                    <button type="button" onClick={() => setEditingBatch('new')}
                      className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700">
                      New batch
                    </button>
                  )}
                </div>

                {batchesError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{batchesError}</p>}
                {batchesLoading && <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Loading batches…</p>}

                {editingBatch !== null && (
                  <div className="mt-3">
                    <PlanningCenterBatchEditor
                      batch={editingBatch === 'new' ? null : editingBatch}
                      onSaved={() => { setEditingBatch(null); loadBatches(); }}
                      onCancel={() => setEditingBatch(null)}
                    />
                  </div>
                )}

                {!batchesLoading && batches.length === 0 && editingBatch === null && (
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No sync batches yet — create one to start importing people from Planning Center.</p>
                )}

                <ul className="mt-3 space-y-3">
                  {batches.map((batch) => (
                    <li key={batch.id} className="border border-gray-200 dark:border-gray-700 rounded-md p-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{batch.name}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">
                            {batch.gatheringTypeId ? 'Assigns to a gathering · ' : ''}
                            {batch.scheduleEnabled ? `Runs ${batch.scheduleFrequency}` : 'Manual only'}
                          </p>
                          {batch.lastSyncResult && (
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              Last run {new Date(batch.lastSyncResult.at).toLocaleString()}: {batch.lastSyncResult.added} added, {batch.lastSyncResult.updated} updated, {batch.lastSyncResult.linked} linked
                              {batch.lastSyncResult.ambiguous ? `, ${batch.lastSyncResult.ambiguous} need review` : ''}.
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setEditingBatch(batch)} className="text-sm underline text-gray-600 dark:text-gray-300">Edit</button>
                          <button type="button" onClick={() => runBatchNow(batch.id)} disabled={runningBatchId === batch.id}
                            className="text-sm underline text-gray-600 dark:text-gray-300 disabled:opacity-50">
                            {runningBatchId === batch.id ? 'Syncing…' : 'Run now'}
                          </button>
                          <button type="button" onClick={() => setReviewingBatchId(reviewingBatchId === batch.id ? null : batch.id)}
                            className="text-sm underline text-gray-600 dark:text-gray-300">
                            {reviewingBatchId === batch.id ? 'Hide review' : 'Review & sync'}
                          </button>
                          <button type="button" onClick={() => deleteBatch(batch.id)} className="text-sm underline text-red-600 dark:text-red-400">Delete</button>
                        </div>
                      </div>
                      {reviewingBatchId === batch.id && (
                        <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
                          <PlanningCenterSyncReview connected={status.connected} batchId={batch.id} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Reconciliation: people no longer in PCO at all */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Check for people who left</p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Finds active people whose name doesn't match anyone in Planning Center at all, across every saved batch.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button type="button" onClick={() => { setReconciliationScheduleEnabled((v) => !v); setReconciliationDirty(true); }}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${reconciliationScheduleEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                    role="switch" aria-checked={reconciliationScheduleEnabled}>
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${reconciliationScheduleEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                  <span className="text-sm text-gray-700 dark:text-gray-300">{reconciliationScheduleEnabled ? 'Runs automatically' : 'Manual only'}</span>
                  {reconciliationScheduleEnabled && (
                    <>
                      <select value={reconciliationFrequency}
                        onChange={(e) => { setReconciliationFrequency(e.target.value as 'daily' | 'weekly' | 'monthly'); setReconciliationDirty(true); }}
                        className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500">
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                      {reconciliationFrequency === 'weekly' && (
                        <select value={reconciliationDay}
                          onChange={(e) => { setReconciliationDay(Number(e.target.value)); setReconciliationDirty(true); }}
                          className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm focus:ring-green-500 focus:border-green-500">
                          <option value={0}>Sunday</option>
                          <option value={1}>Monday</option>
                          <option value={2}>Tuesday</option>
                          <option value={3}>Wednesday</option>
                          <option value={4}>Thursday</option>
                          <option value={5}>Friday</option>
                          <option value={6}>Saturday</option>
                        </select>
                      )}
                      <button type="button" onClick={saveReconciliationConfig} disabled={!reconciliationDirty || reconciliationSaving}
                        className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50">
                        {reconciliationSaving ? 'Saving…' : 'Save schedule'}
                      </button>
                    </>
                  )}
                  <button type="button" onClick={() => setShowReconciliationReview((v) => !v)}
                    className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
                    {showReconciliationReview ? 'Hide check' : 'Check now'}
                  </button>
                </div>
                {reconciliationLastResult && (
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    Last checked {new Date(reconciliationLastResult.at).toLocaleString()}: {reconciliationLastResult.archived} archived.
                  </p>
                )}
                {showReconciliationReview && (
                  <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
                    <PlanningCenterReconciliationReview />
                  </div>
                )}
              </div>

              {/* Check-in attendance import */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                <PCOCheckinImport />
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
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                Are you sure you want to disconnect from Planning Center?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Your OAuth tokens will be removed. You can reconnect at any time.
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowPlanningCenterDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmPlanningCenterDisconnect}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors"
              >
                <LinkSlashIcon className="h-4 w-4 mr-2" />
                Disconnect
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default PlanningCenterIntegrationPanel;
