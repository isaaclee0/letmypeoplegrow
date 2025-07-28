import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { invitationsAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import {
  CheckIcon,
  ExclamationTriangleIcon,
  UserPlusIcon
} from '@heroicons/react/24/outline';

interface InvitationDetails {
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  token: string;
}

const AcceptInvitationPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('Invalid invitation link');
      setIsLoading(false);
      return;
    }

    const fetchInvitation = async () => {
      try {
        const response = await invitationsAPI.accept(token);
        setInvitation(response.data.invitation);
      } catch (err: any) {
        setError(err.response?.data?.error || 'Invalid or expired invitation');
      } finally {
        setIsLoading(false);
      }
    };

    fetchInvitation();
  }, [token]);

  const handleAcceptInvitation = async () => {
    if (!invitation || !token) return;

    setIsAccepting(true);
    setError('');

    try {
      // Complete the invitation (create user account)
      await invitationsAPI.complete(token, {});
      
      setSuccess(true);
      
      // Wait a moment then redirect to login
      setTimeout(() => {
        navigate('/login', { 
          state: { 
            email: invitation.email, 
            message: 'Account created successfully! Please log in.' 
          }
        });
      }, 2000);

    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to accept invitation');
    } finally {
      setIsAccepting(false);
    }
  };

  const getRoleDisplayName = (role: string) => {
    switch (role) {
      case 'coordinator': return 'Coordinator';
      case 'attendance_taker': return 'Attendance Taker';
      default: return role;
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary-600 mx-auto"></div>
            <h2 className="mt-6 text-lg font-medium text-gray-900">
              Loading invitation...
            </h2>
          </div>
        </div>
      </div>
    );
  }

  if (error && !invitation) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <ExclamationTriangleIcon className="mx-auto h-24 w-24 text-red-500" />
            <h2 className="mt-6 text-3xl font-bold text-gray-900">
              Invalid Invitation
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              {error}
            </p>
            <div className="mt-5">
              <button
                onClick={() => navigate('/login')}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
              >
                Go to Login
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full space-y-8">
          <div className="text-center">
            <CheckIcon className="mx-auto h-24 w-24 text-green-500" />
            <h2 className="mt-6 text-3xl font-bold text-gray-900">
              Account Created!
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              Your account has been created successfully. You'll be redirected to the login page in a moment.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <UserPlusIcon className="mx-auto h-24 w-24 text-primary-600" />
          <h2 className="mt-6 text-3xl font-bold text-gray-900">
            You're Invited!
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Join Let My People Grow - Church Attendance Tracking and Reporting
          </p>
        </div>

        <div className="bg-white shadow rounded-lg p-6">
          {invitation && (
            <div className="space-y-4">
              <div className="border-b border-gray-200 pb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Invitation Details
                </h3>
              </div>
              
              <div className="space-y-3">
                <div>
                  <span className="text-sm font-medium text-gray-500">Name:</span>
                  <p className="text-sm text-gray-900">
                    {invitation.firstName} {invitation.lastName}
                  </p>
                </div>
                
                <div>
                  <span className="text-sm font-medium text-gray-500">Email:</span>
                  <p className="text-sm text-gray-900">{invitation.email}</p>
                </div>
                
                <div>
                  <span className="text-sm font-medium text-gray-500">Role:</span>
                  <p className="text-sm text-gray-900">
                    {getRoleDisplayName(invitation.role)}
                  </p>
                </div>
              </div>

              <div className="border-t border-gray-200 pt-4">
                <p className="text-sm text-gray-600 mb-4">
                  By accepting this invitation, you'll create an account and gain access to the church attendance tracking system.
                </p>
                
                {error && (
                  <div className="mb-4 rounded-md bg-red-50 p-4">
                    <div className="text-sm text-red-700">{error}</div>
                  </div>
                )}

                <div className="flex space-x-3">
                  <button
                    onClick={() => navigate('/login')}
                    className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAcceptInvitation}
                    disabled={isAccepting}
                    className="flex-1 inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                  >
                    {isAccepting ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                        Creating Account...
                      </>
                    ) : (
                      'Accept Invitation'
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AcceptInvitationPage; 