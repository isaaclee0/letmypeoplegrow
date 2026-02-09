import React, { useState } from 'react';
import { InformationCircleIcon } from '@heroicons/react/24/outline';

const DataSecurityInfo: React.FC = () => {
  const [showDataSecurityInfo, setShowDataSecurityInfo] = useState(false);

  return (
    <div className="bg-white shadow rounded-lg">
      <div className="px-4 py-3 sm:px-6">
        <button
          onClick={() => setShowDataSecurityInfo(!showDataSecurityInfo)}
          className="flex items-center text-sm text-gray-600 hover:text-gray-800 transition-colors"
        >
          <InformationCircleIcon className="h-4 w-4 mr-2" />
          Data Security Information
          <span className="ml-1 text-xs text-gray-400">
            {showDataSecurityInfo ? '▼' : '▶'}
          </span>
        </button>

        {showDataSecurityInfo && (
          <div className="mt-3 p-4 bg-blue-50 border border-blue-200 rounded-md">
            <div className="text-sm text-blue-800">
              <p className="mb-2">
                <strong>Data Collection:</strong> This system only records names and basic family information.
                No sensitive personal data such as addresses, phone numbers, or financial information is stored.
              </p>
              <p className="mb-2">
                <strong>Access Control:</strong> Information stored in the system is only accessible to users
                with active logins and appropriate permissions within your church organisation.
              </p>
              <p className="text-blue-700">
                <strong>User Responsibility:</strong> You are responsible for the security of the information
                you enter into this system. Please ensure that only authorised personnel have access to
                user accounts and that login credentials are kept secure.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DataSecurityInfo;
