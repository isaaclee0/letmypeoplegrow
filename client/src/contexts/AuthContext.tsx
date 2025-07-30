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
  manualRefreshToken: () => Promise<void>;
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
  const refreshInterval = useRef<NodeJS.Timeout | null>(null);
  const isRefreshing = useRef(false);
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
        // Validate localStorage data first
        const storedUser = localStorage.getItem('user');
        if (storedUser) {
          try {
            JSON.parse(storedUser); // Validate JSON
            console.log('✅ Valid localStorage user data found');
          } catch (e) {
            console.warn('⚠️ Invalid localStorage user data, clearing');
            localStorage.removeItem('user');
          }
        }
        
        const isSafari = navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome');
        let attempts = 3;
        
        while (attempts > 0) {
          if (isSafari) {
            console.log('🦸 Safari detected, adding 200ms delay');
            await new Promise(resolve => setTimeout(resolve, 200)); // Increased from 100ms
          }
          
          try {
            console.log('🚀 Fetching current user, attempt', 4 - attempts);
            const response = await authAPI.getCurrentUser();
            const newUser = response.data.user;
            
            // Only update state if the new user data differs to prevent unnecessary re-renders
            setUser(prev => JSON.stringify(prev) !== JSON.stringify(newUser) ? newUser : prev);
            localStorage.setItem('user', JSON.stringify(newUser));
            console.log('✅ Got user:', newUser.email);
            
            startTokenRefresh();
            
            if (newUser.role === 'admin') {
              const onboardingResponse = await onboardingAPI.getStatus();
              setNeedsOnboarding(prev => prev !== !onboardingResponse.data.completed ? !onboardingResponse.data.completed : prev);
            }
            return; // Success, exit loop
          } catch (error) {
            attempts--;
            if (attempts === 0) throw error;
            console.warn('⚠️ Retry failed, attempts remaining:', attempts);
          }
        }
      } catch (error) {
        console.error('💥 Auth initialization failed:', error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : '');
        localStorage.removeItem('user');
        setUser(null);
      } finally {
        setIsLoading(false);
        isInitializing.current = false;
        console.log('🏁 initializeAuth completed at', new Date().toISOString());
      }
    };

    console.log('🎬 AuthContext: useEffect triggered');
    initializeAuth();
    
    // Cleanup function to stop token refresh interval
    return () => {
      console.log('🧹 AuthContext: useEffect cleanup called');
      stopTokenRefresh();
    };
  }, []);

  const login = async (token: string, userData: User) => {
    console.log('🔐 AuthContext: login() called for user:', userData.email);
    
    // Token is now handled by cookies, only store user data locally
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(prev => JSON.stringify(prev) !== JSON.stringify(userData) ? userData : prev);
    
    // Start periodic token refresh (every 25 days to refresh before 30d expiry)
    console.log('⏰ AuthContext: Starting token refresh after login');
    startTokenRefresh();
    
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
      stopTokenRefresh();
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

  const startTokenRefresh = () => {
    console.log('🔧 startTokenRefresh() called at', new Date().toISOString());
    console.log('🔧 Stack trace:', new Error().stack);
    
    if (refreshInterval.current) {
      console.log('⚠️ Clearing existing token refresh interval ID:', refreshInterval.current);
      clearInterval(refreshInterval.current);
    }
    
    // Refresh token every 25 days (25 * 24 * 60 * 60 * 1000 milliseconds)
    // This ensures we refresh before the 30-day expiry
    const intervalMs = 25 * 24 * 60 * 60 * 1000; // 25 days
    
    console.log(`⏰ Setting token refresh interval to ${intervalMs}ms (${intervalMs / (24 * 60 * 60 * 1000)} days)`);
    
    refreshInterval.current = setInterval(async () => {
      console.log('🕐 SCHEDULED token refresh timer triggered (25-day interval) at', new Date().toISOString());
      
      if (isRefreshing.current) {
        console.log('⚠️ Skipping scheduled refresh - already in progress');
        return;
      }
      
      isRefreshing.current = true;
      
      try {
        console.log('🔄 Executing SCHEDULED token refresh...');
        await authAPI.refreshToken();
        console.log('✅ Scheduled token refresh completed successfully');
      } catch (error) {
        console.error('💥 Scheduled token refresh failed:', error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : '');
        localStorage.removeItem('user');
        setUser(null);
        
        // Debounce redirects to prevent rapid redirects (5-second cooldown)
        const now = Date.now();
        if (window.location.pathname !== '/login' && now - lastRedirect.current > 5000) {
          lastRedirect.current = now;
          console.log('➡️ Redirecting to /login');
          window.location.href = '/login';
        } else {
          console.log('⚠️ Skipped redirect due to cooldown or already on /login');
        }
      } finally {
        isRefreshing.current = false;
      }
    }, intervalMs);
    
    console.log('✅ Token refresh interval created with ID:', refreshInterval.current);
  };

  const stopTokenRefresh = () => {
    if (refreshInterval.current) {
      console.log('🧹 Clearing token refresh interval ID:', refreshInterval.current);
      clearInterval(refreshInterval.current);
      refreshInterval.current = null;
    }
    isRefreshing.current = false;
    console.log('✅ Token refresh stopped');
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

  const manualRefreshToken = async () => {
    console.log('🔄 manualRefreshToken() called at', new Date().toISOString());
    console.log('🔧 Manual refresh stack trace:', new Error().stack);
    
    if (isRefreshing.current) {
      console.log('⚠️ Manual token refresh skipped - refresh already in progress');
      return;
    }

    isRefreshing.current = true;
    
    try {
      console.log('🚀 Manual token refresh initiated...');
      await authAPI.refreshToken();
      console.log('✅ Manual token refresh successful');
    } catch (error) {
      console.error('💥 Manual token refresh failed:', error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : '');
      
      // Debounce redirects (reuse redirect cooldown from startTokenRefresh)
      const now = Date.now();
      if (window.location.pathname !== '/login' && now - lastRedirect.current > 5000) {
        lastRedirect.current = now;
        console.log('➡️ Redirecting to /login');
        window.location.href = '/login';
      } else {
        console.log('⚠️ Skipped redirect due to cooldown or already on /login');
      }
      
      throw error;
    } finally {
      isRefreshing.current = false;
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
    manualRefreshToken,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}; 