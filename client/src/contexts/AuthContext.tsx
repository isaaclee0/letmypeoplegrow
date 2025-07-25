import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
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

  useEffect(() => {
    const initializeAuth = async () => {
      const storedUser = localStorage.getItem('user');

      try {
        // Always try to get current user from backend (in case user is logged in via cookies)
        const response = await authAPI.getCurrentUser();
        setUser(response.data.user);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        
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
        // User is not authenticated, clear any stale localStorage
        localStorage.removeItem('user');
        setUser(null);
      }
      
      setIsLoading(false);
    };

    initializeAuth();
  }, []);

  const login = async (token: string, userData: User) => {
    // Token is now handled by cookies, only store user data locally
    localStorage.setItem('user', JSON.stringify(userData));
    setUser(userData);
    
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

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated: !!user,
    needsOnboarding,
    login,
    logout,
    updateUser,
    refreshOnboardingStatus,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}; 