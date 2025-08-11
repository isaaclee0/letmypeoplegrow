import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { authAPI, onboardingAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { CheckIcon } from '@heroicons/react/24/outline';

interface SetupForm {
  churchName: string;
  adminEmail: string;
}

const OnboardingPage: React.FC = () => {
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [churchName, setChurchName] = useState('');
  const { login, refreshOnboardingStatus, updateUser, user } = useAuth();
  const navigate = useNavigate();
  
  const setupForm = useForm<SetupForm>();
  const codeForm = useForm<{ code: string }>();

  const handleSetupSubmit = async (data: SetupForm) => {
    setIsLoading(true);
    setError('');
    try {
      // Send verification code to admin email
      await authAPI.requestCode(data.adminEmail);
      setAdminEmail(data.adminEmail);
      setChurchName(data.churchName);
      setStep('code');
      codeForm.reset();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to send verification code');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCodeSubmit = async (data: { code: string }) => {
    setIsLoading(true);
    setError('');
    try {
      // Verify code and login
      const verifyResponse = await authAPI.verifyCode(adminEmail, data.code);
      await login(verifyResponse.data.token, verifyResponse.data.user);

      // Save minimal church info with sensible defaults
      await onboardingAPI.saveChurchInfo({
        churchName,
        countryCode: 'AU',
        timezone: 'Australia/Sydney',
        emailFromName: 'Let My People Grow',
        emailFromAddress: 'noreply@letmypeoplegrow.com.au',
      });

      // Mark onboarding complete so we can go straight to gatherings
      await onboardingAPI.complete();
      await refreshOnboardingStatus();
      if (user) {
        updateUser({ ...user, isFirstLogin: false });
      }
      
      navigate('/app/gatherings');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to verify code');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-secondary-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-10">
          <div className="mx-auto h-16 w-16 mb-6 flex items-center justify-center">
            <img className="h-16 w-auto" src="/logo.png" alt="Let My People Grow" />
          </div>
          <h1 className="text-3xl font-bold text-primary-700 mb-2 font-title">
            Create your church account
          </h1>
          <p className="text-sm text-primary-600">Just two quick steps to get started</p>
        </div>

        {error && (
          <div className="mb-6 rounded-md bg-red-50 p-4">
            <div className="text-sm text-red-700">{error}</div>
          </div>
        )}

        <div className="bg-white shadow rounded-lg p-6">
          {step === 'form' ? (
            <form className="space-y-6" onSubmit={setupForm.handleSubmit(handleSetupSubmit)}>
                <div>
                  <label htmlFor="churchName" className="block text-sm font-medium text-gray-700">
                  Church name
                  </label>
                  <input
                  {...setupForm.register('churchName', { required: 'Church name is required' })}
                    type="text"
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  placeholder="e.g. Sunday Community Church"
                  />
                {setupForm.formState.errors.churchName && (
                  <p className="mt-1 text-sm text-red-600">{setupForm.formState.errors.churchName.message}</p>
                  )}
                </div>

                <div>
                <label htmlFor="adminEmail" className="block text-sm font-medium text-gray-700">
                  Your email address
                    </label>
                    <input
                  {...setupForm.register('adminEmail', {
                    required: 'Email is required',
                    pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email' },
                  })}
                      type="email"
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  placeholder="you@example.com"
                    />
                {setupForm.formState.errors.adminEmail && (
                  <p className="mt-1 text-sm text-red-600">{setupForm.formState.errors.adminEmail.message}</p>
                )}
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                  >
                  {isLoading ? 'Sending code...' : 'Create and send code'}
                  </button>
                </div>
              </form>
          ) : (
            <form className="space-y-6" onSubmit={codeForm.handleSubmit(handleCodeSubmit)}>
            <div>
                <label htmlFor="code" className="block text-sm font-medium text-gray-700">
                  Enter verification code
                      </label>
                      <input
                  {...codeForm.register('code', {
                    required: 'Verification code is required',
                    pattern: { value: /^\d{6}$/, message: 'Code must be 6 digits' },
                  })}
                        type="text"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="one-time-code"
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-center tracking-widest text-lg"
                  placeholder="000000"
                />
                <p className="mt-1 text-xs text-gray-500 text-center">Sent to {adminEmail}</p>
                {codeForm.formState.errors.code && (
                  <p className="mt-1 text-sm text-red-600">{codeForm.formState.errors.code.message}</p>
                      )}
                    </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                >
                  {isLoading ? 'Verifying...' : 'Verify & continue'}
                </button>
              </div>
            </form>
          )}
                  </div>

        {step === 'code' && (
          <div className="mt-6 bg-green-50 border border-green-200 rounded-md p-4 flex items-center">
            <CheckIcon className="h-5 w-5 text-green-600 mr-2" />
            <p className="text-sm text-green-800">After verification you'll be guided to create your first gathering.</p>
            </div>
          )}
      </div>
    </div>
  );
};

export default OnboardingPage; 