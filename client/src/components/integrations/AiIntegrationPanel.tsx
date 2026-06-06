import React, { useState, useEffect } from 'react';
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
import { aiAPI } from '../../services/api';
import Modal from '../Modal';
import logger from '../../utils/logger';
import { AiStatus, PanelProps } from './types';

const AiIntegrationPanel: React.FC<PanelProps<AiStatus> & { initialAction?: 'disconnect' }> = ({ status, refreshStatus, onBack, initialAction }) => {
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiProvider, setAiProvider] = useState<'openai' | 'anthropic' | 'grok'>('openai');
  const [aiSaving, setAiSaving] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAiDisconnectModal, setShowAiDisconnectModal] = useState(false);

  useEffect(() => {
    if (initialAction === 'disconnect') setShowAiDisconnectModal(true);
  }, [initialAction]);

  // Handle AI connect
  const handleAiConnect = async () => {
    if (!aiApiKey.trim()) {
      setAiError('Please enter your API key.');
      return;
    }
    try {
      setAiSaving(true);
      setAiError(null);
      await aiAPI.configure({ apiKey: aiApiKey.trim(), provider: aiProvider });
      setAiApiKey('');
      // Reload so the sidebar picks up the new AI Insights nav item
      window.location.reload();
    } catch (error: any) {
      logger.error('Failed to configure AI:', error);
      setAiError(error.response?.data?.error || error.response?.data?.details || 'Failed to connect. Please check your API key.');
    } finally {
      setAiSaving(false);
    }
  };

  // Handle AI disconnect
  const confirmAiDisconnect = async () => {
    setShowAiDisconnectModal(false);
    try {
      await aiAPI.disconnect();
      // Clear cached preference so sync doesn't re-insert it
      localStorage.removeItem('preference_ai_config');
      // Reload so the sidebar removes the AI Insights nav item
      window.location.reload();
    } catch (error: any) {
      logger.error('Failed to disconnect AI:', error);
      await refreshStatus();
    }
  };

  return (
    <div>
      {/* Back button */}
      <button
        onClick={onBack}
        className="inline-flex items-center text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 mb-4"
      >
        <ArrowLeftIcon className="h-4 w-4 mr-1.5" />
        Back to integrations
      </button>

      {/* AI Insights card body */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
        {/* AI Status Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center space-x-4">
            <div className="shrink-0">
              <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
            </div>
            <div>
              <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">AI Insights</h4>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Ask questions about your attendance data in plain language.
              </p>
              {status.configured && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center">
                  <CheckCircleIcon className="w-3 h-3 mr-1" />
                  Connected via {status.provider === 'openai' ? 'OpenAI' : status.provider === 'anthropic' ? 'Anthropic' : 'Grok'}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center space-x-3">
            {status.loading ? (
              <ArrowPathIcon className="w-5 h-5 animate-spin text-gray-400" />
            ) : status.configured ? (
              <>
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                  <ShieldCheckIcon className="w-3 h-3 mr-1" />
                  Connected
                </span>
                <button
                  onClick={() => setShowAiDisconnectModal(true)}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
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

        {/* AI Config Form - Only show when not connected */}
        {!status.configured && !status.loading && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
            <h5 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-4">Connect your AI provider</h5>
            <div className="space-y-4">
              <div>
                <label htmlFor="ai-provider" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  AI Provider
                </label>
                <select
                  id="ai-provider"
                  value={aiProvider}
                  onChange={(e) => setAiProvider(e.target.value as 'openai' | 'anthropic' | 'grok')}
                  className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                >
                  <option value="openai">OpenAI (ChatGPT)</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="grok">xAI (Grok)</option>
                </select>
              </div>
              <div>
                <label htmlFor="ai-api-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  API Key
                </label>
                <input
                  type="password"
                  id="ai-api-key"
                  value={aiApiKey}
                  onChange={(e) => setAiApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAiConnect()}
                  className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 shadow-sm focus:border-purple-500 focus:ring-purple-500 sm:text-sm"
                  placeholder={aiProvider === 'openai' ? 'sk-...' : aiProvider === 'anthropic' ? 'sk-ant-...' : 'xai-...'}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {aiProvider === 'openai'
                    ? 'Get your key from platform.openai.com/api-keys'
                    : aiProvider === 'anthropic'
                    ? 'Get your key from console.anthropic.com/settings/keys'
                    : 'Get your key from console.x.ai'}
                </p>
              </div>

              {aiError && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                  <div className="flex">
                    <ShieldExclamationIcon className="h-5 w-5 text-red-400 shrink-0" />
                    <div className="ml-2">
                      <p className="text-sm text-red-700 dark:text-red-400">{aiError}</p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={handleAiConnect}
                  disabled={aiSaving || !aiApiKey.trim()}
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-purple-600 hover:bg-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {aiSaving ? (
                    <>
                      <ArrowPathIcon className="h-4 w-4 mr-2 animate-spin" />
                      Validating...
                    </>
                  ) : (
                    <>
                      <LinkIcon className="h-4 w-4 mr-2" />
                      Connect
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-4">
          <div className="flex">
            <div className="shrink-0">
              <InformationCircleIcon className="h-5 w-5 text-purple-400" />
            </div>
            <div className="ml-3">
              <h4 className="text-sm font-medium text-purple-800 dark:text-purple-300">What you'll get</h4>
              <div className="mt-2 text-sm text-purple-700 dark:text-purple-400">
                <ul className="list-disc list-inside space-y-1">
                  <li>Ask questions about attendance in plain English</li>
                  <li>Get insights on attendance trends and patterns</li>
                  <li>Identify people who may need pastoral follow-up</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* AI Disconnect Confirmation Modal */}
      <Modal
        isOpen={showAiDisconnectModal}
        onClose={() => setShowAiDisconnectModal(false)}
      >
        <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full mx-4">
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Disconnect AI
              </h3>
              <button
                onClick={() => setShowAiDisconnectModal(false)}
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
                Are you sure you want to disconnect AI Insights?
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Your API key will be removed. You can reconnect at any time.
              </p>
            </div>

            <div className="flex space-x-3">
              <button
                onClick={() => setShowAiDisconnectModal(false)}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmAiDisconnect}
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

export default AiIntegrationPanel;
