import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import {
  CheckIcon,
  CalendarIcon,
  ArrowRightIcon
} from '@heroicons/react/24/outline';

const FirstLoginSetupPage: React.FC = () => {
  const { user, updateUser } = useAuth();
  const navigate = useNavigate();
  
  const [selectedGathering, setSelectedGathering] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Auto-select if user only has one gathering assignment
  React.useEffect(() => {
    if (user?.gatheringAssignments && user.gatheringAssignments.length === 1) {
      setSelectedGathering(user.gatheringAssignments[0].id);
    }
  }, [user]);

  const handleSetDefault = async () => {
    if (!selectedGathering) {
      setError('Please select a gathering');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      // Save the selected gathering as last viewed instead of setting as default
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
      const lastViewed = {
        gatheringId: selectedGathering,
        date: today,
        timestamp: Date.now()
      };
      localStorage.setItem('attendance_last_viewed', JSON.stringify(lastViewed));
      
      // Redirect to attendance
      navigate('/app/attendance');

    } catch (err: any) {
      setError('Failed to save your preference');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSkip = () => {
    // Redirect to attendance
    navigate('/app/attendance');
  };

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <CalendarIcon className="mx-auto h-24 w-24 text-primary-600" />
          <h2 className="mt-6 text-3xl font-bold text-gray-900">
            Welcome, {user.firstName}!
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Let's set up your preferred gathering view
          </p>
        </div>

        <div className="bg-white shadow rounded-lg p-6">
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                Choose Your Preferred Gathering
              </h3>
              <p className="text-sm text-gray-600 mb-4">
                This will be your starting view when you log in. The system will remember your last viewed gathering and date.
              </p>
            </div>

            {user.gatheringAssignments && user.gatheringAssignments.length > 0 ? (
              <div className="space-y-3">
                {user.gatheringAssignments.map((gathering) => (
                  <label
                    key={gathering.id}
                    className={`relative flex cursor-pointer rounded-lg p-4 border ${
                      selectedGathering === gathering.id
                        ? 'border-primary-600 bg-primary-50'
                        : 'border-gray-300 bg-white hover:bg-gray-50'
                    } focus:outline-none`}
                  >
                    <input
                      type="radio"
                      name="gathering"
                      value={gathering.id}
                      checked={selectedGathering === gathering.id}
                      onChange={() => setSelectedGathering(gathering.id)}
                      className="sr-only"
                    />
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center">
                        <div className="text-sm">
                          <p className={`font-medium ${
                            selectedGathering === gathering.id ? 'text-primary-900' : 'text-gray-900'
                          }`}>
                            {gathering.name}
                          </p>
                          {gathering.description && (
                            <p className={`${
                              selectedGathering === gathering.id ? 'text-primary-700' : 'text-gray-500'
                            }`}>
                              {gathering.description}
                            </p>
                          )}
                        </div>
                      </div>
                      {selectedGathering === gathering.id && (
                        <CheckIcon className="h-5 w-5 text-primary-600" />
                      )}
                    </div>
                  </label>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-500">
                  No gatherings assigned yet. Contact your administrator to get access to gatherings.
                </p>
              </div>
            )}

            {error && (
              <div className="rounded-md bg-red-50 p-4">
                <div className="text-sm text-red-700">{error}</div>
              </div>
            )}

            <div className="flex space-x-3">
              <button
                onClick={handleSkip}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
              >
                Skip for Now
              </button>
              <button
                onClick={handleSetDefault}
                disabled={!selectedGathering || isLoading || !user.gatheringAssignments?.length}
                className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                    Saving...
                  </>
                ) : (
                  <>
                    Continue
                    <ArrowRightIcon className="ml-2 h-4 w-4" />
                  </>
                )}
              </button>
            </div>

            {user.gatheringAssignments && user.gatheringAssignments.length === 1 && (
              <div className="text-center">
                <p className="text-xs text-gray-500">
                  Since you only have access to one gathering, it's automatically selected.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FirstLoginSetupPage; 