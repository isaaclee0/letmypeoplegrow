import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { usersAPI, invitationsAPI, gatheringsAPI } from '../services/api';
import ActionMenu from '../components/ActionMenu';
import { useSearchParams } from 'react-router-dom';
import {
  UserIcon,
  UserGroupIcon,
  EnvelopeIcon,
  PhoneIcon,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  EyeIcon,
  ClockIcon,
  CheckIcon,
  XMarkIcon,
  PaperAirplaneIcon,
} from '@heroicons/react/24/outline';

interface User {
  id: number;
  email?: string;
  mobileNumber?: string;
  primaryContactMethod: 'email' | 'sms';
  role: 'admin' | 'coordinator' | 'attendance_taker';
  firstName: string;
  lastName: string;
  isActive: boolean;
  isInvited: boolean;
  firstLoginCompleted: boolean;
  gatheringCount: number;
  createdAt: string;
}

interface Invitation {
  id: number;
  email?: string;
  mobileNumber?: string;
  role: 'coordinator' | 'attendance_taker';
  firstName: string;
  lastName: string;
  expiresAt: string;
  createdAt: string;
  invitedByFirstName: string;
  invitedByLastName: string;
}

interface GatheringType {
  id: number;
  name: string;
  description?: string;
}

const UsersPage: React.FC = () => {
  const { user: currentUser } = useAuth();
  const [searchParams] = useSearchParams();
  const [users, setUsers] = useState<User[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [gatherings, setGatherings] = useState<GatheringType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  // Modal states
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showUserDetails, setShowUserDetails] = useState(false);
  const [showAssignGatherings, setShowAssignGatherings] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [userAssignments, setUserAssignments] = useState<GatheringType[]>([]);
  const [availableGatherings, setAvailableGatherings] = useState<GatheringType[]>([]);

  // Form states
  const [inviteForm, setInviteForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    mobileNumber: '',
    primaryContactMethod: 'email' as 'email' | 'sms',
    role: 'attendance_taker' as 'coordinator' | 'attendance_taker',
    gatheringIds: [] as number[]
  });

  const [assignForm, setAssignForm] = useState({
    gatheringIds: [] as number[]
  });

  // Confirmation modal states
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showDeactivateModal, setShowDeactivateModal] = useState(false);
  const [cancelConfirmation, setCancelConfirmation] = useState<{
    invitationId: number | null;
  }>({ invitationId: null });
  const [deactivateConfirmation, setDeactivateConfirmation] = useState<{
    userId: number | null;
    userName: string;
  }>({ userId: null, userName: '' });

  useEffect(() => {
    loadData();
  }, []);

  // Handle profile parameter to open current user's details
  useEffect(() => {
    const profileParam = searchParams.get('profile');
    if (profileParam === 'me' && currentUser && users.length > 0) {
      const currentUserInList = users.find(user => user.id === currentUser.id);
      if (currentUserInList) {
        handleViewUserDetails(currentUserInList);
      }
    }
  }, [searchParams, currentUser, users]);

  const loadData = async () => {
    try {
      setIsLoading(true);
      setError('');
      
      const [usersResponse, invitationsResponse, gatheringsResponse] = await Promise.all([
        usersAPI.getAll(),
        invitationsAPI.getPending(),
        gatheringsAPI.getAll()
      ]);

      setUsers(usersResponse.data.users || []);
      setInvitations(invitationsResponse.data.invitations || []);
      setGatherings(gatheringsResponse.data.gatherings || []);
      
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to load data';
      setError(errorMessage);
      console.error('Failed to load data:', {
        error: errorMessage,
        response: err.response?.data,
        status: err.response?.status
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendInvitation = async () => {
    try {
      setError('');
      
      // Validate form
      if (!inviteForm.firstName || !inviteForm.lastName) {
        const errorMsg = 'First name and last name are required';
        setError(errorMsg);
        return;
      }

      if (inviteForm.primaryContactMethod === 'email' && !inviteForm.email) {
        const errorMsg = 'Email is required when primary contact method is email';
        setError(errorMsg);
        return;
      }

      if (inviteForm.primaryContactMethod === 'sms' && !inviteForm.mobileNumber) {
        const errorMsg = 'Mobile number is required when primary contact method is SMS';
        setError(errorMsg);
        return;
      }

      if (!inviteForm.email && !inviteForm.mobileNumber) {
        const errorMsg = 'Either email or mobile number must be provided';
        setError(errorMsg);
        return;
      }

      const response = await invitationsAPI.send(inviteForm);
      
      setSuccess('Invitation sent successfully');
      setShowInviteModal(false);
      setInviteForm({
        firstName: '',
        lastName: '',
        email: '',
        mobileNumber: '',
        primaryContactMethod: 'email',
        role: 'attendance_taker',
        gatheringIds: []
      });
      
      // Reload invitations
      const invitationsResponse = await invitationsAPI.getPending();
      setInvitations(invitationsResponse.data.invitations || []);
      
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to send invitation';
      setError(errorMessage);
      console.error('Failed to send invitation:', {
        error: errorMessage,
        formData: inviteForm,
        response: err.response?.data,
        status: err.response?.status,
        statusText: err.response?.statusText
      });
    }
  };

  const handleResendInvitation = async (invitationId: number) => {
    try {
      const response = await invitationsAPI.resend(invitationId);
      
      setSuccess('Invitation resent successfully');
      loadData();
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to resend invitation';
      setError(errorMessage);
      console.error('Failed to resend invitation:', {
        invitationId,
        error: errorMessage,
        response: err.response?.data,
        status: err.response?.status
      });
    }
  };

  const showCancelConfirmation = (invitationId: number) => {
    setCancelConfirmation({ invitationId });
    setShowCancelModal(true);
  };

  const handleCancelInvitation = async () => {
    if (!cancelConfirmation.invitationId) return;

    try {
      await invitationsAPI.cancel(cancelConfirmation.invitationId);
      setSuccess('Invitation cancelled successfully');
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to cancel invitation');
    }
  };

  const handleViewUserDetails = async (user: User) => {
    try {
      setSelectedUser(user);
      const response = await usersAPI.getGatheringAssignments(user.id);
      setUserAssignments(response.data.currentAssignments || []);
      setAvailableGatherings(response.data.availableGatherings || []);
      setShowUserDetails(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load user details');
    }
  };

  const handleAssignGatherings = async (user: User) => {
    try {
      setSelectedUser(user);
      const response = await usersAPI.getGatheringAssignments(user.id);
      setUserAssignments(response.data.currentAssignments || []);
      setAvailableGatherings(response.data.availableGatherings || []);
      setAssignForm({
        gatheringIds: response.data.currentAssignments.map((g: any) => g.id)
      });
      setShowAssignGatherings(true);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load user assignments');
    }
  };

  const handleSaveAssignments = async () => {
    try {
      if (!selectedUser) return;
      
      await usersAPI.assignGatherings(selectedUser.id, assignForm.gatheringIds);
      setSuccess('Gathering assignments updated successfully');
      setShowAssignGatherings(false);
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update assignments');
    }
  };

  const showDeactivateConfirmation = (userId: number, userName: string) => {
    setDeactivateConfirmation({ userId, userName });
    setShowDeactivateModal(true);
  };

  const handleDeleteUser = async () => {
    if (!deactivateConfirmation.userId) return;

    try {
      await usersAPI.delete(deactivateConfirmation.userId);
      setSuccess('User deactivated successfully');
      loadData();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to deactivate user');
    }
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'bg-red-100 text-red-800';
      case 'coordinator':
        return 'bg-blue-100 text-blue-800';
      case 'attendance_taker':
        return 'bg-green-100 text-green-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusBadge = (user: User) => {
    if (!user.isActive) {
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Inactive</span>;
    }
    if (!user.firstLoginCompleted) {
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">Pending Setup</span>;
    }
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Active</span>;
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white overflow-hidden shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                Manage Users
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                Manage users, send invitations, and assign gathering access
              </p>
            </div>
            <div className="flex space-x-3">
              <button
                onClick={() => setShowInviteModal(true)}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
              >
                <PlusIcon className="h-4 w-4 mr-2" />
                Invite User
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <XMarkIcon className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          </div>
        </div>
      )}

      {success && (
        <div className="bg-green-50 border border-green-200 rounded-md p-4">
          <div className="flex">
            <CheckIcon className="h-5 w-5 text-green-400" />
            <div className="ml-3">
              <p className="text-sm text-green-700">{success}</p>
            </div>
          </div>
        </div>
      )}

      {/* Users Section */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
            Users ({users.length})
          </h3>
          
          {/* Mobile Card Layout */}
          <div className="block md:hidden space-y-4">
            {users.map((user) => (
              <div key={user.id} className="bg-gray-50 rounded-lg p-4 border">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-3 mb-2">
                      <UserIcon className="h-8 w-8 text-gray-400 flex-shrink-0" />
                      <div>
                        <h4 className="text-base font-medium text-gray-900">
                          {user.firstName} {user.lastName}
                        </h4>
                        <div className="text-sm text-gray-500">
                          {user.primaryContactMethod === 'email' ? (
                            <div className="flex items-center">
                              <EnvelopeIcon className="h-4 w-4 mr-1" />
                              <span className="truncate">{user.email}</span>
                            </div>
                          ) : (
                            <div className="flex items-center">
                              <PhoneIcon className="h-4 w-4 mr-1" />
                              <span>{user.mobileNumber}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex flex-wrap gap-2 mb-3">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleBadgeColor(user.role)}`}>
                        {user.role.replace('_', ' ')}
                      </span>
                      {getStatusBadge(user)}
                    </div>
                    
                    <div className="text-sm text-gray-600 mb-3">
                      {user.gatheringCount} gathering{user.gatheringCount !== 1 ? 's' : ''}
                    </div>
                    
                    <div className="flex space-x-3">
                      <ActionMenu
                        items={[
                          {
                            label: 'View Details',
                            icon: <EyeIcon className="h-4 w-4" />,
                            onClick: () => handleViewUserDetails(user),
                          },
                          {
                            label: 'Assign Gatherings',
                            icon: <UserGroupIcon className="h-4 w-4" />,
                            onClick: () => handleAssignGatherings(user),
                          },
                          {
                            label: 'Deactivate User',
                            icon: <TrashIcon className="h-4 w-4" />,
                            onClick: () => showDeactivateConfirmation(user.id, `${user.firstName} ${user.lastName}`),
                            className: 'text-red-600 hover:bg-red-50',
                            hidden: currentUser?.role !== 'admin'
                          },
                        ]}
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop Table Layout */}
          <div className="hidden md:block overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    User
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Contact
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Role
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Gatherings
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          <UserIcon className="h-10 w-10 text-gray-400" />
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900">
                            {user.firstName} {user.lastName}
                          </div>
                          <div className="text-sm text-gray-500">
                            {user.primaryContactMethod === 'email' ? 'Email User' : 'SMS User'}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {user.primaryContactMethod === 'email' ? (
                          <div className="flex items-center">
                            <EnvelopeIcon className="h-4 w-4 mr-2 text-gray-400" />
                            {user.email}
                          </div>
                        ) : (
                          <div className="flex items-center">
                            <PhoneIcon className="h-4 w-4 mr-2 text-gray-400" />
                            {user.mobileNumber}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleBadgeColor(user.role)}`}>
                        {user.role.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {getStatusBadge(user)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {user.gatheringCount} gathering{user.gatheringCount !== 1 ? 's' : ''}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                      <div className="flex space-x-2">
                        <ActionMenu
                          items={[
                            {
                              label: 'View Details',
                              icon: <EyeIcon className="h-4 w-4" />,
                              onClick: () => handleViewUserDetails(user),
                            },
                            {
                              label: 'Assign Gatherings',
                              icon: <UserGroupIcon className="h-4 w-4" />,
                              onClick: () => handleAssignGatherings(user),
                            },
                            {
                              label: 'Deactivate User',
                              icon: <TrashIcon className="h-4 w-4" />,
                              onClick: () => showDeactivateConfirmation(user.id, `${user.firstName} ${user.lastName}`),
                              className: 'text-red-600 hover:bg-red-50',
                              hidden: currentUser?.role !== 'admin'
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Pending Invitations Section */}
      {invitations.length > 0 && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h3 className="text-lg leading-6 font-medium text-gray-900 mb-4">
              Pending Invitations ({invitations.length})
            </h3>
            
            {/* Mobile Card Layout for Invitations */}
            <div className="block md:hidden space-y-4">
              {invitations.map((invitation) => (
                <div key={invitation.id} className="bg-gray-50 rounded-lg p-4 border">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="text-base font-medium text-gray-900">
                        {invitation.firstName} {invitation.lastName}
                      </h4>
                      <div className="text-sm text-gray-600">
                        {invitation.email || invitation.mobileNumber}
                      </div>
                    </div>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleBadgeColor(invitation.role)}`}>
                      {invitation.role.replace('_', ' ')}
                    </span>
                  </div>
                  
                  <div className="text-sm text-gray-600 mb-3">
                    <div>Invited by: {invitation.invitedByFirstName} {invitation.invitedByLastName}</div>
                    <div>Expires: {new Date(invitation.expiresAt).toLocaleDateString()}</div>
                  </div>
                  
                  <div className="flex space-x-3">
                    <ActionMenu
                      items={[
                        {
                          label: 'Resend Invitation',
                          icon: <PaperAirplaneIcon className="h-4 w-4" />,
                          onClick: () => handleResendInvitation(invitation.id),
                        },
                        {
                          label: 'Cancel Invitation',
                          icon: <XMarkIcon className="h-4 w-4" />,
                          onClick: () => showCancelConfirmation(invitation.id),
                          className: 'text-red-600 hover:bg-red-50'
                        },
                      ]}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop Table Layout for Invitations */}
            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Invitee
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Contact
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Role
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Invited By
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Expires
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {invitations.map((invitation) => (
                    <tr key={invitation.id}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">
                          {invitation.firstName} {invitation.lastName}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">
                          {invitation.email || invitation.mobileNumber}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleBadgeColor(invitation.role)}`}>
                          {invitation.role.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {invitation.invitedByFirstName} {invitation.invitedByLastName}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {new Date(invitation.expiresAt).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                        <ActionMenu
                          items={[
                            {
                              label: 'Resend Invitation',
                              icon: <PaperAirplaneIcon className="h-4 w-4" />,
                              onClick: () => handleResendInvitation(invitation.id),
                            },
                            {
                              label: 'Cancel Invitation',
                              icon: <XMarkIcon className="h-4 w-4" />,
                              onClick: () => showCancelConfirmation(invitation.id),
                              className: 'text-red-600 hover:bg-red-50'
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Invite User Modal */}
      {showInviteModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Invite New User</h3>
              
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">First Name</label>
                    <input
                      type="text"
                      value={inviteForm.firstName}
                      onChange={(e) => setInviteForm({ ...inviteForm, firstName: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Last Name</label>
                    <input
                      type="text"
                      value={inviteForm.lastName}
                      onChange={(e) => setInviteForm({ ...inviteForm, lastName: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Primary Contact Method</label>
                  <select
                    value={inviteForm.primaryContactMethod}
                    onChange={(e) => setInviteForm({ ...inviteForm, primaryContactMethod: e.target.value as 'email' | 'sms' })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                  </select>
                </div>

                {inviteForm.primaryContactMethod === 'email' ? (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Email</label>
                    <input
                      type="email"
                      value={inviteForm.email}
                      onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Mobile Number</label>
                    <input
                      type="tel"
                      value={inviteForm.mobileNumber}
                      onChange={(e) => setInviteForm({ ...inviteForm, mobileNumber: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700">Role</label>
                  <select
                    value={inviteForm.role}
                    onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value as 'coordinator' | 'attendance_taker' })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="attendance_taker">Attendance Taker</option>
                    <option value="coordinator">Coordinator</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Assign to Gatherings (Optional)</label>
                  <select
                    multiple
                    value={inviteForm.gatheringIds.map(String)}
                    onChange={(e) => {
                      const selectedOptions = Array.from(e.target.selectedOptions, option => parseInt(option.value));
                      setInviteForm({ ...inviteForm, gatheringIds: selectedOptions });
                    }}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    {gatherings.map((gathering) => (
                      <option key={gathering.id} value={gathering.id}>
                        {gathering.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-sm text-gray-500">Hold Ctrl/Cmd to select multiple gatherings</p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row justify-end space-y-2 sm:space-y-0 sm:space-x-3 mt-6">
                <button
                  onClick={() => setShowInviteModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSendInvitation}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700"
                >
                  Send Invitation
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* User Details Modal */}
      {showUserDetails && selectedUser && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">User Details</h3>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Name</label>
                  <p className="mt-1 text-sm text-gray-900">{selectedUser.firstName} {selectedUser.lastName}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Contact</label>
                  <p className="mt-1 text-sm text-gray-900">
                    {selectedUser.primaryContactMethod === 'email' ? selectedUser.email : selectedUser.mobileNumber}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Role</label>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleBadgeColor(selectedUser.role)}`}>
                    {selectedUser.role.replace('_', ' ')}
                  </span>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Status</label>
                  <div className="mt-1">{getStatusBadge(selectedUser)}</div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Gathering Assignments</label>
                  <div className="mt-1">
                    {userAssignments.length > 0 ? (
                      <ul className="text-sm text-gray-900">
                        {userAssignments.map((gathering) => (
                          <li key={gathering.id} className="py-1">
                            {gathering.name}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-gray-500">No gatherings assigned</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-end mt-6">
                <button
                  onClick={() => setShowUserDetails(false)}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Assign Gatherings Modal */}
      {showAssignGatherings && selectedUser && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                Assign Gatherings - {selectedUser.firstName} {selectedUser.lastName}
              </h3>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Select Gatherings</label>
                  <select
                    multiple
                    value={assignForm.gatheringIds.map(String)}
                    onChange={(e) => {
                      const selectedOptions = Array.from(e.target.selectedOptions, option => parseInt(option.value));
                      setAssignForm({ ...assignForm, gatheringIds: selectedOptions });
                    }}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    {availableGatherings.map((gathering) => (
                      <option key={gathering.id} value={gathering.id}>
                        {gathering.name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-sm text-gray-500">Hold Ctrl/Cmd to select multiple gatherings</p>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row justify-end space-y-2 sm:space-y-0 sm:space-x-3 mt-6">
                <button
                  onClick={() => setShowAssignGatherings(false)}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveAssignments}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700"
                >
                  Save Assignments
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Invitation Confirmation Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Confirm Cancellation
                </h3>
                <button
                  onClick={() => setShowCancelModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                <XMarkIcon className="h-6 w-6 text-red-600" />
              </div>
              
              <div className="text-center mb-6">
                <p className="text-sm text-gray-500">
                  Are you sure you want to cancel this invitation? This action cannot be undone.
                </p>
              </div>
              
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowCancelModal(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Keep Invitation
                </button>
                <button
                  onClick={async () => {
                    await handleCancelInvitation();
                    setShowCancelModal(false);
                    setCancelConfirmation({ invitationId: null });
                  }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                >
                  Cancel Invitation
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deactivate User Confirmation Modal */}
      {showDeactivateModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Confirm Deactivation
                </h3>
                <button
                  onClick={() => setShowDeactivateModal(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 rounded-full">
                <TrashIcon className="h-6 w-6 text-red-600" />
              </div>
              
              <div className="text-center mb-6">
                <p className="text-sm text-gray-500">
                  Are you sure you want to deactivate <strong>{deactivateConfirmation.userName}</strong>? This action cannot be undone.
                </p>
              </div>
              
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowDeactivateModal(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    await handleDeleteUser();
                    setShowDeactivateModal(false);
                    setDeactivateConfirmation({ userId: null, userName: '' });
                  }}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                >
                  Deactivate User
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UsersPage; 