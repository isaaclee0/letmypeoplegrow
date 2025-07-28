import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { migrationsAPI } from '../services/api';
import { useAuth } from './AuthContext';

interface Migration {
  version: string;
  name: string;
  description: string;
  executed: boolean;
  executedAt?: string;
  status: 'pending' | 'success' | 'failed';
  errorMessage?: string;
}

interface MigrationStatus {
  migrations: Migration[];
  pendingCount: number;
  failedCount: number;
  hasPending: boolean;
  hasFailed: boolean;
}

interface MigrationContextType {
  migrationStatus: MigrationStatus | null;
  isLoading: boolean;
  error: string | null;
  refreshStatus: () => Promise<void>;
  runMigration: (version: string) => Promise<void>;
  runAllMigrations: () => Promise<any>;
}

const MigrationContext = createContext<MigrationContextType | undefined>(undefined);

export const useMigration = () => {
  const context = useContext(MigrationContext);
  if (context === undefined) {
    throw new Error('useMigration must be used within a MigrationProvider');
  }
  return context;
};

interface MigrationProviderProps {
  children: React.ReactNode;
}

export const MigrationProvider: React.FC<MigrationProviderProps> = ({ children }) => {
  const [migrationStatus, setMigrationStatus] = useState<MigrationStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  const fetchStatus = useCallback(async () => {
    if (!user || user.role !== 'admin') {
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const response = await migrationsAPI.getStatus();
      setMigrationStatus(response.data);
    } catch (err: any) {
      console.error('Failed to fetch migration status:', err);
      setError(err.response?.data?.error || 'Failed to fetch migration status');
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const refreshStatus = async () => {
    await fetchStatus();
  };

  const runMigration = async (version: string) => {
    try {
      setIsLoading(true);
      setError(null);
      await migrationsAPI.runMigration(version);
      await fetchStatus();
    } catch (err: any) {
      console.error('Failed to run migration:', err);
      setError(err.response?.data?.error || 'Failed to run migration');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const runAllMigrations = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await migrationsAPI.runAllMigrations();
      await fetchStatus();
      return response.data;
    } catch (err: any) {
      console.error('Failed to run all migrations:', err);
      setError(err.response?.data?.error || 'Failed to run migrations');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch status when user changes or on mount
  useEffect(() => {
    fetchStatus();
  }, [user, fetchStatus]);

  const value: MigrationContextType = {
    migrationStatus,
    isLoading,
    error,
    refreshStatus,
    runMigration,
    runAllMigrations,
  };

  return (
    <MigrationContext.Provider value={value}>
      {children}
    </MigrationContext.Provider>
  );
}; 