import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { authAPI } from '../services/api';

const LandingPage: React.FC = () => {
  const [hasUsers, setHasUsers] = useState<boolean | null>(null);
  const [hasNonAdminUsers, setHasNonAdminUsers] = useState<boolean | null>(null);

  // Check if users exist on component mount
  useEffect(() => {
    const checkUsers = async () => {
      try {
        const response = await authAPI.checkUsers();
        setHasUsers(response.data.hasUsers);
        setHasNonAdminUsers(response.data.hasNonAdminUsers);
      } catch (error) {
        console.error('Failed to check users:', error);
        // Default to showing "welcome back" if we can't check
        setHasUsers(true);
        setHasNonAdminUsers(true);
      }
    };
    
    checkUsers();
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-r from-primary-500 via-primary-600 to-secondary-500">
      <div className="relative overflow-hidden">
        <div className="max-w-7xl mx-auto">
          <div className="relative z-10 pb-8 sm:pb-16 md:pb-20 lg:max-w-2xl lg:w-full lg:pb-28 xl:pb-32">
            <main className="mt-10 mx-auto max-w-7xl px-4 sm:mt-12 sm:px-6 md:mt-16 lg:mt-20 lg:px-8 xl:mt-28">
              <div className="sm:text-center lg:text-left">
                <div className="mx-auto h-24 w-24 flex items-center justify-center mb-8 lg:mx-0">
                  <img
                    className="h-24 w-auto"
                    src="/logo.png"
                    alt="Let My People Grow"
                  />
                </div>
                <h1 className="text-4xl tracking-tight font-extrabold text-white sm:text-5xl md:text-6xl lg:text-left">
                  <span className="block">Let My People</span>
                  <span className="block text-secondary-300">Grow</span>
                </h1>
                <p className="mt-3 text-base text-gray-100 sm:mt-5 sm:text-lg sm:max-w-xl sm:mx-auto md:mt-5 md:text-xl lg:mx-0 lg:text-left">
                  Transform your church attendance tracking with our comprehensive, easy-to-use platform. 
                  Connect with your congregation, track attendance, and grow together.
                </p>
                <div className="mt-5 sm:mt-8 sm:flex sm:justify-center lg:justify-start">
                  <div className="rounded-md shadow">
                    <Link
                      to="/signup"
                      className="w-full flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md text-primary-600 bg-white hover:bg-gray-50 md:py-4 md:text-lg md:px-10 transition-colors duration-200"
                    >
                      {hasNonAdminUsers ? 'Get Started' : 'Set Up Your Church'}
                    </Link>
                  </div>
                  {hasNonAdminUsers && (
                    <div className="mt-3 sm:mt-0 sm:ml-3">
                      <Link
                        to="/login"
                        className="w-full flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md text-white bg-primary-600 bg-opacity-60 hover:bg-opacity-70 md:py-4 md:text-lg md:px-10 transition-colors duration-200"
                      >
                        Sign In
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            </main>
          </div>
        </div>
        <div className="lg:absolute lg:inset-y-0 lg:right-0 lg:w-1/2">
          <div className="h-56 w-full bg-gradient-to-r from-secondary-400 to-secondary-600 sm:h-72 md:h-96 lg:w-full lg:h-full flex items-center justify-center">
            <div className="text-center text-white px-4 lg:px-8">
              <h3 className="text-2xl font-bold mb-6 lg:text-3xl lg:text-left">Church Attendance Made Simple</h3>
              <div className="grid grid-cols-1 gap-4 text-sm lg:text-left lg:gap-6">
                <div className="flex items-center justify-center lg:justify-start">
                  <span className="bg-white bg-opacity-20 rounded-full p-2 mr-3 flex-shrink-0">✓</span>
                  <span className="text-white">Easy attendance tracking</span>
                </div>
                <div className="flex items-center justify-center lg:justify-start">
                  <span className="bg-white bg-opacity-20 rounded-full p-2 mr-3 flex-shrink-0">✓</span>
                  <span className="text-white">Family grouping</span>
                </div>
                <div className="flex items-center justify-center lg:justify-start">
                  <span className="bg-white bg-opacity-20 rounded-full p-2 mr-3 flex-shrink-0">✓</span>
                  <span className="text-white">Detailed reports</span>
                </div>
                <div className="flex items-center justify-center lg:justify-start">
                  <span className="bg-white bg-opacity-20 rounded-full p-2 mr-3 flex-shrink-0">✓</span>
                  <span className="text-white">Team collaboration</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LandingPage; 