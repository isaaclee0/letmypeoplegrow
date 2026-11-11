import { createContext } from 'react';
import type { User } from '../services/api';

export interface MyChurch {
  churchId: string;
  churchName: string;
}

export interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  needsOnboarding: boolean;
  myChurches: MyChurch[];
  login: (token: string, userData: User) => Promise<void>;
  logout: () => void;
  updateUser: (userData: Partial<User>) => void;
  refreshOnboardingStatus: (throwOnError?: boolean) => Promise<void>;
  refreshUserData: (throwOnError?: boolean) => Promise<void>;
  refreshTokenAndUserData: () => Promise<boolean>;
  switchChurch: (targetChurchId: string) => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);
