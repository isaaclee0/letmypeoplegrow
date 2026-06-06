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
import { integrationsAPI, settingsAPI } from '../../services/api';
import Modal from '../Modal';
import logger from '../../utils/logger';
import MembershipAllowlistEditor from '../planningCenter/MembershipAllowlistEditor';
import PCOCheckinImport from '../PCOCheckinImport';
import PlanningCenterSyncReview from '../planningCenter/PlanningCenterSyncReview';
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
  const [pcAllowlist, setPcAllowlist] = useState<string[]>([]);
  const [pcSummary, setPcSummary] = useState<{ membership: string; count: number }[]>([]);
  const [pcSummaryLoading, setPcSummaryLoading] = useState(false);
  const [pcSummaryError, setPcSummaryError] = useState<string | null>(null);
  const [pcConfigDirty, setPcConfigDirty] = useState(false);
  const [pcConfigSaving, setPcConfigSaving] = useState(false);
  const [pcLastSync, setPcLastSync] = useState<any>(null);
  const [pcSyncRunning, setPcSyncRunning] = useState(false);
  const [showSyncReview, setShowSyncReview] = useState(false);

  const loadPcSyncConfig = useCallback(async () => {
    try {
      const filter = await integrationsAPI.getPlanningCenterMembershipFilter();
      setPcSyncEnabled(!!filter.data.enabled);
      setPcAllowlist(Array.isArray(filter.data.allowlist) ? filter.data.allowlist : []);
    } catch (e) { logger.error('Failed to load PCO sync filter', e); }
    setPcSummaryLoading(true);
    setPcSummaryError(null);
    try {
      const sum = await integrationsAPI.getPlanningCenterMembershipSummary();
      setPcSummary(sum.data.values || []);
    } catch (e: any) {
      setPcSummaryError(e.response?.data?.error || 'Failed to load membership categories.');
    } finally {
      setPcSummaryLoading(false);
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

  const savePcSyncConfig = async () => {
    setPcConfigSaving(true);
    try {
      await integrationsAPI.savePlanningCenterMembershipFilter({ enabled: pcSyncEnabled, allowlist: pcAllowlist });
      setPcConfigDirty(false);
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Failed to save sync settings.');
    } finally {
      setPcConfigSaving(false);
    }
  };

  const runPcSyncNow = async () => {
    setPcSyncRunning(true);
    try {
      const res = await integrationsAPI.applyPlanningCenterSync({});
      setPcLastSync(res.data.summary || null);
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Sync failed.');
    } finally {
      setPcSyncRunning(false);
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

  // Load sync config, summary, and sync indicator when connected
  useEffect(() => {
    if (status.connected) {
      loadPcSyncConfig();
      settingsAPI.getIntegrationSettings().then(r => {
        setPcSyncIndicator(!!r.data.planningCenterSyncIndicator);
      }).catch(() => {});
    }
  }, [status.connected, loadPcSyncConfig]);

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

              {/* Full people sync configuration */}
              <div className="mt-6 border-t border-gray-200 dark:border-gray-700 pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Enable Planning Center sync</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Treat Planning Center as the source of truth: add eligible people, sync names, archive when inactive (runs nightly).
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setPcSyncEnabled(prev => !prev); setPcConfigDirty(true); }}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 ${pcSyncEnabled ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-600'}`}
                    role="switch"
                    aria-checked={pcSyncEnabled}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${pcSyncEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </div>

                <div className="mt-4">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">Sync these membership categories</p>
                  <MembershipAllowlistEditor
                    values={pcSummary}
                    loading={pcSummaryLoading}
                    error={pcSummaryError}
                    selected={pcAllowlist}
                    onChange={(next) => { setPcAllowlist(next); setPcConfigDirty(true); }}
                    onReload={loadPcSyncConfig}
                  />
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={savePcSyncConfig}
                    disabled={!pcConfigDirty || pcConfigSaving}
                    className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700 disabled:opacity-50"
                  >
                    {pcConfigSaving ? 'Saving…' : 'Save sync settings'}
                  </button>
                  <button
                    type="button"
                    onClick={runPcSyncNow}
                    disabled={pcSyncRunning}
                    className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                  >
                    {pcSyncRunning ? 'Syncing…' : 'Sync now'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowSyncReview(v => !v)}
                    className="inline-flex items-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    {showSyncReview ? 'Hide review' : 'Review & sync'}
                  </button>
                </div>

                {showSyncReview && status.connected && (
                  <div className="mt-4 border-t border-gray-200 dark:border-gray-700 pt-4">
                    <PlanningCenterSyncReview connected={status.connected} />
                  </div>
                )}

                {pcLastSync && (
                  <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                    Last sync {pcLastSync.at ? new Date(pcLastSync.at).toLocaleString() : ''}: {pcLastSync.added ?? 0} added, {pcLastSync.updated ?? 0} updated, {pcLastSync.archived ?? 0} archived, {pcLastSync.reactivated ?? 0} reactivated, {pcLastSync.linked ?? 0} linked{typeof pcLastSync.ambiguous === 'number' ? `, ${pcLastSync.ambiguous} need review` : ''}.
                  </p>
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
