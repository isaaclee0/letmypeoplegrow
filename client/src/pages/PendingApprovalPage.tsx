import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const PendingApprovalPage: React.FC = () => {
  const { user, isAuthenticated, isLoading, logout, refreshUserData } = useAuth();

  if (isLoading) {
    return null;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // If church is approved, redirect to app
  if (user && user.isChurchApproved !== false) {
    const hasGatherings = user.gatheringAssignments && user.gatheringAssignments.length > 0;
    return <Navigate to={hasGatherings ? '/app/attendance' : '/app/gatherings'} replace />;
  }

  const handleCheckStatus = async () => {
    await refreshUserData();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-500 via-primary-600 to-secondary-500 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8 bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-8">
        <div>
          <div className="mx-auto h-20 w-20 flex items-center justify-center">
            <img
              className="h-20 w-auto"
              src="/logo.svg"
              alt="Let My People Grow"
            />
          </div>
          <h2 className="mt-6 text-center text-2xl font-bold text-gray-900 dark:text-gray-100 font-title">
            Organisation Pending Approval
          </h2>
          <div className="mt-4 text-center">
            <div className="mx-auto w-16 h-16 bg-yellow-100 dark:bg-yellow-900/30 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-yellow-600 dark:text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Your organisation has been registered and is awaiting approval. Once approved, you'll be able to start using Let My People Grow.
            </p>
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-500">
              This usually doesn't take long. Check back soon!
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <button
            onClick={handleCheckStatus}
            className="w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
          >
            Check Approval Status
          </button>
          <button
            onClick={logout}
            className="w-full flex justify-center py-2 px-4 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
          >
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
};

export default PendingApprovalPage;
