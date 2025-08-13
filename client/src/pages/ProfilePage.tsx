import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { usersAPI } from '../services/api';

const ProfilePage: React.FC = () => {
  const { user, updateUser } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [primaryContactMethod, setPrimaryContactMethod] = useState<'email' | 'sms'>('email');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      setFirstName(user.firstName || '');
      setLastName(user.lastName || '');
      setEmail(user.email || '');
      setMobileNumber(user.mobileNumber || '');
      setPrimaryContactMethod(user.primaryContactMethod);
    }
  }, [user]);

  const handleSave = async () => {
    if (!user) return;
    setError('');
    setSuccess('');

    if (!firstName || !lastName) {
      setError('First name and last name are required');
      return;
    }
    if (primaryContactMethod === 'email' && !email) {
      setError('Email is required when primary contact method is email');
      return;
    }
    if (primaryContactMethod === 'sms' && !mobileNumber) {
      setError('Mobile number is required when primary contact method is SMS');
      return;
    }
    if (!email && !mobileNumber) {
      setError('Provide at least an email or a mobile number');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        firstName,
        lastName,
        email: email === '' ? null : email,
        mobileNumber: mobileNumber === '' ? null : mobileNumber,
        primaryContactMethod,
      };
      await usersAPI.updateMe(payload);
      updateUser({
        firstName,
        lastName,
        email: email || undefined,
        mobileNumber: mobileNumber || undefined,
        primaryContactMethod,
      });
      setSuccess('Profile updated');
    } catch (err: any) {
      const serverErrors = err.response?.data?.errors;
      const message = err.response?.data?.error || (Array.isArray(serverErrors) && serverErrors[0]?.msg) || 'Failed to update profile';
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">My Profile</h1>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="mb-4 rounded-md bg-green-50 p-3 text-sm text-green-700">{success}</div>
      )}

      <div className="bg-white shadow rounded-lg p-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">First Name</label>
            <input className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={firstName} onChange={e => setFirstName(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Last Name</label>
            <input className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={lastName} onChange={e => setLastName(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Primary Contact Method</label>
          <select className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={primaryContactMethod} onChange={e => setPrimaryContactMethod(e.target.value as 'email' | 'sms')}>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Email (optional)</label>
          <input type="email" className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={email} onChange={e => setEmail(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Mobile Number (optional)</label>
          <input type="tel" className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500" value={mobileNumber} onChange={e => setMobileNumber(e.target.value)} />
        </div>

        <div className="flex justify-end">
          <button disabled={saving} onClick={handleSave} className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-60">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;


