import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { authAPI, onboardingAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { CheckIcon, MapPinIcon, XMarkIcon } from '@heroicons/react/24/outline';

interface SetupForm {
  churchName: string;
  adminEmail: string;
}

interface LocationResult {
  name: string;
  admin1: string | null;
  country: string | null;
  countryCode: string | null;
  lat: number;
  lng: number;
  displayName: string;
}

const OnboardingPage: React.FC = () => {
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [churchName, setChurchName] = useState('');
  const [selectedLocation, setSelectedLocation] = useState<LocationResult | null>(null);
  const [locationSearch, setLocationSearch] = useState('');
  const [locationResults, setLocationResults] = useState<LocationResult[]>([]);
  const [showLocationDropdown, setShowLocationDropdown] = useState(false);
  const [locationSearching, setLocationSearching] = useState(false);
  const locationDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const locationDropdownRef = useRef<HTMLDivElement>(null);
  const { login, refreshOnboardingStatus, updateUser, user } = useAuth();
  const navigate = useNavigate();
  
  const setupForm = useForm<SetupForm>();
  const codeForm = useForm<{ code: string }>();

  // Close location dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (locationDropdownRef.current && !locationDropdownRef.current.contains(e.target as Node)) {
        setShowLocationDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Location search - call Open-Meteo directly (no auth needed)
  const handleLocationSearchChange = (value: string) => {
    setLocationSearch(value);

    if (locationDebounceRef.current) {
      clearTimeout(locationDebounceRef.current);
    }

    if (value.trim().length < 2) {
      setLocationResults([]);
      setShowLocationDropdown(false);
      return;
    }

    locationDebounceRef.current = setTimeout(async () => {
      try {
        setLocationSearching(true);
        const response = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(value.trim())}&count=8&language=en&format=json`
        );
        const data = await response.json();
        const results: LocationResult[] = (data.results || []).map((r: any) => ({
          name: r.name,
          admin1: r.admin1 || null,
          country: r.country || null,
          countryCode: r.country_code || null,
          lat: r.latitude,
          lng: r.longitude,
          displayName: [r.name, r.admin1, r.country].filter(Boolean).join(', ')
        }));
        setLocationResults(results);
        setShowLocationDropdown(true);
      } catch (err) {
        setLocationResults([]);
      } finally {
        setLocationSearching(false);
      }
    }, 300);
  };

  const handleLocationSelect = (result: LocationResult) => {
    setSelectedLocation(result);
    setLocationSearch('');
    setLocationResults([]);
    setShowLocationDropdown(false);
  };

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
      const churchInfo: any = {
        churchName,
        countryCode: 'AU',
        timezone: 'Australia/Sydney',
        emailFromName: 'Let My People Grow',
        emailFromAddress: 'noreply@letmypeoplegrow.com.au',
      };
      if (selectedLocation) {
        churchInfo.locationName = selectedLocation.displayName;
        churchInfo.locationLat = selectedLocation.lat;
        churchInfo.locationLng = selectedLocation.lng;
      }
      await onboardingAPI.saveChurchInfo(churchInfo);

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

                {/* Optional location */}
                <div>
                  <label htmlFor="location-search" className="block text-sm font-medium text-gray-700">
                    Church location <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  {selectedLocation ? (
                    <div className="mt-1 flex items-center justify-between bg-gray-50 rounded-md border border-gray-300 px-3 py-2">
                      <div className="flex items-center text-sm text-gray-900">
                        <MapPinIcon className="h-4 w-4 text-gray-400 mr-2 flex-shrink-0" />
                        {selectedLocation.displayName}
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedLocation(null)}
                        className="text-gray-400 hover:text-gray-600"
                      >
                        <XMarkIcon className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="relative" ref={locationDropdownRef}>
                      <input
                        type="text"
                        id="location-search"
                        value={locationSearch}
                        onChange={(e) => handleLocationSearchChange(e.target.value)}
                        onFocus={() => {
                          if (locationResults.length > 0) setShowLocationDropdown(true);
                        }}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="Search for your city..."
                        autoComplete="off"
                      />
                      {locationSearching && (
                        <div className="absolute inset-y-0 right-0 flex items-center pr-3 mt-1">
                          <svg className="animate-spin h-4 w-4 text-gray-400" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                        </div>
                      )}
                      {showLocationDropdown && locationResults.length > 0 && (
                        <div className="absolute z-10 mt-1 w-full bg-white shadow-lg rounded-md border border-gray-200 max-h-48 overflow-auto">
                          {locationResults.map((result, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => handleLocationSelect(result)}
                              className="w-full text-left px-4 py-2.5 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                            >
                              <div className="text-sm font-medium text-gray-900">{result.name}</div>
                              <div className="text-xs text-gray-500">
                                {[result.admin1, result.country].filter(Boolean).join(', ')}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <p className="mt-1 text-xs text-gray-500">
                    Enables weather & holiday-aware attendance predictions. You can set this later.
                  </p>
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