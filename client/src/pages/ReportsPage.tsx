import React, { useState } from 'react';
import { ChartBarIcon } from '@heroicons/react/24/outline';
import ReportTabs, { type ReportTabKey } from '../components/reports/ReportTabs';
import SelectedPeriodReport from '../components/reports/SelectedPeriodReport';
import { useAuth } from '../contexts/AuthContext';

const ComingSoonWorkspace: React.FC<{ name: string }> = ({ name }) => (
  <div
    role="status"
    aria-label={name}
    className="rounded-lg border border-dashed border-gray-300 bg-white px-6 py-12 text-center shadow-sm dark:border-gray-600 dark:bg-gray-800"
  >
    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{name}</h2>
    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
      Coming in the next implementation slice.
    </p>
  </div>
);

const ReportsPage: React.FC = () => {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<ReportTabKey>('selected-period');
  const hasReportsAccess = user?.role === 'admin' || user?.role === 'coordinator';

  if (!hasReportsAccess) {
    return (
      <div className="rounded-lg bg-white shadow dark:bg-gray-800">
        <div className="px-4 py-5 text-center sm:p-6">
          <ChartBarIcon className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">Access Restricted</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            You don't have permission to view reports. Contact your administrator for access.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="rounded-lg bg-white shadow dark:bg-gray-800">
        <div className="px-4 py-5 sm:p-6">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Reports &amp; Analytics</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            View attendance trends and insights
          </p>
        </div>
        <ReportTabs activeTab={activeTab} onChange={setActiveTab} />
      </header>

      <div
        id={`report-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`report-tab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === 'selected-period' && <SelectedPeriodReport />}
        {activeTab === 'long-term-health' && <ComingSoonWorkspace name="Long-term health" />}
        {activeTab === 'pastoral-care' && <ComingSoonWorkspace name="Pastoral care" />}
      </div>
    </div>
  );
};

export default ReportsPage;
