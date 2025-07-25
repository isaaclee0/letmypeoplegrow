import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { authAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

interface ContactFormData {
  contact: string;
}

interface CodeFormData {
  code: string;
}

const LoginPage: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [contact, setContact] = useState('');
  const [contactType, setContactType] = useState<'email' | 'sms'>('email');
  const [step, setStep] = useState<'contact' | 'code'>('contact');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  
  const { login } = useAuth();
  const navigate = useNavigate();
  
  const contactForm = useForm<ContactFormData>();
  const codeForm = useForm<CodeFormData>();

  // Cooldown timer effect
  useEffect(() => {
    if (cooldownSeconds > 0) {
      const timer = setTimeout(() => setCooldownSeconds(cooldownSeconds - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [cooldownSeconds]);

  const handleContactSubmit = async (data: ContactFormData) => {
    setIsLoading(true);
    setError('');

    try {
      const response = await authAPI.requestCode(data.contact);
      setContact(data.contact);
      setContactType(response.data.contactType || 'email');
      setStep('code');
      setCooldownSeconds(response.data.cooldownSeconds || 60);
      // Reset the code form to ensure it's empty
      codeForm.reset();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to send verification code');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCodeSubmit = async (data: CodeFormData) => {
    setIsLoading(true);
    setError('');

    try {
      const response = await authAPI.verifyCode(contact, data.code);
      // Token is now handled by cookies, pass empty string for backward compatibility
      await login('', response.data.user);
      
      // Redirect based on user role and onboarding status
      if (response.data.user.role === 'admin') {
        // Will be redirected by ProtectedRoute logic if onboarding needed
        navigate('/app/dashboard');
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

  const goBackToContact = () => {
    setStep('contact');
    setError('');
    codeForm.reset();
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
            Welcome Back
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Sign in to your church attendance tracking system
          </p>
        </div>

        {/* Error Display */}
        {error && (
          <div className="rounded-md bg-red-50 p-4">
            <div className="text-sm text-red-700">{error}</div>
          </div>
        )}

        {step === 'contact' ? (
          <form className="mt-8 space-y-6" onSubmit={contactForm.handleSubmit(handleContactSubmit)}>
            <div>
              <label htmlFor="contact" className="block text-sm font-medium text-gray-700">
                Email or Phone Number *
              </label>
              <input
                {...contactForm.register('contact', { 
                  required: 'Email or phone number is required',
                  pattern: {
                    value: /^([^\s@]+@[^\s@]+\.[^\s@]+|[+]?[\d\s\-\(\)]+)$/,
                    message: 'Please enter a valid email address or phone number'
                  }
                })}
                type="text"
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-primary-500 focus:border-primary-500 focus:z-10 sm:text-sm"
                placeholder="your@email.com or +1234567890"
              />
              {contactForm.formState.errors.contact && (
                <p className="mt-1 text-sm text-red-600">{contactForm.formState.errors.contact.message}</p>
              )}
            </div>

            <div>
              <button
                type="submit"
                disabled={isLoading}
                className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Sending Code...' : 'Send Verification Code'}
              </button>
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
                onClick={goBackToContact}
                className="text-sm text-primary-600 hover:text-primary-500"
              >
                ← Use different contact
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

        {/* Signup Link - Always visible */}
        <div className="text-center">
          <p className="text-sm text-gray-600">
            New to Let My People Grow?{' '}
            <Link to="/signup" className="font-medium text-primary-600 hover:text-primary-500">
              Create your church account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default LoginPage; 