import React from 'react';
import {
  ShieldCheckIcon,
  ShieldExclamationIcon,
  ArrowPathIcon,
  PencilIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';

interface IntegrationCardProps {
  name: string;
  description: string;
  /** Coloured 12x12 icon block rendered on the left. */
  icon: React.ReactNode;
  connected: boolean;
  loading: boolean;
  /** Optional sub-line shown under the description when connected (e.g. account name). */
  connectedLabel?: string;
  /** Opens the detail panel (pencil when connected, "Set up" when not). */
  onOpen: () => void;
  /** Only rendered when connected. */
  onDisconnect?: () => void;
  /** When set, renders a disabled "Not available" state with this message instead of the normal action area. */
  disabledMessage?: string;
}

const IntegrationCard: React.FC<IntegrationCardProps> = ({
  name, description, icon, connected, loading, connectedLabel, onOpen, onDisconnect, disabledMessage,
}) => {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="shrink-0">{icon}</div>
          <div>
            <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100">{name}</h4>
            <p className="text-sm text-gray-600 dark:text-gray-400">{description}</p>
            {connected && connectedLabel && (
              <p className="text-xs text-green-600 dark:text-green-400 mt-1 flex items-center">
                <CheckCircleIcon className="w-3 h-3 mr-1" />
                {connectedLabel}
              </p>
            )}
            {disabledMessage && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{disabledMessage}</p>
            )}
          </div>
        </div>
        <div className="flex items-center space-x-3">
          {disabledMessage ? (
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
              Not available
            </span>
          ) : loading ? (
            <ArrowPathIcon className="w-5 h-5 animate-spin text-gray-400" />
          ) : connected ? (
            <>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">
                <ShieldCheckIcon className="w-3 h-3 mr-1" />
                Connected
              </span>
              {onDisconnect && (
                <button
                  onClick={onDisconnect}
                  className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                >
                  Disconnect
                </button>
              )}
              <button
                onClick={onOpen}
                aria-label={`Edit ${name} settings`}
                className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
              >
                <PencilIcon className="h-4 w-4" />
              </button>
            </>
          ) : (
            <>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                <ShieldExclamationIcon className="w-3 h-3 mr-1" />
                Not Connected
              </span>
              <button
                onClick={onOpen}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
              >
                Set up
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default IntegrationCard;
