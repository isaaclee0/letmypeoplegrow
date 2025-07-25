import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { onboardingAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import {
  CheckIcon,
  ChevronRightIcon,
  CloudArrowUpIcon,
  DocumentArrowDownIcon,
  BuildingOfficeIcon,
  CalendarIcon,
  PlusIcon,
  TrashIcon
} from '@heroicons/react/24/outline';

interface ChurchInfoForm {
  churchName: string;
  countryCode: string;
  timezone: string;
  emailFromName: string;
  emailFromAddress: string;
}

interface GatheringForm {
  name: string;
  description: string;
  dayOfWeek: string;
  startTime: string;
  durationMinutes: number;
  frequency: string;
}

interface Gathering {
  id: number;
  name: string;
  description: string;
  dayOfWeek: string;
  startTime: string;
  durationMinutes: number;
  frequency: string;
}

const OnboardingPage: React.FC = () => {
  const [currentStep, setCurrentStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [gatherings, setGatherings] = useState<Gathering[]>([]);
  const [selectedGatheringId, setSelectedGatheringId] = useState<number | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<any>(null);
  const [countries, setCountries] = useState<any[]>([]);
  const [showAddGathering, setShowAddGathering] = useState(false);
  const [progressLoaded, setProgressLoaded] = useState(false);
  
  const { user, updateUser, refreshOnboardingStatus } = useAuth();
  const navigate = useNavigate();
  
  const churchForm = useForm<ChurchInfoForm>({
    defaultValues: {
      countryCode: 'AU',
      timezone: 'Australia/Sydney',
      emailFromName: 'Let My People Grow',
      emailFromAddress: 'noreply@letmypeoplegrow.org'
    }
  });
  
  const gatheringForm = useForm<GatheringForm>({
    defaultValues: {
      dayOfWeek: 'Sunday',
      startTime: '10:00',
      durationMinutes: 90,
      frequency: 'weekly'
    }
  });

  // Load countries and restore progress on component mount
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        // Load countries
        const countriesResponse = await onboardingAPI.getCountries();
        setCountries(countriesResponse.data.countries);
        
        // Load onboarding status and progress
        const statusResponse = await onboardingAPI.getStatus();
        const progress = statusResponse.data.progress;
        
        if (progress) {
          // Restore current step
          setCurrentStep(progress.current_step || 1);
          
          // Restore church info if available
          if (progress.church_info) {
            try {
              let churchInfo;
              if (typeof progress.church_info === 'string') {
                churchInfo = JSON.parse(progress.church_info);
              } else if (typeof progress.church_info === 'object') {
                churchInfo = progress.church_info;
              } else {
                console.error('Unexpected church_info type:', typeof progress.church_info);
                // Skip this field if it's not a string or object
              }
              churchForm.reset(churchInfo);
            } catch (parseError) {
              console.error('Failed to parse church_info:', parseError);
            }
          }
          
          // Restore gatherings if available
          if (progress.gatherings) {
            try {
              let savedGatherings;
              if (typeof progress.gatherings === 'string') {
                savedGatherings = JSON.parse(progress.gatherings);
              } else if (typeof progress.gatherings === 'object') {
                savedGatherings = progress.gatherings;
              } else {
                console.error('Unexpected gatherings type:', typeof progress.gatherings);
                // Skip this field if it's not a string or object
              }
              if (savedGatherings) {
                setGatherings(savedGatherings);
              }
            } catch (parseError) {
              console.error('Failed to parse gatherings:', parseError);
            }
          }
          
          // Restore CSV upload result if available
          if (progress.csv_upload) {
            try {
              let savedUploadResult;
              if (typeof progress.csv_upload === 'string') {
                savedUploadResult = JSON.parse(progress.csv_upload);
              } else if (typeof progress.csv_upload === 'object') {
                savedUploadResult = progress.csv_upload;
              } else {
                console.error('Unexpected csv_upload type:', typeof progress.csv_upload);
                // Skip this field if it's not a string or object
              }
              if (savedUploadResult) {
                setUploadResult(savedUploadResult);
                setSelectedGatheringId(savedUploadResult.gatheringId);
              }
            } catch (parseError) {
              console.error('Failed to parse csv_upload:', parseError);
            }
          }
        }
        
        setProgressLoaded(true);
      } catch (error) {
        console.error('Failed to load initial data:', error);
        setError('Failed to load onboarding data');
        setProgressLoaded(true);
      }
    };
    
    loadInitialData();
  }, [churchForm]);

  // Check if user is admin
  useEffect(() => {
    if (user?.role !== 'admin') {
      navigate('/dashboard');
    }
  }, [user, navigate]);

  const steps = [
    { id: 1, name: 'Church Information', icon: BuildingOfficeIcon },
    { id: 2, name: 'Create Gatherings', icon: CalendarIcon },
    { id: 3, name: 'Add People', icon: CloudArrowUpIcon },
    { id: 4, name: 'Complete Setup', icon: CheckIcon },
  ];

  // Function to save progress
  const saveProgress = async (step: number, data?: any) => {
    try {
      await onboardingAPI.saveProgress(step, data);
    } catch (error) {
      console.error('Failed to save progress:', error);
    }
  };

  const handleChurchInfoSubmit = async (data: ChurchInfoForm) => {
    setIsLoading(true);
    setError('');
    
    try {
      await onboardingAPI.saveChurchInfo(data);
      setCurrentStep(2);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save church information');
    } finally {
      setIsLoading(false);
    }
  };

  const handleGatheringSubmit = async (data: GatheringForm) => {
    setIsLoading(true);
    setError('');
    
    try {
      const response = await onboardingAPI.createGathering(data);
      const newGathering: Gathering = {
        id: response.data.gatheringId,
        ...data
      };
      setGatherings([...gatherings, newGathering]);
      gatheringForm.reset();
      setShowAddGathering(false);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create gathering');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveGathering = async (gatheringId: number) => {
    setIsLoading(true);
    setError('');
    
    try {
      await onboardingAPI.deleteGathering(gatheringId);
      setGatherings(gatherings.filter(g => g.id !== gatheringId));
      if (selectedGatheringId === gatheringId) {
        setSelectedGatheringId(null);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete gathering');
    } finally {
      setIsLoading(false);
    }
  };

  const handleContinueToAddPeople = async () => {
    if (gatherings.length === 0) {
      setError('Please create at least one gathering before continuing');
      return;
    }
    setSelectedGatheringId(gatherings[0].id);
    setCurrentStep(3);
    await saveProgress(3);
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setUploadedFile(file);
    }
  };

  const handleCSVUpload = async () => {
    if (!uploadedFile || !selectedGatheringId) return;
    
    setIsLoading(true);
    setError('');
    
    try {
      const response = await onboardingAPI.uploadCSV(selectedGatheringId, uploadedFile);
      setUploadResult(response.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to upload CSV');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSkipUpload = async () => {
    setCurrentStep(4);
    await saveProgress(4);
  };

  const handleContinueToComplete = async () => {
    setCurrentStep(4);
    await saveProgress(4);
  };

  const handleCompleteOnboarding = async () => {
    setIsLoading(true);
    setError('');
    
    try {
      await onboardingAPI.complete();
      
      // Refresh the onboarding status to update the needsOnboarding state
      await refreshOnboardingStatus();
      
      // Update user's first login status
      if (user) {
        updateUser({ ...user, isFirstLogin: false });
      }
      
      navigate('/app/dashboard');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to complete onboarding');
    } finally {
      setIsLoading(false);
    }
  };

  const downloadTemplate = async () => {
    try {
      const response = await onboardingAPI.downloadTemplate();
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', 'attendance_import_template.csv');
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download template:', err);
    }
  };

  // Show loading while progress is being restored
  if (!progressLoaded) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary-50 to-secondary-50 py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading your progress...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-secondary-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="mx-auto h-16 w-16 mb-6 flex items-center justify-center">
            <img
              className="h-16 w-auto"
              src="/logo.png"
              alt="Let My People Grow"
            />
          </div>
          <h1 className="text-3xl font-bold text-primary-700 mb-4 font-title">
            Welcome to Let My People Grow!
          </h1>
          <p className="text-lg text-primary-600 font-medium">
            Let's set up your church attendance tracking system in just a few steps.
          </p>
        </div>

        {/* Progress Steps */}
        <div className="mb-12">
          <div className="flex items-center justify-center">
            {steps.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <div className={`flex items-center justify-center w-12 h-12 rounded-full border-2 ${
                  currentStep > step.id 
                    ? 'bg-green-500 border-green-500 text-white'
                    : currentStep === step.id
                    ? 'bg-primary-500 border-primary-500 text-white'
                    : 'bg-white border-gray-300 text-gray-500'
                }`}>
                  {currentStep > step.id ? (
                    <CheckIcon className="h-6 w-6" />
                  ) : (
                    <step.icon className="h-6 w-6" />
                  )}
                </div>
                <div className="ml-3 hidden sm:block">
                  <p className={`text-sm font-medium ${
                    currentStep >= step.id ? 'text-gray-900' : 'text-gray-500'
                  }`}>
                    {step.name}
                  </p>
                </div>
                {index < steps.length - 1 && (
                  <ChevronRightIcon className="h-5 w-5 text-gray-400 mx-4" />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-6 rounded-md bg-red-50 p-4">
            <div className="text-sm text-red-700">{error}</div>
          </div>
        )}

        {/* Step Content */}
        <div className="bg-white shadow rounded-lg p-6">
          {currentStep === 1 && (
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-6">
                Church Information
              </h2>
              <form onSubmit={churchForm.handleSubmit(handleChurchInfoSubmit)} className="space-y-6">
                <div>
                  <label htmlFor="churchName" className="block text-sm font-medium text-gray-700">
                    Church Name *
                  </label>
                  <input
                    {...churchForm.register('churchName', { required: 'Church name is required' })}
                    type="text"
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    placeholder="First Baptist Church"
                  />
                  {churchForm.formState.errors.churchName && (
                    <p className="mt-1 text-sm text-red-600">{churchForm.formState.errors.churchName.message}</p>
                  )}
                </div>

                <div>
                  <label htmlFor="countryCode" className="block text-sm font-medium text-gray-700">
                    Country *
                  </label>
                  <select
                    {...churchForm.register('countryCode', { required: 'Country is required' })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    {countries.map((country) => (
                      <option key={country.code} value={country.code}>
                        {country.name} ({country.callingCode})
                      </option>
                    ))}
                  </select>
                  {churchForm.formState.errors.countryCode && (
                    <p className="mt-1 text-sm text-red-600">{churchForm.formState.errors.countryCode.message}</p>
                  )}
                  <p className="mt-1 text-xs text-gray-500">
                    This determines the phone number format for your church
                  </p>
                </div>

                <div>
                  <label htmlFor="timezone" className="block text-sm font-medium text-gray-700">
                    Timezone
                  </label>
                  <select
                    {...churchForm.register('timezone')}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    <option value="Australia/Sydney">Australia - Sydney (AEDT/AEST)</option>
                    <option value="Australia/Melbourne">Australia - Melbourne (AEDT/AEST)</option>
                    <option value="Australia/Brisbane">Australia - Brisbane (AEST)</option>
                    <option value="Australia/Perth">Australia - Perth (AWST)</option>
                    <option value="Australia/Adelaide">Australia - Adelaide (ACDT/ACST)</option>
                    <option value="Australia/Darwin">Australia - Darwin (ACST)</option>
                    <option value="America/New_York">US - Eastern Time</option>
                    <option value="America/Chicago">US - Central Time</option>
                    <option value="America/Denver">US - Mountain Time</option>
                    <option value="America/Los_Angeles">US - Pacific Time</option>
                    <option value="Europe/London">UK - London (GMT/BST)</option>
                    <option value="Europe/Berlin">Europe - Berlin (CET/CEST)</option>
                    <option value="Asia/Singapore">Asia - Singapore (SGT)</option>
                    <option value="Pacific/Auckland">New Zealand - Auckland (NZDT/NZST)</option>
                  </select>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label htmlFor="emailFromName" className="block text-sm font-medium text-gray-700">
                      Email From Name
                    </label>
                    <input
                      {...churchForm.register('emailFromName')}
                      type="text"
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>

                  <div>
                    <label htmlFor="emailFromAddress" className="block text-sm font-medium text-gray-700">
                      Email From Address
                    </label>
                    <input
                      {...churchForm.register('emailFromAddress')}
                      type="email"
                      className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                  >
                    {isLoading ? 'Saving...' : 'Continue'}
                    <ChevronRightIcon className="ml-2 h-5 w-5" />
                  </button>
                </div>
              </form>
            </div>
          )}

          {currentStep === 2 && (
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-6">
                Create Your Gatherings
              </h2>
              
              {/* Existing Gatherings */}
              {gatherings.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">Your Gatherings</h3>
                  <div className="space-y-3">
                    {gatherings.map((gathering) => (
                      <div key={gathering.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                        <div>
                          <h4 className="font-medium text-gray-900">{gathering.name}</h4>
                          <p className="text-sm text-gray-600">
                            {gathering.dayOfWeek}s at {gathering.startTime} ({gathering.durationMinutes} minutes)
                          </p>
                          {gathering.description && (
                            <p className="text-sm text-gray-500">{gathering.description}</p>
                          )}
                        </div>
                        <button
                          onClick={() => handleRemoveGathering(gathering.id)}
                          className="text-red-600 hover:text-red-800"
                        >
                          <TrashIcon className="h-5 w-5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Add New Gathering Form */}
              {showAddGathering ? (
                <div className="mb-6 p-4 border border-gray-200 rounded-lg">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">Add New Gathering</h3>
                  <form onSubmit={gatheringForm.handleSubmit(handleGatheringSubmit)} className="space-y-4">
                    <div>
                      <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                        Gathering Name *
                      </label>
                      <input
                        {...gatheringForm.register('name', { required: 'Gathering name is required' })}
                        type="text"
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="Sunday Service"
                      />
                      {gatheringForm.formState.errors.name && (
                        <p className="mt-1 text-sm text-red-600">{gatheringForm.formState.errors.name.message}</p>
                      )}
                    </div>

                    <div>
                      <label htmlFor="description" className="block text-sm font-medium text-gray-700">
                        Description
                      </label>
                      <textarea
                        {...gatheringForm.register('description')}
                        rows={2}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        placeholder="Weekly worship service"
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <label htmlFor="dayOfWeek" className="block text-sm font-medium text-gray-700">
                          Day of Week *
                        </label>
                        <select
                          {...gatheringForm.register('dayOfWeek', { required: 'Day of week is required' })}
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        >
                          <option value="Sunday">Sunday</option>
                          <option value="Monday">Monday</option>
                          <option value="Tuesday">Tuesday</option>
                          <option value="Wednesday">Wednesday</option>
                          <option value="Thursday">Thursday</option>
                          <option value="Friday">Friday</option>
                          <option value="Saturday">Saturday</option>
                        </select>
                      </div>

                      <div>
                        <label htmlFor="startTime" className="block text-sm font-medium text-gray-700">
                          Start Time *
                        </label>
                        <input
                          {...gatheringForm.register('startTime', { required: 'Start time is required' })}
                          type="time"
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        />
                      </div>

                      <div>
                        <label htmlFor="durationMinutes" className="block text-sm font-medium text-gray-700">
                          Duration (minutes) *
                        </label>
                        <input
                          {...gatheringForm.register('durationMinutes', { 
                            required: 'Duration is required',
                            min: { value: 15, message: 'Minimum 15 minutes' },
                            max: { value: 480, message: 'Maximum 8 hours' }
                          })}
                          type="number"
                          min="15"
                          max="480"
                          className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                        />
                      </div>
                    </div>

                    <div>
                      <label htmlFor="frequency" className="block text-sm font-medium text-gray-700">
                        Frequency *
                      </label>
                      <select
                        {...gatheringForm.register('frequency', { required: 'Frequency is required' })}
                        className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                      >
                        <option value="weekly">Weekly</option>
                        <option value="biweekly">Bi-weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </div>



                    <div className="flex justify-end space-x-3">
                      <button
                        type="button"
                        onClick={() => setShowAddGathering(false)}
                        className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isLoading}
                        className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                      >
                        {isLoading ? 'Creating...' : 'Add Gathering'}
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <div className="mb-6">
                  <button
                    onClick={() => setShowAddGathering(true)}
                    className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                  >
                    <PlusIcon className="h-4 w-4 mr-2" />
                    Add Gathering
                  </button>
                </div>
              )}

              <div className="flex justify-end">
                <button
                  onClick={handleContinueToAddPeople}
                  disabled={gatherings.length === 0 || isLoading}
                  className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                >
                  Continue to Add People
                  <ChevronRightIcon className="ml-2 h-5 w-5" />
                </button>
              </div>
            </div>
          )}

          {currentStep === 3 && (
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-6">
                Add People to Your Gatherings
              </h2>
              
              {/* Gathering Selection */}
              {gatherings.length > 1 && (
                <div className="mb-6">
                  <label htmlFor="gatheringSelect" className="block text-sm font-medium text-gray-700 mb-2">
                    Select Gathering for Import
                  </label>
                  <select
                    id="gatheringSelect"
                    value={selectedGatheringId || ''}
                    onChange={(e) => setSelectedGatheringId(Number(e.target.value))}
                    className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500"
                  >
                    {gatherings.map((gathering) => (
                      <option key={gathering.id} value={gathering.id}>
                        {gathering.name} ({gathering.dayOfWeek}s at {gathering.startTime})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              
              {!uploadResult ? (
                <div className="space-y-6">
                  <p className="text-gray-600">
                    Upload a CSV file with your regular attendees to get started quickly. 
                    You can always add more people later.
                  </p>

                  <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                    <div className="flex">
                      <DocumentArrowDownIcon className="h-5 w-5 text-blue-400 mt-0.5 mr-3" />
                      <div>
                        <h3 className="text-sm font-medium text-blue-800">
                          Download CSV Template
                        </h3>
                        <p className="mt-1 text-sm text-blue-700">
                          Use our template to format your data correctly.
                        </p>
                        <button
                          onClick={downloadTemplate}
                          className="mt-2 text-sm text-blue-600 hover:text-blue-500 font-medium"
                        >
                          Download Template →
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="csvFile" className="block text-sm font-medium text-gray-700 mb-2">
                      Upload CSV File
                    </label>
                    <input
                      type="file"
                      id="csvFile"
                      accept=".csv"
                      onChange={handleFileUpload}
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                    />
                  </div>

                  {uploadedFile && (
                    <div className="bg-green-50 border border-green-200 rounded-md p-4">
                      <p className="text-sm text-green-800">
                        <strong>Selected file:</strong> {uploadedFile.name}
                      </p>
                    </div>
                  )}

                  <div className="flex justify-between">
                    <button
                      onClick={handleSkipUpload}
                      className="inline-flex items-center px-6 py-3 border border-gray-300 text-base font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                    >
                      Skip for Now
                    </button>
                    <button
                      onClick={handleCSVUpload}
                      disabled={!uploadedFile || isLoading}
                      className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                    >
                      {isLoading ? 'Uploading...' : 'Upload & Continue'}
                      <CloudArrowUpIcon className="ml-2 h-5 w-5" />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="bg-green-50 border border-green-200 rounded-md p-6">
                    <div className="flex items-center">
                      <CheckIcon className="h-6 w-6 text-green-500 mr-3" />
                      <div>
                        <h3 className="text-lg font-medium text-green-800">
                          Import Successful!
                        </h3>
                        <p className="mt-1 text-sm text-green-700">
                          {uploadResult.message}
                        </p>
                        <div className="mt-2 text-sm text-green-600">
                          <p>• Imported: {uploadResult.imported} individuals</p>
                          <p>• Created: {uploadResult.families} families</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={handleContinueToComplete}
                      disabled={isLoading}
                      className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
                    >
                      Continue to Complete Setup
                      <ChevronRightIcon className="ml-2 h-5 w-5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {currentStep === 4 && (
            <div>
              <h2 className="text-xl font-semibold text-gray-900 mb-6">
                Complete Your Setup
              </h2>
              
              <div className="space-y-6">
                <div className="bg-green-50 border border-green-200 rounded-md p-6">
                  <div className="flex items-center">
                    <CheckIcon className="h-6 w-6 text-green-500 mr-3" />
                    <div>
                      <h3 className="text-lg font-medium text-green-800">
                        Setup Complete!
                      </h3>
                      <p className="mt-1 text-sm text-green-700">
                        Your church attendance tracking system is ready to use.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                  <h3 className="text-sm font-medium text-blue-800 mb-2">
                    What's Next?
                  </h3>
                  <ul className="text-sm text-blue-700 space-y-1">
                    <li>• Start recording attendance for your gatherings</li>
                    <li>• Add more people individually or via CSV</li>
                    <li>• Invite coordinators and attendance takers</li>
                    <li>• View reports and analytics</li>
                  </ul>
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={handleCompleteOnboarding}
                    disabled={isLoading}
                    className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-green-600 hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 disabled:opacity-50"
                  >
                    {isLoading ? 'Completing...' : 'Complete Setup'}
                    <CheckIcon className="ml-2 h-5 w-5" />
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

export default OnboardingPage; 