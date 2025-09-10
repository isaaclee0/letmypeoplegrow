import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../contexts/AuthContext';
import { usersAPI, gatheringsAPI } from '../services/api';
import { useSearchParams } from 'react-router-dom';
import {
  UserIcon,
  UserGroupIcon,
  EnvelopeIcon,
  PhoneIcon,
  PlusIcon,
  TrashIcon,
  CheckIcon,
  XMarkIcon,
  PaperAirplaneIcon,
  PencilIcon,
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
  lastLoginAt?: string | null;
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
  const [showEditUserModal, setShowEditUserModal] = useState(false);
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

  const [editForm, setEditForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    mobileNumber: '',
    primaryContactMethod: 'email' as 'email' | 'sms',
    role: 'attendance_taker' as 'admin' | 'coordinator' | 'attendance_taker'
  });

  // Validation states
  const [validationErrors, setValidationErrors] = useState<{[key: string]: string}>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Confirmation modal states
  const [showDeactivateModal, setShowDeactivateModal] = useState(false);
  const [showInviteConfirmation, setShowInviteConfirmation] = useState(false);
  const [cancelConfirmation, setCancelConfirmation] = useState<{
    invitationId: number | null;
  }>({ invitationId: null });
  const [deactivateConfirmation, setDeactivateConfirmation] = useState<{
    userId: number | null;
    userName: string;
  }>({ userId: null, userName: '' });

  // Selection state
  const [selectedUsers, setSelectedUsers] = useState<number[]>([]);

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
      
      const [usersResponse, gatheringsResponse] = await Promise.all([
        usersAPI.getAll(),
        gatheringsAPI.getAll()
      ]);

      setUsers(usersResponse.data.users || []);
      setGatherings(gatheringsResponse.data.gatherings || []);
      
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to load data';
      setError(errorMessage);
      
      // Clear error message after 8 seconds
      setTimeout(() => setError(''), 8000);
      
      console.error('Failed to load data:', {
        error: errorMessage,
        response: err.response?.data,
        status: err.response?.status
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Real-time validation function
  const validateInviteForm = () => {
    const errors: {[key: string]: string} = {};
    
    // Validate first name
    if (!inviteForm.firstName.trim()) {
      errors.firstName = 'First name is required';
    } else if (inviteForm.firstName.trim().length < 2) {
      errors.firstName = 'First name must be at least 2 characters';
    }
    
    // Validate last name
    if (!inviteForm.lastName.trim()) {
      errors.lastName = 'Last name is required';
    } else if (inviteForm.lastName.trim().length < 2) {
      errors.lastName = 'Last name must be at least 2 characters';
    }
    
    // Validate email
    if (!inviteForm.email.trim()) {
      errors.email = 'Email address is required';
    } else {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(inviteForm.email.trim())) {
        errors.email = 'Please enter a valid email address';
      }
    }
    
    // Validate mobile number if provided - be very flexible
    if (inviteForm.mobileNumber.trim()) {
      const cleanedNumber = inviteForm.mobileNumber.trim();
      
      // Check if it starts with + (international format)
      if (cleanedNumber.startsWith('+')) {
        // For international format, remove all non-digit characters except + at start
        let digitsOnly = cleanedNumber.replace(/[^\d+]/g, '');
        
        // Handle the (0) convention - if we have +61 followed by 0, remove the 0
        // This handles cases like +61 (0) 478 622 814 -> +61 478 622 814
        digitsOnly = digitsOnly.replace(/^\+61(0)/, '+61');
        
        // International format: + followed by country code + number (no leading 0 after country code)
        // Common patterns: +61 4xxxxxxx, +1 555xxxxxxx, +44 7xxxxxxxx
        if (!/^\+[1-9]\d{6,14}$/.test(digitsOnly)) {
          errors.mobileNumber = 'Please enter a valid international mobile number (e.g., +61 4 1234 5678)';
        }
      } else {
        // For local format, remove all non-digit characters
        const digitsOnly = cleanedNumber.replace(/[^\d]/g, '');
        
        // Local format: 4-15 digits, can start with 0
        if (!/^[0-9]{4,15}$/.test(digitsOnly)) {
          errors.mobileNumber = 'Please enter a valid mobile number (e.g., 0412 345 678 or 04 1234 5678)';
        }
      }
    }
    
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSendInvitation = async () => {
    try {
      setError('');
      setValidationErrors({});
      
      // Validate form
      if (!validateInviteForm()) {
        return;
      }

      // Show confirmation modal
      setShowInviteConfirmation(true);
    } catch (err: any) {
      setIsSubmitting(false);
      const serverErrors = err.response?.data?.errors;
      const errorMessage = err.response?.data?.error || (Array.isArray(serverErrors) && serverErrors.length ? serverErrors[0]?.msg : 'Failed to send invitation');
      setError(errorMessage);
      
      // Clear error message after 8 seconds
      setTimeout(() => setError(''), 8000);
      
      console.error('Failed to send invitation:', {
        error: errorMessage,
        formData: inviteForm,
        response: err.response?.data,
        status: err.response?.status,
        statusText: err.response?.statusText
      });
    }
  };

  const handleConfirmInvitation = async () => {
    try {
      setIsSubmitting(true);
      setShowInviteConfirmation(false);
      
      // Set primary contact method to email
      const primaryContactMethod = 'email';

      await fetch('/api/invitations/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...inviteForm, primaryContactMethod })
      });
      
      setSuccess('User invited successfully! They can now log in using their email or mobile number with a one-time code.');
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
      
      // Reload data to show the new user
      loadData();
      
      // Clear success message after 5 seconds
      setTimeout(() => setSuccess(''), 5000);
      
      setIsSubmitting(false);
      
    } catch (err: any) {
      setIsSubmitting(false);
      const serverErrors = err.response?.data?.errors;
      const errorMessage = err.response?.data?.error || (Array.isArray(serverErrors) && serverErrors.length ? serverErrors[0]?.msg : 'Failed to send invitation');
      setError(errorMessage);
      
      // Clear error message after 8 seconds
      setTimeout(() => setError(''), 8000);
      
      console.error('Failed to send invitation:', {
        error: errorMessage,
        formData: inviteForm,
        response: err.response?.data,
        status: err.response?.status,
        statusText: err.response?.statusText
      });
    }
  };

  // Pending invitation actions removed

  const handleViewUserDetails = async (user: User) => {
    try {
      setSelectedUser(user);
      const response = await usersAPI.getGatheringAssignments(user.id);
      setUserAssignments(response.data.currentAssignments || []);
      setAvailableGatherings(response.data.availableGatherings || []);
      setShowUserDetails(true);
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to load user details';
      setError(errorMessage);
      
      // Clear error message after 8 seconds
      setTimeout(() => setError(''), 8000);
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
      const errorMessage = err.response?.data?.error || 'Failed to load user assignments';
      setError(errorMessage);
      
      // Clear error message after 8 seconds
      setTimeout(() => setError(''), 8000);
    }
  };

  const handleSaveAssignments = async () => {
    try {
      if (!selectedUser) return;
      
      await usersAPI.assignGatherings(selectedUser.id, assignForm.gatheringIds);
      setSuccess('Gathering assignments updated successfully');
      setShowAssignGatherings(false);
      
      // Clear selection after successful assignment
      setSelectedUsers([]);
      
      loadData();
      
      // Clear success message after 5 seconds
      setTimeout(() => setSuccess(''), 5000);
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to update assignments';
      setError(errorMessage);
      
      // Clear error message after 8 seconds
      setTimeout(() => setError(''), 8000);
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
      
      // Remove from selection if it was selected
      setSelectedUsers(prev => prev.filter(id => id !== deactivateConfirmation.userId));
      
      loadData();
      
      // Clear success message after 5 seconds
      setTimeout(() => setSuccess(''), 5000);
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to deactivate user';
      setError(errorMessage);
      
      // Clear error message after 8 seconds
      setTimeout(() => setError(''), 8000);
    }
  };

  const handleEditUser = (user: User) => {
    setSelectedUser(user);
    setEditForm({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email || '',
      mobileNumber: user.mobileNumber || '',
      primaryContactMethod: user.primaryContactMethod,
      role: user.role
    });
    setShowEditUserModal(true);
  };

  const handleSaveUserEdit = async () => {
    if (!selectedUser) return;

    try {
      setError('');
      
      // Validate form
      if (!editForm.firstName || !editForm.lastName) {
        const errorMsg = 'First name and last name are required';
        setError(errorMsg);
        return;
      }

      if (editForm.primaryContactMethod === 'email' && !editForm.email) {
        const errorMsg = 'Email is required when primary contact method is email';
        setError(errorMsg);
        return;
      }

      if (editForm.primaryContactMethod === 'sms' && !editForm.mobileNumber) {
        const errorMsg = 'Mobile number is required when primary contact method is SMS';
        setError(errorMsg);
        return;
      }

      if (!editForm.email && !editForm.mobileNumber) {
        const errorMsg = 'Either email or mobile number must be provided';
        setError(errorMsg);
        return;
      }

      // Prepare update data
      const updateData = {
        firstName: editForm.firstName,
        lastName: editForm.lastName,
        // send both fields; empty string will clear on server
        email: editForm.email,
        mobileNumber: editForm.mobileNumber,
        primaryContactMethod: editForm.primaryContactMethod,
        role: editForm.role
      };

      await usersAPI.update(selectedUser.id, updateData);
      
      setSuccess('User updated successfully');
      setShowEditUserModal(false);
      setSelectedUser(null);
      setEditForm({
        firstName: '',
        lastName: '',
        email: '',
        mobileNumber: '',
        primaryContactMethod: 'email',
        role: 'attendance_taker'
      });
      
      // Clear selection after successful edit
      setSelectedUsers([]);
      
      loadData();
      
      // Clear success message after 5 seconds
      setTimeout(() => setSuccess(''), 5000);
      
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to update user';
      setError(errorMessage);
      
      // Clear error message after 8 seconds
      setTimeout(() => setError(''), 8000);
      
      console.error('Failed to update user:', {
        error: errorMessage,
        formData: editForm,
        response: err.response?.data,
        status: err.response?.status
      });
    }
  };

  // Selection functions
  const toggleUserSelection = (userId: number) => {
    setSelectedUsers(prev => 
      prev.includes(userId) 
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const clearSelection = () => {
    setSelectedUsers([]);
  };

  const selectAllUsers = () => {
    setSelectedUsers(users.map(user => user.id));
  };

  const handleEditSelectedUser = () => {
    if (selectedUsers.length === 1) {
      const user = users.find(u => u.id === selectedUsers[0]);
      if (user) {
        handleEditUser(user);
      }
    }
  };

  const handleAssignSelectedUsers = () => {
    if (selectedUsers.length === 1) {
      const user = users.find(u => u.id === selectedUsers[0]);
      if (user) {
        handleAssignGatherings(user);
      }
    } else if (selectedUsers.length > 1) {
      // For multiple users, we'll need to implement a bulk assignment modal
      // For now, just show an error
      setError('Bulk gathering assignment not yet implemented');
      setTimeout(() => setError(''), 5000);
    }
  };

  const handleDeleteSelectedUsers = () => {
    if (selectedUsers.length === 1) {
      const user = users.find(u => u.id === selectedUsers[0]);
      if (user) {
        showDeactivateConfirmation(user.id, `${user.firstName} ${user.lastName}`);
      }
    } else if (selectedUsers.length > 1) {
      // For multiple users, we'll need to implement a bulk delete modal
      // For now, just show an error
      setError('Bulk user deletion not yet implemented');
      setTimeout(() => setError(''), 5000);
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

  const formatDateTime = (value?: string | null): string => {
    if (!value) return '—';
    const dt = new Date(value);
    if (isNaN(dt.getTime())) return '—';
    return dt.toLocaleString();
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
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg leading-6 font-medium text-gray-900">
              Users ({users.length})
            </h3>
            <div className="flex items-center space-x-3">
              {selectedUsers.length > 0 ? (
                <div className="flex items-center space-x-2 text-sm text-gray-600">
                  <span>{selectedUsers.length} selected</span>
                  <button
                    onClick={clearSelection}
                    className="text-primary-600 hover:text-primary-700"
                  >
                    Clear
                  </button>
                </div>
              ) : users.length > 0 && (
                <button
                  onClick={selectAllUsers}
                  className="text-sm text-primary-600 hover:text-primary-700"
                >
                  Select All
                </button>
              )}
            </div>
          </div>
          
          {/* Mobile Card Layout */}
          <div className="block md:hidden space-y-4">
            {users.map((user) => (
              <div 
                key={user.id} 
                className={`relative rounded-lg p-4 border cursor-pointer transition-colors ${
                  selectedUsers.includes(user.id)
                    ? 'border-primary-500 bg-primary-50'
                    : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                }`}
                onClick={() => toggleUserSelection(user.id)}
              >
                <div className="flex space-x-3">
                  {/* Checkbox Column */}
                  <div className="flex-shrink-0 pt-1">
                    <input
                      type="checkbox"
                      checked={selectedUsers.includes(user.id)}
                      onChange={() => toggleUserSelection(user.id)}
                      className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  
                  {/* User Info Column */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h4 className="text-base font-medium text-gray-900 truncate">
                        {user.firstName} {user.lastName}
                      </h4>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleBadgeColor(user.role)} flex-shrink-0 ml-2`}>
                        {user.role.replace('_', ' ')}
                      </span>
                    </div>
                    
                    <div className="text-sm text-gray-500 mt-1">
                      {user.primaryContactMethod === 'email' ? (
                        <div className="flex items-center">
                          <EnvelopeIcon className="h-4 w-4 mr-1" />
                          <span className="truncate">{user.email}</span>
                        </div>
                      ) : (
                        <div className="flex items-center">
                          <PhoneIcon className="h-4 w-4 mr-1" />
                          <span className="truncate">{user.mobileNumber}</span>
                        </div>
                      )}
                    </div>
                    
                    <div className="flex flex-wrap gap-2 mt-2">
                      {getStatusBadge(user)}
                    </div>
                    
                    <div className="text-sm text-gray-600 mt-2">
                      {user.gatheringCount} gathering{user.gatheringCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop Grid Layout */}
          <div className="hidden md:grid md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-6">
            {users.map((user) => (
              <div 
                key={user.id} 
                className={`border rounded-lg p-6 cursor-pointer transition-all ${
                  selectedUsers.includes(user.id)
                    ? 'border-primary-500 bg-primary-50 shadow-md'
                    : 'bg-white border-gray-200 hover:shadow-md'
                }`}
                onClick={() => toggleUserSelection(user.id)}
              >
                <div className="flex space-x-4">
                  {/* Checkbox Column */}
                  <div className="flex-shrink-0 pt-1">
                    <input
                      type="checkbox"
                      checked={selectedUsers.includes(user.id)}
                      onChange={() => toggleUserSelection(user.id)}
                      className="rounded border-gray-300 text-primary-600 focus:ring-primary-500 h-4 w-4"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  
                  {/* User Info Column */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between mb-3">
                      <h4 className="text-lg font-semibold text-gray-900 truncate">
                        {user.firstName} {user.lastName}
                      </h4>
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${getRoleBadgeColor(user.role)} flex-shrink-0 ml-3`}>
                        {user.role.replace('_', ' ')}
                      </span>
                    </div>
                    
                    <div className="space-y-3">
                      <div className="text-sm text-gray-700">
                        <div className="font-medium text-gray-900">Contact Information</div>
                        <div className="space-y-1 mt-1">
                          <div className="flex items-center text-sm text-gray-600">
                            <EnvelopeIcon className="h-4 w-4 mr-2 flex-shrink-0" />
                            <span className="truncate">{user.email || 'No email'}</span>
                          </div>
                          {user.mobileNumber && (
                            <div className="flex items-center text-sm text-gray-600">
                              <PhoneIcon className="h-4 w-4 mr-2 flex-shrink-0" />
                              <span className="truncate">{user.mobileNumber}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      
                      <div className="text-sm text-gray-700">
                        <div className="font-medium text-gray-900">Gathering Access</div>
                        <div className="flex items-center text-sm text-gray-600 mt-1">
                          <UserGroupIcon className="h-4 w-4 mr-2 flex-shrink-0" />
                          <span>{user.gatheringCount} gathering{user.gatheringCount !== 1 ? 's' : ''} assigned</span>
                        </div>
                      </div>
                      
                      <div className="text-sm text-gray-700">
                        <div className="font-medium text-gray-900">Account Status</div>
                        <div className="mt-1">
                          {getStatusBadge(user)}
                          <div className="text-xs text-gray-500 mt-1">
                            Last login: {formatDateTime(user.lastLoginAt as any)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Floating Action Buttons */}
      {selectedUsers.length > 0 ? (
        <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 flex flex-col space-y-2 z-[9999]">
          {/* Edit User Button - only for single selection */}
          {selectedUsers.length === 1 && (
            <div className="flex items-center justify-end space-x-3">
              <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
                Edit User
              </div>
              <button
                onClick={handleEditSelectedUser}
                className="w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
                title="Edit User"
              >
                <PencilIcon className="h-6 w-6" />
              </button>
            </div>
          )}
          
          {/* Assign to Gathering Button */}
          <div className="flex items-center justify-end space-x-3">
            <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
              {selectedUsers.length === 1 ? "Assign to Gathering" : "Assign to Gatherings"}
            </div>
            <button
              onClick={handleAssignSelectedUsers}
              className="w-14 h-14 bg-green-600 hover:bg-green-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
              title={selectedUsers.length === 1 ? "Assign to Gathering" : "Assign to Gatherings"}
            >
              <UserGroupIcon className="h-6 w-6" />
            </button>
          </div>
          
          {/* Delete User Button */}
          <div className="flex items-center justify-end space-x-3">
            <div className="bg-white px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 whitespace-nowrap">
              {selectedUsers.length === 1 ? "Delete User" : "Delete Users"}
            </div>
            <button
              onClick={handleDeleteSelectedUsers}
              className="w-14 h-14 bg-red-600 hover:bg-red-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200"
              title={selectedUsers.length === 1 ? "Delete User" : "Delete Users"}
            >
              <TrashIcon className="h-6 w-6" />
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowInviteModal(true)}
          className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 w-14 h-14 bg-primary-600 hover:bg-primary-700 text-white rounded-lg shadow-lg flex items-center justify-center transition-colors duration-200 z-[9999]"
          aria-label="Invite User"
        >
          <PlusIcon className="h-6 w-6" />
        </button>
      )}

      {/* Pending Invitations Section removed */}

      {/* Invite User Modal */}
      {showInviteModal ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Invite New User</h3>
              
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      First Name
                      <span className="text-red-500 ml-1">*</span>
                    </label>
                    <input
                      type="text"
                      value={inviteForm.firstName}
                      onChange={(e) => {
                        setInviteForm({ ...inviteForm, firstName: e.target.value });
                        // Clear validation error when user starts typing
                        if (validationErrors.firstName) {
                          setValidationErrors({ ...validationErrors, firstName: '' });
                        }
                      }}
                      placeholder="Enter first name"
                      className={`mt-1 block w-full rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 ${
                        validationErrors.firstName ? 'border-red-300' : 'border-gray-300'
                      }`}
                    />
                    {validationErrors.firstName && (
                      <p className="mt-1 text-sm text-red-600">{validationErrors.firstName}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Last Name
                      <span className="text-red-500 ml-1">*</span>
                    </label>
                    <input
                      type="text"
                      value={inviteForm.lastName}
                      onChange={(e) => {
                        setInviteForm({ ...inviteForm, lastName: e.target.value });
                        // Clear validation error when user starts typing
                        if (validationErrors.lastName) {
                          setValidationErrors({ ...validationErrors, lastName: '' });
                        }
                      }}
                      placeholder="Enter last name"
                      className={`mt-1 block w-full rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 ${
                        validationErrors.lastName ? 'border-red-300' : 'border-gray-300'
                      }`}
                    />
                    {validationErrors.lastName && (
                      <p className="mt-1 text-sm text-red-600">{validationErrors.lastName}</p>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Email Address
                    <span className="text-red-500 ml-1">*</span>
                  </label>
                  <input
                    type="email"
                    value={inviteForm.email}
                    onChange={(e) => {
                      setInviteForm({ ...inviteForm, email: e.target.value });
                      // Clear validation error when user starts typing
                      if (validationErrors.email) {
                        setValidationErrors({ ...validationErrors, email: '' });
                      }
                    }}
                    placeholder="Enter email address"
                    className={`mt-1 block w-full rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 ${
                      validationErrors.email ? 'border-red-300' : 'border-gray-300'
                    }`}
                  />
                  {validationErrors.email && (
                    <p className="mt-1 text-sm text-red-600">{validationErrors.email}</p>
                  )}
                  <p className="mt-1 text-sm text-gray-500">Required for login and notifications</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Mobile Number
                    <span className="text-gray-400 ml-1">(optional)</span>
                  </label>
                  <input
                    type="tel"
                    value={inviteForm.mobileNumber}
                    onChange={(e) => {
                      setInviteForm({ ...inviteForm, mobileNumber: e.target.value });
                      // Clear validation error when user starts typing
                      if (validationErrors.mobileNumber) {
                        setValidationErrors({ ...validationErrors, mobileNumber: '' });
                      }
                    }}
                    placeholder="e.g., 0412 345 678, +61 4 1234 5678, +61 (0) 478 622 814"
                    className={`mt-1 block w-full rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 ${
                      validationErrors.mobileNumber ? 'border-red-300' : 'border-gray-300'
                    }`}
                  />
                  {validationErrors.mobileNumber && (
                    <p className="mt-1 text-sm text-red-600">{validationErrors.mobileNumber}</p>
                  )}
                  <p className="mt-1 text-sm text-gray-500">Accepts any format: spaces, dashes, +61, leading zeros</p>
                </div>

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
                  <label className="block text-sm font-medium text-gray-700 mb-2">Assign to Gatherings (Optional)</label>
                  <div className="space-y-2 max-h-40 overflow-y-auto border border-gray-300 rounded-md p-3">
                    {gatherings.map((gathering) => (
                      <label key={gathering.id} className="flex items-center">
                        <input
                          type="checkbox"
                          checked={inviteForm.gatheringIds.includes(gathering.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setInviteForm({
                                ...inviteForm,
                                gatheringIds: [...inviteForm.gatheringIds, gathering.id]
                              });
                            } else {
                              setInviteForm({
                                ...inviteForm,
                                gatheringIds: inviteForm.gatheringIds.filter(id => id !== gathering.id)
                              });
                            }
                          }}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <span className="ml-2 text-sm text-gray-700">{gathering.name}</span>
                      </label>
                    ))}
                  </div>
                  {gatherings.length === 0 && (
                    <p className="mt-1 text-sm text-gray-500">No gatherings available</p>
                  )}
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
                  disabled={isSubmitting}
                  className={`px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white ${
                    isSubmitting 
                      ? 'bg-gray-400 cursor-not-allowed' 
                      : 'bg-primary-600 hover:bg-primary-700'
                  }`}
                >
                  {isSubmitting ? (
                    <div className="flex items-center">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Sending...
                    </div>
                  ) : (
                    'Send Invitation'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {/* User Details Modal */}
      {showUserDetails && selectedUser ? createPortal(
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
        </div>,
        document.body
      ) : null}

      {/* Assign Gatherings Modal */}
      {showAssignGatherings && selectedUser ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                Assign Gatherings - {selectedUser.firstName} {selectedUser.lastName}
              </h3>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Select Gatherings</label>
                  <div className="space-y-2 max-h-40 overflow-y-auto border border-gray-300 rounded-md p-3">
                    {availableGatherings.map((gathering) => (
                      <label key={gathering.id} className="flex items-center">
                        <input
                          type="checkbox"
                          checked={assignForm.gatheringIds.includes(gathering.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setAssignForm({
                                ...assignForm,
                                gatheringIds: [...assignForm.gatheringIds, gathering.id]
                              });
                            } else {
                              setAssignForm({
                                ...assignForm,
                                gatheringIds: assignForm.gatheringIds.filter(id => id !== gathering.id)
                              });
                            }
                          }}
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <span className="ml-2 text-sm text-gray-700">{gathering.name}</span>
                      </label>
                    ))}
                  </div>
                  {availableGatherings.length === 0 && (
                    <p className="mt-1 text-sm text-gray-500">No gatherings available</p>
                  )}
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
        </div>,
        document.body
      ) : null}

      {/* Edit User Modal */}
      {showEditUserModal && selectedUser ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Edit User - {selectedUser.firstName} {selectedUser.lastName}
                </h3>
                <button
                  onClick={() => {
                    setShowEditUserModal(false);
                    setSelectedUser(null);
                    setEditForm({
                      firstName: '',
                      lastName: '',
                      email: '',
                      mobileNumber: '',
                      primaryContactMethod: 'email',
                      role: 'attendance_taker'
                    });
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">First Name</label>
                    <input
                      type="text"
                      value={editForm.firstName}
                      onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Last Name</label>
                    <input
                      type="text"
                      value={editForm.lastName}
                      onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })}
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Primary Contact Method</label>
                  <select
                    value={editForm.primaryContactMethod}
                    onChange={(e) => setEditForm({ ...editForm, primaryContactMethod: e.target.value as 'email' | 'sms' })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Email (optional)</label>
                  <input
                    type="email"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Mobile Number (optional)</label>
                  <input
                    type="tel"
                    value={editForm.mobileNumber}
                    onChange={(e) => setEditForm({ ...editForm, mobileNumber: e.target.value })}
                    placeholder="e.g., 0412 345 678, +61 4 1234 5678, +61 (0) 478 622 814"
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  />
                  <p className="mt-1 text-sm text-gray-500">Accepts any format: spaces, dashes, +61, leading zeros</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Role</label>
                  <select
                    value={editForm.role}
                    onChange={(e) => setEditForm({ ...editForm, role: e.target.value as 'admin' | 'coordinator' | 'attendance_taker' })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="attendance_taker">Attendance Taker</option>
                    <option value="coordinator">Coordinator</option>
                    {currentUser?.role === 'admin' && (
                      <option value="admin">Admin</option>
                    )}
                  </select>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row justify-between sm:items-center mt-6 space-y-2 sm:space-y-0">
                <div>
                  {currentUser?.role === 'admin' && (
                    <button
                      onClick={() => selectedUser && showDeactivateConfirmation(selectedUser.id, `${selectedUser.firstName} ${selectedUser.lastName}`)}
                      className="inline-flex items-center px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-red-600 hover:bg-red-700"
                    >
                      <TrashIcon className="h-4 w-4 mr-2" />
                      Deactivate User
                    </button>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row justify-end space-y-2 sm:space-y-0 sm:space-x-3">
                <button
                  onClick={() => {
                    setShowEditUserModal(false);
                    setSelectedUser(null);
                    setEditForm({
                      firstName: '',
                      lastName: '',
                      email: '',
                      mobileNumber: '',
                      primaryContactMethod: 'email',
                      role: 'attendance_taker'
                    });
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveUserEdit}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700"
                >
                  Save Changes
                </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {/* Cancel Invitation Confirmation Modal removed */}

      {/* Invite User Confirmation Modal */}
      {showInviteConfirmation ? createPortal(
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">
                  Confirm Invitation
                </h3>
                <button
                  onClick={() => setShowInviteConfirmation(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-blue-100 rounded-full">
                <EnvelopeIcon className="h-6 w-6 text-blue-600" />
              </div>
              
              <div className="text-center mb-6">
                <p className="text-sm text-gray-500 mb-2">
                  You are about to invite <strong>{inviteForm.firstName} {inviteForm.lastName}</strong> to join your organization.
                </p>
                <p className="text-sm text-gray-500">
                  They will receive an invitation email and can log in using their email address with a one-time code.
                </p>
              </div>
              
              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <h4 className="text-sm font-medium text-gray-700 mb-2">Invitation Details:</h4>
                <div className="space-y-1 text-sm text-gray-600">
                  <div><strong>Name:</strong> {inviteForm.firstName} {inviteForm.lastName}</div>
                  <div><strong>Email:</strong> {inviteForm.email}</div>
                  {inviteForm.mobileNumber && <div><strong>Mobile:</strong> {inviteForm.mobileNumber}</div>}
                  <div><strong>Role:</strong> {inviteForm.role.replace('_', ' ')}</div>
                  {inviteForm.gatheringIds.length > 0 && (
                    <div><strong>Gatherings:</strong> {inviteForm.gatheringIds.length} assigned</div>
                  )}
                </div>
              </div>
              
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowInviteConfirmation(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmInvitation}
                  disabled={isSubmitting}
                  className={`flex-1 px-4 py-2 text-sm font-medium text-white border border-transparent rounded-md ${
                    isSubmitting 
                      ? 'bg-gray-400 cursor-not-allowed' 
                      : 'bg-primary-600 hover:bg-primary-700'
                  }`}
                >
                  {isSubmitting ? 'Sending...' : 'Send Invitation'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {/* Deactivate User Confirmation Modal */}
      {showDeactivateModal ? createPortal(
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
        </div>,
        document.body
      ) : null}
    </div>
  );
};

export default UsersPage; 