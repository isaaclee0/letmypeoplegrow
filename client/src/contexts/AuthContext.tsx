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

  useEffect(() => {
    const initializeAuth = async () => {
      // Prevent multiple simultaneous initialization calls
      if (isInitializing.current) {
        return;
      }
      
      isInitializing.current = true;

      try {
        // Add a small delay for iOS Safari to ensure cookies are properly set
        if (navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome')) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Always try to get current user from backend (in case user is logged in via cookies)
        const response = await authAPI.getCurrentUser();
        setUser(response.data.user);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        
        // Start periodic token refresh for authenticated users
        startTokenRefresh();
        
        // Check onboarding status for admin users
        if (response.data.user.role === 'admin') {
          try {
            const onboardingResponse = await onboardingAPI.getStatus();
            setNeedsOnboarding(!onboardingResponse.data.completed);
          } catch (onboardingError) {
            console.error('Failed to check onboarding status:', onboardingError);
          }
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
        // User is not authenticated, clear any stale localStorage
        localStorage.removeItem('user');
        setUser(null);
      } finally {
        setIsLoading(false);
        isInitializing.current = false;
      }
    };

    initializeAuth();
    
    // Cleanup function to stop token refresh interval
    return () => {
      stopTokenRefresh();
    };
  }, []);

  const login = async (token: string, userData: User) => {
    // Token is now handled by cookies, only store user data locally
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(userData);
    
    // Start periodic token refresh (every 25 days to refresh before 30d expiry)
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
      setUser(updatedUser);
      localStorage.setItem('user', JSON.stringify(updatedUser));
    }
  };

  const startTokenRefresh = () => {
    // Clear any existing interval
    if (refreshInterval.current) {
      clearInterval(refreshInterval.current);
    }
    
    // Refresh token every 25 days (25 * 24 * 60 * 60 * 1000 milliseconds)
    // This ensures we refresh before the 30-day expiry
    const intervalMs = 25 * 24 * 60 * 60 * 1000; // 25 days
    
    refreshInterval.current = setInterval(async () => {
      // Prevent concurrent refresh attempts
      if (isRefreshing.current) {
        return;
      }
      
      isRefreshing.current = true;
      
      try {
        await authAPI.refreshToken();
        console.log('Scheduled token refresh completed successfully');
      } catch (error) {
        console.error('Scheduled token refresh failed:', error);
        
        // If refresh fails, clear user and redirect to login
        localStorage.removeItem('user');
        setUser(null);
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
        }
      } finally {
        isRefreshing.current = false;
      }
    }, intervalMs);
  };

  const stopTokenRefresh = () => {
    if (refreshInterval.current) {
      clearInterval(refreshInterval.current);
      refreshInterval.current = null;
    }
    isRefreshing.current = false;
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
    // Prevent concurrent refresh attempts
    if (isRefreshing.current) {
      console.log('Manual token refresh skipped - refresh already in progress');
      return;
    }

    isRefreshing.current = true;
    
    try {
      console.log('Manual token refresh initiated...');
      await authAPI.refreshToken();
      console.log('Manual token refresh successful');
    } catch (error) {
      console.error('Manual token refresh failed:', error);
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