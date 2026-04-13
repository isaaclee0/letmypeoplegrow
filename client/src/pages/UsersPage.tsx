import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../contexts/AuthContext';
import { usersAPI, gatheringsAPI, contactsAPI } from '../services/api';
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

interface Contact {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  mobile_number: string | null;
  primary_contact_method: 'email' | 'sms';
  notes: string | null;
  is_active: number;
  family_count: number;
}

interface ContactFormData {
  first_name: string;
  last_name: string;
  email: string;
  mobile_number: string;
  primary_contact_method: 'email' | 'sms';
  notes: string;
}

function ContactModal({
  contact,
  onSave,
  onClose,
}: {
  contact: Contact | null;
  onSave: (data: ContactFormData) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ContactFormData>({
    first_name: contact?.first_name || '',
    last_name: contact?.last_name || '',
    email: contact?.email || '',
    mobile_number: contact?.mobile_number || '',
    primary_contact_method: contact?.primary_contact_method || 'email',
    notes: contact?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.email && !form.mobile_number) {
      setError('At least one of email or mobile number is required');
      return;
    }
    setSaving(true);
    try {
      await onSave(form);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full p-6">
        <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-gray-100">
          {contact ? 'Edit Contact' : 'Add Contact'}
        </h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">First name *</label>
              <input
                className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                value={form.first_name}
                onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Last name *</label>
              <input
                className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                value={form.last_name}
                onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
            <input
              type="email"
              className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Mobile number</label>
            <input
              type="tel"
              className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              value={form.mobile_number}
              onChange={e => setForm(f => ({ ...f, mobile_number: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Preferred contact method</label>
            <select
              className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              value={form.primary_contact_method}
              onChange={e => setForm(f => ({ ...f, primary_contact_method: e.target.value as 'email' | 'sms' }))}
            >
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
            <textarea
              className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              rows={2}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            />
          </div>
          {error && <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
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
  const [bulkAssignUsers, setBulkAssignUsers] = useState<User[]>([]);
  // Per-gathering override for bulk: true = add to all, false = remove from all, undefined = leave unchanged
  const [bulkGatheringOverrides, setBulkGatheringOverrides] = useState<Record<number, boolean | undefined>>({});
  const [bulkUserAssignments, setBulkUserAssignments] = useState<Map<number, Set<number>>>(new Map());

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
  const [showBulkDeactivateModal, setShowBulkDeactivateModal] = useState(false);
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

  // Tab state
  const [activeTab, setActiveTab] = useState<'users' | 'contacts'>('users');

  // Contacts state
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [showContactModal, setShowContactModal] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [convertingContact, setConvertingContact] = useState<Contact | null>(null);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [convertRole, setConvertRole] = useState<'coordinator' | 'attendance_taker'>('attendance_taker');

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (activeTab === 'contacts') {
      loadContacts();
    }
  }, [activeTab]);

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

  // Contacts handlers
  const loadContacts = async () => {
    setContactsLoading(true);
    try {
      const data = await contactsAPI.getAll();
      setContacts(data);
    } catch (err) {
      console.error('Failed to load contacts', err);
    } finally {
      setContactsLoading(false);
    }
  };

  const handleSaveContact = async (data: ContactFormData) => {
    if (editingContact) {
      const updated = await contactsAPI.update(editingContact.id, data);
      setContacts(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c));
    } else {
      const created = await contactsAPI.create(data);
      setContacts(prev => [...prev, { ...created, family_count: 0 }]);
    }
    setShowContactModal(false);
    setEditingContact(null);
  };

  const handleDeactivateContact = async (contact: Contact) => {
    if (!confirm(`Deactivate ${contact.first_name} ${contact.last_name}?`)) return;
    try {
      await contactsAPI.delete(contact.id);
      setContacts(prev => prev.filter(c => c.id !== contact.id));
    } catch (err) {
      setError('Failed to deactivate contact');
      setTimeout(() => setError(''), 5000);
    }
  };

  const handleConvertToUser = async () => {
    if (!convertingContact) return;
    try {
      await contactsAPI.convertToUser(convertingContact.id, convertRole);
      setContacts(prev => prev.filter(c => c.id !== convertingContact.id));
      setShowConvertModal(false);
      setConvertingContact(null);
      setActiveTab('users');
      loadData();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to convert contact');
      setTimeout(() => setError(''), 5000);
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

  const handleSaveBulkAssignments = async () => {
    try {
      await Promise.all(
        bulkAssignUsers.map(async (user) => {
          const currentIds = bulkUserAssignments.get(user.id) || new Set<number>();
          const finalIds = new Set(currentIds);
          Object.entries(bulkGatheringOverrides).forEach(([gId, override]) => {
            const gatheringId = Number(gId);
            if (override === true) finalIds.add(gatheringId);
            else if (override === false) finalIds.delete(gatheringId);
          });
          await usersAPI.assignGatherings(user.id, Array.from(finalIds));
        })
      );
      setSuccess(`Gathering assignments updated for ${bulkAssignUsers.length} user${bulkAssignUsers.length === 1 ? '' : 's'}`);
      setShowAssignGatherings(false);
      setBulkAssignUsers([]);
      setBulkGatheringOverrides({});
      setBulkUserAssignments(new Map());
      setSelectedUsers([]);
      loadData();
      setTimeout(() => setSuccess(''), 5000);
    } catch (err: any) {
      const errorMessage = err.response?.data?.error || 'Failed to update assignments';
      setError(errorMessage);
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

  const handleAssignSelectedUsers = async () => {
    if (selectedUsers.length === 1) {
      const user = users.find(u => u.id === selectedUsers[0]);
      if (user) {
        handleAssignGatherings(user);
      }
    } else if (selectedUsers.length > 1) {
      try {
        const selected = users.filter(u => selectedUsers.includes(u.id));
        setBulkAssignUsers(selected);
        const responses = await Promise.all(selected.map(u => usersAPI.getGatheringAssignments(u.id)));
        const assignmentMap = new Map<number, Set<number>>();
        let available: GatheringType[] = [];
        responses.forEach((resp, i) => {
          assignmentMap.set(selected[i].id, new Set((resp.data.currentAssignments || []).map((g: any) => g.id)));
          available = resp.data.availableGatherings || [];
        });
        setBulkUserAssignments(assignmentMap);
        setAvailableGatherings(available);
        setBulkGatheringOverrides({});
        setShowAssignGatherings(true);
      } catch (err: any) {
        setError(err.response?.data?.error || 'Failed to load gathering assignments');
        setTimeout(() => setError(''), 5000);
      }
    }
  };

  const handleDeleteSelectedUsers = () => {
    if (selectedUsers.length === 1) {
      const user = users.find(u => u.id === selectedUsers[0]);
      if (user) {
        showDeactivateConfirmation(user.id, `${user.firstName} ${user.lastName}`);
      }
    } else if (selectedUsers.length > 1) {
      setShowBulkDeactivateModal(true);
    }
  };

  const handleBulkDeleteUsers = async () => {
    const toDelete = [...selectedUsers];
    let failed = 0;
    for (const userId of toDelete) {
      try {
        await usersAPI.delete(userId);
      } catch {
        failed++;
      }
    }
    setShowBulkDeactivateModal(false);
    clearSelection();
    loadData();
    if (failed > 0) {
      setError(`Failed to deactivate ${failed} user(s)`);
      setTimeout(() => setError(''), 8000);
    } else {
      setSuccess(`${toDelete.length} users deactivated successfully`);
      setTimeout(() => setSuccess(''), 5000);
    }
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'admin':
        return 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300';
      case 'coordinator':
        return 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300';
      case 'attendance_taker':
        return 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300';
      default:
        return 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300';
    }
  };

  const getStatusBadge = (user: User) => {
    if (!user.isActive) {
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300">Inactive</span>;
    }
    if (!user.firstLoginCompleted) {
      return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300">Pending Setup</span>;
    }
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300">Active</span>;
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
    <div className="space-y-6 pb-32">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 overflow-hidden shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                Manage Users
              </h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Manage users, send invitations, and assign gathering access
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4">
          <div className="flex">
            <XMarkIcon className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
            </div>
          </div>
        </div>
      )}

      {success && (
        <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-md p-4">
          <div className="flex">
            <CheckIcon className="h-5 w-5 text-green-400" />
            <div className="ml-3">
              <p className="text-sm text-green-700 dark:text-green-400">{success}</p>
            </div>
          </div>
        </div>
      )}

      {/* Tab switcher */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('users')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            activeTab === 'users'
              ? 'border-primary-500 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
        >
          Users
        </button>
        <button
          onClick={() => setActiveTab('contacts')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ml-4 ${
            activeTab === 'contacts'
              ? 'border-primary-500 text-primary-600 dark:text-primary-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
        >
          Contacts
        </button>
      </div>

      {activeTab === 'contacts' && (
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Contacts</h2>
              <button
                onClick={() => { setEditingContact(null); setShowContactModal(true); }}
                className="px-4 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700"
              >
                Add Contact
              </button>
            </div>

            {contactsLoading ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm">Loading...</p>
            ) : contacts.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400 text-sm">No contacts yet. Add one to get started.</p>
            ) : (
              <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 rounded-lg">
                <table className="min-w-full divide-y divide-gray-300 dark:divide-gray-600">
                  <thead className="bg-gray-50 dark:bg-gray-700">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Name</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Contact</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Families</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-800">
                    {contacts.map(contact => (
                      <tr key={contact.id}>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                          {contact.first_name} {contact.last_name}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                          {contact.primary_contact_method === 'email' ? contact.email : contact.mobile_number}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                          {contact.family_count} {contact.family_count === 1 ? 'family' : 'families'}
                        </td>
                        <td className="px-4 py-3 text-sm text-right space-x-3">
                          <button
                            onClick={() => { setEditingContact(contact); setShowContactModal(true); }}
                            className="text-gray-500 dark:text-gray-400 hover:text-primary-600 dark:hover:text-primary-400"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => { setConvertingContact(contact); setShowConvertModal(true); }}
                            className="text-gray-500 dark:text-gray-400 hover:text-primary-600 dark:hover:text-primary-400"
                          >
                            Convert to user
                          </button>
                          <button
                            onClick={() => handleDeactivateContact(contact)}
                            className="text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                          >
                            Deactivate
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Users Section */}
      {activeTab === 'users' && <div className="bg-white dark:bg-gray-800 shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg leading-6 font-medium text-gray-900 dark:text-gray-100">
              Users ({users.length})
            </h3>
            <div className="flex items-center space-x-3">
              {selectedUsers.length > 0 ? (
                <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-400">
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
                    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30'
                    : 'bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600'
                }`}
                onClick={() => toggleUserSelection(user.id)}
              >
                <div className="flex space-x-3">
                  {/* Checkbox Column */}
                  <div className="shrink-0 pt-1">
                    <input
                      type="checkbox"
                      checked={selectedUsers.includes(user.id)}
                      onChange={() => toggleUserSelection(user.id)}
                      className="rounded border-gray-300 dark:border-gray-500 text-primary-600 focus:ring-primary-500"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  
                  {/* User Info Column */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h4 className="text-base font-medium text-gray-900 dark:text-gray-100 truncate">
                        {user.firstName} {user.lastName}
                      </h4>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleBadgeColor(user.role)} shrink-0 ml-2`}>
                        {user.role.replace('_', ' ')}
                      </span>
                    </div>
                    
                    <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
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
                    
                    <div className="text-sm text-gray-600 dark:text-gray-400 mt-2">
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
                    ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30 shadow-md'
                    : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:shadow-md'
                }`}
                onClick={() => toggleUserSelection(user.id)}
              >
                <div className="flex space-x-4">
                  {/* Checkbox Column */}
                  <div className="shrink-0 pt-1">
                    <input
                      type="checkbox"
                      checked={selectedUsers.includes(user.id)}
                      onChange={() => toggleUserSelection(user.id)}
                      className="rounded border-gray-300 dark:border-gray-500 text-primary-600 focus:ring-primary-500 h-4 w-4"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  
                  {/* User Info Column */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between mb-3">
                      <h4 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
                        {user.firstName} {user.lastName}
                      </h4>
                      <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${getRoleBadgeColor(user.role)} shrink-0 ml-3`}>
                        {user.role.replace('_', ' ')}
                      </span>
                    </div>
                    
                    <div className="space-y-3">
                      <div className="text-sm text-gray-700 dark:text-gray-300">
                        <div className="font-medium text-gray-900 dark:text-gray-100">Contact Information</div>
                        <div className="space-y-1 mt-1">
                          <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                            <EnvelopeIcon className="h-4 w-4 mr-2 shrink-0" />
                            <span className="truncate">{user.email || 'No email'}</span>
                          </div>
                          {user.mobileNumber && (
                            <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                              <PhoneIcon className="h-4 w-4 mr-2 shrink-0" />
                              <span className="truncate">{user.mobileNumber}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      
                      <div className="text-sm text-gray-700 dark:text-gray-300">
                        <div className="font-medium text-gray-900 dark:text-gray-100">Gathering Access</div>
                        <div className="flex items-center text-sm text-gray-600 dark:text-gray-400 mt-1">
                          <UserGroupIcon className="h-4 w-4 mr-2 shrink-0" />
                          <span>{user.gatheringCount} gathering{user.gatheringCount !== 1 ? 's' : ''} assigned</span>
                        </div>
                      </div>
                      
                      <div className="text-sm text-gray-700 dark:text-gray-300">
                        <div className="font-medium text-gray-900 dark:text-gray-100">Account Status</div>
                        <div className="mt-1">
                          {getStatusBadge(user)}
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
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
      </div>}

      {/* Floating Action Buttons */}
      {selectedUsers.length > 0 ? (
        <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 flex flex-col space-y-2 z-[9999]">
          {/* Edit User Button - only for single selection */}
          {selectedUsers.length === 1 && (
            <div className="flex items-center justify-end space-x-3">
              <div className="bg-white dark:bg-gray-700 px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
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
            <div className="bg-white dark:bg-gray-700 px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
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
            <div className="bg-white dark:bg-gray-700 px-3 py-2 rounded-lg shadow-lg text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
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
        <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white dark:bg-gray-800">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">Invite New User</h3>
              
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
                      className={`mt-1 block w-full rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-gray-100 ${
                        validationErrors.firstName ? 'border-red-300 dark:border-red-600' : 'border-gray-300 dark:border-gray-600'
                      }`}
                    />
                    {validationErrors.firstName && (
                      <p className="mt-1 text-sm text-red-600 dark:text-red-400">{validationErrors.firstName}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
                      className={`mt-1 block w-full rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 dark:bg-gray-700 dark:text-gray-100 ${
                        validationErrors.lastName ? 'border-red-300 dark:border-red-600' : 'border-gray-300 dark:border-gray-600'
                      }`}
                    />
                    {validationErrors.lastName && (
                      <p className="mt-1 text-sm text-red-600 dark:text-red-400">{validationErrors.lastName}</p>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
                      validationErrors.email ? 'border-red-300 dark:border-red-600' : 'border-gray-300 dark:border-gray-600'
                    }`}
                  />
                  {validationErrors.email && (
                    <p className="mt-1 text-sm text-red-600 dark:text-red-400">{validationErrors.email}</p>
                  )}
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Required for login and notifications</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
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
                      validationErrors.mobileNumber ? 'border-red-300 dark:border-red-600' : 'border-gray-300 dark:border-gray-600'
                    }`}
                  />
                  {validationErrors.mobileNumber && (
                    <p className="mt-1 text-sm text-red-600 dark:text-red-400">{validationErrors.mobileNumber}</p>
                  )}
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Accepts any format: spaces, dashes, +61, leading zeros</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Role</label>
                  <select
                    value={inviteForm.role}
                    onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value as 'coordinator' | 'attendance_taker' })}
                    className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="attendance_taker">Attendance Taker</option>
                    <option value="coordinator">Coordinator</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Assign to Gatherings (Optional)</label>
                  <div className="space-y-2 max-h-40 overflow-y-auto border border-gray-300 dark:border-gray-600 rounded-md p-3">
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
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">{gathering.name}</span>
                      </label>
                    ))}
                  </div>
                  {gatherings.length === 0 && (
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">No gatherings available</p>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row justify-end space-y-2 sm:space-y-0 sm:space-x-3 mt-6">
                <button
                  onClick={() => setShowInviteModal(false)}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
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
        <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white dark:bg-gray-800">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">User Details</h3>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Name</label>
                  <p className="mt-1 text-sm text-gray-900 dark:text-gray-100">{selectedUser.firstName} {selectedUser.lastName}</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Contact</label>
                  <p className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                    {selectedUser.primaryContactMethod === 'email' ? selectedUser.email : selectedUser.mobileNumber}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Role</label>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getRoleBadgeColor(selectedUser.role)}`}>
                    {selectedUser.role.replace('_', ' ')}
                  </span>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Status</label>
                  <div className="mt-1">{getStatusBadge(selectedUser)}</div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Gathering Assignments</label>
                  <div className="mt-1">
                    {userAssignments.length > 0 ? (
                      <ul className="text-sm text-gray-900 dark:text-gray-100">
                        {userAssignments.map((gathering) => (
                          <li key={gathering.id} className="py-1">
                            {gathering.name}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-gray-500 dark:text-gray-400">No gatherings assigned</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-end mt-6">
                <button
                  onClick={() => setShowUserDetails(false)}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
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
      {showAssignGatherings && (selectedUser || bulkAssignUsers.length > 0) ? createPortal(
        <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white dark:bg-gray-800">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                {bulkAssignUsers.length > 0
                  ? `Assign Gatherings (${bulkAssignUsers.length} users selected)`
                  : `Assign Gatherings - ${selectedUser?.firstName} ${selectedUser?.lastName}`}
              </h3>
              {bulkAssignUsers.length > 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                  Checking a gathering will add it to all selected users. Unchecking will remove it. A dash (—) means only some users are assigned — leave it to keep each user's current assignment.
                </p>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Select Gatherings</label>
                  <div className="space-y-2 max-h-40 overflow-y-auto border border-gray-300 dark:border-gray-600 rounded-md p-3">
                    {availableGatherings.map((gathering) => {
                      if (bulkAssignUsers.length > 0) {
                        // Bulk mode: tri-state checkboxes
                        const countAssigned = bulkAssignUsers.filter(u =>
                          bulkUserAssignments.get(u.id)?.has(gathering.id)
                        ).length;
                        const override = bulkGatheringOverrides[gathering.id];
                        const isChecked = override === true || (override === undefined && countAssigned === bulkAssignUsers.length);
                        const isIndeterminate = override === undefined && countAssigned > 0 && countAssigned < bulkAssignUsers.length;
                        return (
                          <label key={gathering.id} className="flex items-center">
                            <input
                              type="checkbox"
                              ref={(el) => { if (el) el.indeterminate = isIndeterminate; }}
                              checked={isChecked}
                              onChange={() => {
                                setBulkGatheringOverrides(prev => ({
                                  ...prev,
                                  [gathering.id]: isChecked ? false : true
                                }));
                              }}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                            />
                            <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">{gathering.name}</span>
                            {isIndeterminate && (
                              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">({countAssigned}/{bulkAssignUsers.length})</span>
                            )}
                          </label>
                        );
                      } else {
                        // Single-user mode
                        return (
                          <label key={gathering.id} className="flex items-center">
                            <input
                              type="checkbox"
                              checked={assignForm.gatheringIds.includes(gathering.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setAssignForm({ ...assignForm, gatheringIds: [...assignForm.gatheringIds, gathering.id] });
                                } else {
                                  setAssignForm({ ...assignForm, gatheringIds: assignForm.gatheringIds.filter(id => id !== gathering.id) });
                                }
                              }}
                              className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-gray-500 rounded"
                            />
                            <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">{gathering.name}</span>
                          </label>
                        );
                      }
                    })}
                  </div>
                  {availableGatherings.length === 0 && (
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">No gatherings available</p>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row justify-end space-y-2 sm:space-y-0 sm:space-x-3 mt-6">
                <button
                  onClick={() => {
                    setShowAssignGatherings(false);
                    setBulkAssignUsers([]);
                    setBulkGatheringOverrides({});
                    setBulkUserAssignments(new Map());
                  }}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                >
                  Cancel
                </button>
                <button
                  onClick={bulkAssignUsers.length > 0 ? handleSaveBulkAssignments : handleSaveAssignments}
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
        <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-md shadow-lg rounded-md bg-white dark:bg-gray-800">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
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
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">First Name</label>
                    <input
                      type="text"
                      value={editForm.firstName}
                      onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })}
                      className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Last Name</label>
                    <input
                      type="text"
                      value={editForm.lastName}
                      onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })}
                      className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Primary Contact Method</label>
                  <select
                    value={editForm.primaryContactMethod}
                    onChange={(e) => setEditForm({ ...editForm, primaryContactMethod: e.target.value as 'email' | 'sms' })}
                    className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email (optional)</label>
                  <input
                    type="email"
                    value={editForm.email}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                    className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Mobile Number (optional)</label>
                  <input
                    type="tel"
                    value={editForm.mobileNumber}
                    onChange={(e) => setEditForm({ ...editForm, mobileNumber: e.target.value })}
                    placeholder="e.g., 0412 345 678, +61 4 1234 5678, +61 (0) 478 622 814"
                    className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  />
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Accepts any format: spaces, dashes, +61, leading zeros</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Role</label>
                  <select
                    value={editForm.role}
                    onChange={(e) => setEditForm({ ...editForm, role: e.target.value as 'admin' | 'coordinator' | 'attendance_taker' })}
                    className="mt-1 block w-full border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
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
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
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
        <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white dark:bg-gray-800">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Confirm Invitation
                </h3>
                <button
                  onClick={() => setShowInviteConfirmation(false)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-blue-100 dark:bg-blue-900/30 rounded-full">
                <EnvelopeIcon className="h-6 w-6 text-blue-600" />
              </div>
              
              <div className="text-center mb-6">
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                  You are about to invite <strong>{inviteForm.firstName} {inviteForm.lastName}</strong> to join your organization.
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  They will receive an invitation email and can log in using their email address with a one-time code.
                </p>
              </div>
              
              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 mb-6">
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Invitation Details:</h4>
                <div className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
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
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
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
        <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white dark:bg-gray-800">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Confirm Deactivation
                </h3>
                <button
                  onClick={() => setShowDeactivateModal(false)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>
              
              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 dark:bg-red-900/30 rounded-full">
                <TrashIcon className="h-6 w-6 text-red-600" />
              </div>
              
              <div className="text-center mb-6">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Are you sure you want to deactivate <strong>{deactivateConfirmation.userName}</strong>? This action cannot be undone.
                </p>
              </div>
              
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowDeactivateModal(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
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

      {/* Bulk Deactivate Users Confirmation Modal */}
      {showBulkDeactivateModal ? createPortal(
        <div className="fixed inset-0 bg-gray-600/50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white dark:bg-gray-800">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  Confirm Deactivation
                </h3>
                <button
                  onClick={() => setShowBulkDeactivateModal(false)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </div>

              <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-red-100 dark:bg-red-900/30 rounded-full">
                <TrashIcon className="h-6 w-6 text-red-600" />
              </div>

              <div className="mb-4 text-center">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Are you sure you want to deactivate the following {selectedUsers.length} users? This action cannot be undone.
                </p>
              </div>

              <ul className="mb-5 text-sm text-gray-700 dark:text-gray-300 max-h-40 overflow-y-auto list-disc list-inside border border-gray-200 dark:border-gray-600 rounded p-2">
                {selectedUsers.map(id => {
                  const u = users.find(u => u.id === id);
                  return u ? <li key={id}>{u.firstName} {u.lastName}</li> : null;
                })}
              </ul>

              <div className="flex space-x-3">
                <button
                  onClick={() => setShowBulkDeactivateModal(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-600"
                >
                  Cancel
                </button>
                <button
                  onClick={handleBulkDeleteUsers}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
                >
                  Deactivate {selectedUsers.length} Users
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      ) : null}

      {/* Contact Add/Edit Modal */}
      {showContactModal && (
        <ContactModal
          contact={editingContact}
          onSave={handleSaveContact}
          onClose={() => { setShowContactModal(false); setEditingContact(null); }}
        />
      )}

      {/* Convert Contact to User Modal */}
      {showConvertModal && convertingContact && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-sm w-full p-6">
            <h3 className="text-lg font-semibold mb-2 text-gray-900 dark:text-gray-100">Convert to User</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              {convertingContact.first_name} {convertingContact.last_name} will become an app user.
              Their family caregiver assignments will be preserved. An invitation email will be sent to{' '}
              <strong>{convertingContact.email}</strong>.
            </p>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Role</label>
              <select
                className="w-full border border-gray-300 dark:border-gray-600 rounded-md px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                value={convertRole}
                onChange={e => setConvertRole(e.target.value as 'coordinator' | 'attendance_taker')}
              >
                <option value="attendance_taker">Attendance Taker</option>
                <option value="coordinator">Coordinator</option>
              </select>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setShowConvertModal(false); setConvertingContact(null); }}
                className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={handleConvertToUser}
                className="px-4 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700"
              >
                Convert &amp; Invite
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UsersPage; 