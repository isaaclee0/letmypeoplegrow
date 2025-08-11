import React, { useState } from 'react';
import { useAdvancedMigration } from '../contexts/AdvancedMigrationContext';
import { useAuth } from '../contexts/AuthContext';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';

const UpdateNotificationBar: React.FC = () => {
  const { healthStatus, executionHistory } = useAdvancedMigration();
  const { user } = useAuth();
  const [isVisible, setIsVisible] = useState(true);

  // Only show for admin users
  if (!user || user.role !== 'admin' || !isVisible) {
    return null;
  }

  // Check if there are any recent failed executions
  const recentFailedExecutions = executionHistory.filter(
    execution => execution.errorMessage && 
    new Date(execution.createdAt) > new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
  );

  if (recentFailedExecutions.length === 0) {
    return null;
  }

  return (
    <div className="bg-red-50 border-b border-red-200 text-red-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between py-3">
          <div className="flex items-center">
            <ExclamationTriangleIcon className="h-5 w-5 text-red-400" />
            <p className="ml-3 text-sm font-medium">
              Recent migration execution failures detected. Check the Advanced Migrations page for details.
            </p>
          </div>
          
          <div className="flex items-center space-x-3">
            <button
              onClick={() => setIsVisible(false)}
              className="text-red-400 hover:text-red-600"
            >
              <InformationCircleIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UpdateNotificationBar; 