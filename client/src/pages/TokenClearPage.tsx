import React, { useState } from 'react';
import { authAPI } from '../services/api';

const TokenClearPage: React.FC = () => {
  const [isClearing, setIsClearing] = useState(false);
  const [message, setMessage] = useState('');

  const clearExpiredToken = async () => {
    setIsClearing(true);
    setMessage('');
    
    try {
      await authAPI.clearExpiredToken();
      setMessage('Token cleared successfully! You can now log in again.');
      
      // Clear any local storage
      localStorage.removeItem('user');
      
      // Redirect to login after a short delay
      setTimeout(() => {
        window.location.href = '/login';
      }, 2000);
    } catch (error) {
      console.error('Failed to clear token:', error);
      setMessage('Failed to clear token. Please try clearing your browser data manually.');
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">
              Clear Expired Token
            </h2>
            <p className="text-gray-600 mb-6">
              If you're having trouble logging in due to an expired token, 
              click the button below to clear it and start fresh.
            </p>
            
            <button
              onClick={clearExpiredToken}
              disabled={isClearing}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isClearing ? 'Clearing...' : 'Clear Expired Token'}
            </button>
            
            {message && (
              <div className={`mt-4 p-3 rounded-md ${
                message.includes('successfully') 
                  ? 'bg-green-50 text-green-800' 
                  : 'bg-red-50 text-red-800'
              }`}>
                {message}
              </div>
            )}
            
            <div className="mt-6 text-sm text-gray-500">
              <p>If this doesn't work, you can also:</p>
              <ul className="mt-2 text-left list-disc list-inside space-y-1">
                <li>Clear your browser's cookies and cache</li>
                <li>Try opening the app in an incognito/private window</li>
                <li>Contact your administrator for assistance</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TokenClearPage; 