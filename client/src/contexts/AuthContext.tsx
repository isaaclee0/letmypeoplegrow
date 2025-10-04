import React, { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';
import { authAPI, onboardingAPI, User } from '../services/api';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  needsOnboarding: boolean;
  login: (token: string, userData: User) => Promise<void>;
  logout: () => void;
  updateUser: (userData: Partial<User>) => void;
  refreshOnboardingStatus: () => Promise<void>;
  refreshUserData: () => Promise<void>;
  refreshTokenAndUserData: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const isInitializing = useRef(false);
  const lastRedirect = useRef(0); // Track last redirect time for debouncing

  useEffect(() => {
    const initializeAuth = async () => {
      console.log('🔄 initializeAuth started at', new Date().toISOString());
      
      if (isInitializing.current) {
        console.log('⚠️ Already initializing, skipping');
        return;
      }
      
      isInitializing.current = true;
      setIsLoading(true); // Set loading early to prevent flicker
      
      try {
        // STEP 1: Load from cache immediately for instant app startup
        let loadedFromCache = false;
        const storedUser = localStorage.getItem('user');
        if (storedUser) {
          try {
            const parsedUser = JSON.parse(storedUser); // Validate JSON
            
            // Check if stored data has all required fields (mobile number fields were added recently)
            const hasRequiredFields = parsedUser.hasOwnProperty('mobileNumber') && parsedUser.hasOwnProperty('primaryContactMethod');
            
            if (hasRequiredFields) {
              console.log('⚡ Loading user from cache immediately');
              setUser(parsedUser);
              setIsLoading(false); // Allow app to start immediately with cached data
              loadedFromCache = true;
            } else {
              console.log('⚠️ Incomplete localStorage user data (missing mobile fields), clearing cache');
              localStorage.removeItem('user');
            }
          } catch (e) {
            console.warn('⚠️ Invalid localStorage user data, clearing');
            localStorage.removeItem('user');
          }
        }
        
        // STEP 2: Validate with server (always, even if cache loaded)
        try {
          console.log('🚀 Validating authentication with server...');
          const response = await authAPI.getCurrentUser();
          const newUser = response.data.user;
          
          // Only update state if the new user data differs to prevent unnecessary re-renders
          setUser(prev => JSON.stringify(prev) !== JSON.stringify(newUser) ? newUser : prev);
          localStorage.setItem('user', JSON.stringify(newUser));
          console.log('✅ User authenticated and validated:', newUser.email);
          
          if (newUser.role === 'admin') {
            try {
              const onboardingResponse = await onboardingAPI.getStatus();
              setNeedsOnboarding(prev => prev !== !onboardingResponse.data.completed ? !onboardingResponse.data.completed : prev);
            } catch (onboardingError) {
              console.log('ℹ️ Could not check onboarding status (this is normal if not authenticated)');
            }
          }
        } catch (error: any) {
          // 401 errors are expected when not logged in - this is normal behavior
          if (error.response?.status === 401) {
            console.log('ℹ️ No active session found (user needs to login)');
            localStorage.removeItem('user');
            setUser(null);
          } else if (error.code === 'NETWORK_ERROR' || error.message?.includes('fetch')) {
            // Network errors - if we loaded from cache, just log and continue
            if (loadedFromCache) {
              console.log('⚠️ Could not validate session with server, continuing with cached user data');
              // Don't clear user or show error - user already has working app from cache
            } else {
              // No cache and network error - try one more time to load from cache
              console.log('🌐 Network error during auth check - attempting to use cached user data');
              const cachedUser = localStorage.getItem('user');
              if (cachedUser) {
                try {
                  const parsedUser = JSON.parse(cachedUser);
                  setUser(parsedUser);
                  console.log('📦 Using cached user data due to network error');
                } catch (parseError) {
                  console.error('Failed to parse cached user data:', parseError);
                  localStorage.removeItem('user');
                  setUser(null);
                }
              }
            }
          } else {
            console.error('💥 Unexpected auth initialization error:', error instanceof Error ? error.message : String(error));
            // Only clear cache if we got an auth error (not network error)
            if (!loadedFromCache) {
              localStorage.removeItem('user');
              setUser(null);
            }
          }
        }
      } finally {
        setIsLoading(false);
        isInitializing.current = false;
        console.log('🏁 initializeAuth completed at', new Date().toISOString());
      }
    };

    console.log('🎬 AuthContext: useEffect triggered');
    initializeAuth();
    
    // Cleanup function
    return () => {
      console.log('🧹 AuthContext: useEffect cleanup called');
    };
  }, []);

  const login = async (token: string, userData: User) => {
    console.log('🔐 AuthContext: login() called for user:', userData.email);
    
    // Token is now handled by cookies, only store user data locally
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(prev => JSON.stringify(prev) !== JSON.stringify(userData) ? userData : prev);
    
    // Check onboarding status for admin users
    if (userData.role === 'admin') {
      try {
        const onboardingResponse = await onboardingAPI.getStatus();
        setNeedsOnboarding(!onboardingResponse.data.completed);
      } catch (onboardingError) {
        console.error('Failed to check onboarding status:', onboardingError);
      }
    }
    
    console.log('✅ AuthContext: login() complete');
  };

  const logout = async () => {
    try {
      await authAPI.logout();
    } catch (error) {
      // Even if logout API fails, clear local state
      console.error('Logout error:', error);
    } finally {
      localStorage.removeItem('user');
      setUser(null);
      setNeedsOnboarding(false);
    }
  };

  const updateUser = (userData: Partial<User>) => {
    if (user) {
      const updatedUser = { ...user, ...userData };
      // Only update state if the user data actually changed
      setUser(prev => JSON.stringify(prev) !== JSON.stringify(updatedUser) ? updatedUser : prev);
      localStorage.setItem('user', JSON.stringify(updatedUser));
    }
  };

  const refreshOnboardingStatus = async () => {
    if (user?.role === 'admin') {
      try {
        const onboardingResponse = await onboardingAPI.getStatus();
        setNeedsOnboarding(!onboardingResponse.data.completed);
      } catch (onboardingError) {
        console.error('Failed to check onboarding status:', onboardingError);
      }
    }
  };

  const refreshUserData = async () => {
    try {
      console.log('🔄 Manually refreshing user data...');
      localStorage.removeItem('user'); // Clear cached data
      const response = await authAPI.getCurrentUser();
      const freshUser = response.data.user;
      setUser(freshUser);
      localStorage.setItem('user', JSON.stringify(freshUser));
      console.log('✅ User data refreshed successfully');
    } catch (error) {
      console.error('❌ Failed to refresh user data:', error);
    }
  };

  const refreshTokenAndUserData = async () => {
    try {
      console.log('🔄 Refreshing token and user data to sync church ID...');
      // First refresh the token to get updated church ID in JWT
      await authAPI.refreshToken();
      console.log('✅ Token refreshed');
      
      // Then refresh the user data to get latest church_id
      await refreshUserData();
      console.log('✅ Token and user data refreshed successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to refresh token and user data:', error);
      return false;
    }
  };

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    needsOnboarding,
    login,
    logout,
    updateUser,
    refreshOnboardingStatus,
    refreshUserData,
    refreshTokenAndUserData,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}; 