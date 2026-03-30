import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { onboardingAPI } from '../services/api';
import { InformationCircleIcon } from '@heroicons/react/24/outline';

const SampleDataBanner: React.FC = () => {
  const { user, refreshUserData } = useAuth();
  const [isClearing, setIsClearing] = useState(false);

  if (!user?.hasSampleData) return null;

  const handleClear = async () => {
    setIsClearing(true);
    try {
      await onboardingAPI.clearSampleData();
      await refreshUserData();
      window.location.reload();
    } catch (error) {
      console.error('Failed to clear sample data:', error);
      setIsClearing(false);
    }
  };

  return (
    <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 flex items-center justify-between">
      <div className="flex items-center space-x-2 text-blue-800 dark:text-blue-200">
        <InformationCircleIcon className="h-5 w-5 shrink-0" />
        <span className="text-sm">You're viewing sample data to explore the app.</span>
      </div>
      <button
        onClick={handleClear}
        disabled={isClearing}
        className="text-sm font-medium text-blue-700 dark:text-blue-300 hover:text-blue-900 dark:hover:text-blue-100 underline disabled:opacity-50 whitespace-nowrap ml-4"
      >
        {isClearing ? 'Clearing...' : 'Clear sample data & start fresh'}
      </button>
    </div>
  );
};

export default SampleDataBanner;
