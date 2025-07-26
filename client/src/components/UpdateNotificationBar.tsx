import React, { useState } from 'react';
import { useMigration } from '../contexts/MigrationContext';
import { useAuth } from '../contexts/AuthContext';
import {
  ExclamationTriangleIcon,
  CheckCircleIcon,
  XMarkIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';

const UpdateNotificationBar: React.FC = () => {
  const { migrationStatus, isLoading, runAllMigrations } = useMigration();
  const { user } = useAuth();
  const [isExpanded, setIsExpanded] = useState(false);

  // Only show for admin users with pending migrations
  if (!user || user.role !== 'admin' || !migrationStatus?.hasPending) {
    return null;
  }

  const handleRunAllMigrations = async () => {
    try {
      await runAllMigrations();
    } catch (error) {
      // Error is handled by the context
      console.error('Failed to run migrations:', error);
    }
  };

  const getStatusIcon = () => {
    if (migrationStatus.hasFailed) {
      return <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />;
    }
    return <ArrowPathIcon className="h-5 w-5 text-yellow-400" />;
  };

  const getStatusText = () => {
    if (migrationStatus.hasFailed) {
      return `Database update failed (${migrationStatus.failedCount} failed, ${migrationStatus.pendingCount} pending)`;
    }
    return `Database update available (${migrationStatus.pendingCount} pending)`;
  };

  const getStatusColor = () => {
    if (migrationStatus.hasFailed) {
      return 'bg-red-50 border-red-200 text-red-800';
    }
    return 'bg-yellow-50 border-yellow-200 text-yellow-800';
  };

  return (
    <div className={`border-b ${getStatusColor()}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between py-3">
          <div className="flex items-center">
            {getStatusIcon()}
            <p className="ml-3 text-sm font-medium">
              {getStatusText()}
            </p>
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="ml-3 text-sm underline hover:no-underline"
            >
              {isExpanded ? 'Hide details' : 'Show details'}
            </button>
          </div>
          
          <div className="flex items-center space-x-3">
            <button
              onClick={handleRunAllMigrations}
              disabled={isLoading}
              className="inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <ArrowPathIcon className="h-3 w-3 mr-1 animate-spin" />
                  Running...
                </>
              ) : (
                <>
                  <CheckCircleIcon className="h-3 w-3 mr-1" />
                  Run Update
                </>
              )}
            </button>
          </div>
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="pb-3">
            <div className="bg-white rounded-lg border border-gray-200 p-4">
              <h4 className="text-sm font-medium text-gray-900 mb-3">
                Pending Database Updates
              </h4>
              <div className="space-y-2">
                {migrationStatus.migrations
                  .filter(m => !m.executed)
                  .map((migration) => (
                    <div key={migration.version} className="flex items-center justify-between text-sm">
                      <div>
                        <span className="font-medium">{migration.version}</span>
                        <span className="text-gray-500 ml-2">- {migration.description}</span>
                      </div>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                        Pending
                      </span>
                    </div>
                  ))}
              </div>
              
              {migrationStatus.hasFailed && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <h4 className="text-sm font-medium text-red-900 mb-3">
                    Failed Updates
                  </h4>
                  <div className="space-y-2">
                    {migrationStatus.migrations
                      .filter(m => m.executed && m.status === 'failed')
                      .map((migration) => (
                        <div key={migration.version} className="flex items-center justify-between text-sm">
                          <div>
                            <span className="font-medium">{migration.version}</span>
                            <span className="text-gray-500 ml-2">- {migration.description}</span>
                            {migration.errorMessage && (
                              <div className="text-red-600 text-xs mt-1">
                                Error: {migration.errorMessage}
                              </div>
                            )}
                          </div>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                            Failed
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default UpdateNotificationBar; 