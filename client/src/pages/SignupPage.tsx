import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { authAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

interface SignupFormData {
  email: string;
  firstName: string;
  lastName: string;
}

const SignupPage: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [contact, setContact] = useState('');
  const [step, setStep] = useState<'signup' | 'code'>('signup');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  
  const { login } = useAuth();
  const navigate = useNavigate();
  
  const signupForm = useForm<SignupFormData>();
  const codeForm = useForm<{ code: string }>();

  // Cooldown timer effect
  useEffect(() => {
    if (cooldownSeconds > 0) {
      const timer = setTimeout(() => setCooldownSeconds(cooldownSeconds - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [cooldownSeconds]);

  const handleSignupSubmit = async (data: SignupFormData) => {
    setIsLoading(true);
    setError('');
    
    try {
      const response = await authAPI.register(data);
      setContact(data.email);
      setStep('code');
      setSuccess(response.data.message);
      setCooldownSeconds(0); // No cooldown for registration
      // Reset the code form to ensure it's empty
      codeForm.reset();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create account');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCodeSubmit = async (data: { code: string }) => {
    setIsLoading(true);
    setError('');
    
    try {
      const response = await authAPI.verifyCode(contact, data.code);
      await login(response.data.token, response.data.user);
      
      // Redirect based on user role and onboarding status
      if (response.data.user.role === 'admin') {
        // Will be redirected by ProtectedRoute logic if onboarding needed
        navigate('/app/dashboard');
      } else if (response.data.user.role === 'attendance_taker') {
        // Redirect attendance takers directly to attendance page
        navigate('/app/attendance');
      } else {
        navigate('/app/dashboard');
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to verify code');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (cooldownSeconds > 0) return;

    setIsLoading(true);
    setError('');

    try {
      const response = await authAPI.requestCode(contact);
      setCooldownSeconds(response.data.cooldownSeconds || 60);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to resend verification code');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-500 via-primary-600 to-secondary-500 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8 bg-white rounded-xl shadow-2xl p-8">
        <div>
          <div className="mx-auto h-20 w-20 flex items-center justify-center">
            <img
              className="h-20 w-auto"
              src="/logo.png"
              alt="Let My People Grow"
            />
          </div>
          <h2 className="mt-6 text-center text-3xl font-bold text-gray-900 font-title">
            Set Up Your Church
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Create your church's attendance tracking account
          </p>
        </div>

        {/* Error Display */}
        {error && (
          <div className="rounded-md bg-red-50 p-4">
            <div className="text-sm text-red-700">{error}</div>
          </div>
        )}

        {/* Success Display */}
        {success && (
          <div className="rounded-md bg-green-50 p-4">
            <div className="text-sm text-green-700">{success}</div>
          </div>
        )}

        {step === 'signup' ? (
          <form className="mt-8 space-y-6" onSubmit={signupForm.handleSubmit(handleSignupSubmit)}>
            <div>
                              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                  Church Admin Email *
                </label>
              <input
                {...signupForm.register('email', { 
                  required: 'Email is required',
                  pattern: {
                    value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                    message: 'Please enter a valid email address'
                  }
                })}
                type="email"
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                placeholder="your@email.com"
              />
              {signupForm.formState.errors.email && (
                <p className="mt-1 text-sm text-red-600">{signupForm.formState.errors.email.message}</p>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="firstName" className="block text-sm font-medium text-gray-700">
                  Admin First Name *
                </label>
                <input
                  {...signupForm.register('firstName', { required: 'First name is required' })}
                  type="text"
                  className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                  placeholder="John"
                />
                {signupForm.formState.errors.firstName && (
                  <p className="mt-1 text-sm text-red-600">{signupForm.formState.errors.firstName.message}</p>
                )}
              </div>

              <div>
                <label htmlFor="lastName" className="block text-sm font-medium text-gray-700">
                  Admin Last Name *
                </label>
                <input
                  {...signupForm.register('lastName', { required: 'Last name is required' })}
                  type="text"
                  className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                  placeholder="Smith"
                />
                {signupForm.formState.errors.lastName && (
                  <p className="mt-1 text-sm text-red-600">{signupForm.formState.errors.lastName.message}</p>
                )}
              </div>
            </div>

            <div>
              <button
                type="submit"
                disabled={isLoading}
                className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Setting Up Church...' : 'Set Up Church'}
              </button>
            </div>

            <div className="text-center">
              <p className="text-sm text-gray-600">
                Already have a church account?{' '}
                <Link to="/login" className="font-medium text-primary-600 hover:text-primary-500">
                  Sign in here
                </Link>
              </p>
            </div>
          </form>
        ) : (
          <form className="mt-8 space-y-6" onSubmit={codeForm.handleSubmit(handleCodeSubmit)}>
            <div>
              <label htmlFor="code" className="sr-only">
                Verification Code
              </label>
              <input
                {...codeForm.register('code', {
                  required: 'Verification code is required',
                  pattern: {
                    value: /^\d{6}$/,
                    message: 'Code must be 6 digits'
                  }
                })}
                type="text"
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                className="appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 text-center text-lg tracking-widest focus:outline-none focus:ring-primary-500 focus:border-primary-500 focus:z-10"
                placeholder="000000"
              />
              {codeForm.formState.errors.code && (
                <p className="mt-1 text-sm text-red-600">{codeForm.formState.errors.code.message}</p>
              )}
              <p className="mt-1 text-xs text-gray-500 text-center">
                Code sent to: <span className="font-medium">{contact}</span>
              </p>
            </div>

            <div>
              <button
                type="submit"
                disabled={isLoading}
                className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Verifying...' : 'Verify Code'}
              </button>
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStep('signup')}
                className="text-sm text-primary-600 hover:text-primary-500"
              >
                ← Back to signup
              </button>
              <button
                type="button"
                onClick={handleResendCode}
                disabled={cooldownSeconds > 0 || isLoading}
                className="text-sm text-primary-600 hover:text-primary-500 disabled:text-gray-400 disabled:cursor-not-allowed"
              >
                {cooldownSeconds > 0 ? `Resend in ${cooldownSeconds}s` : 'Resend code'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default SignupPage; 