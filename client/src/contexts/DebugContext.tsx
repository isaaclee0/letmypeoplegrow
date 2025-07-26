import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface DebugLog {
  id: string;
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  category: string;
  message: string;
  data?: any;
}

interface DebugContextType {
  isDebugMode: boolean;
  toggleDebugMode: () => void;
  logs: DebugLog[];
  addLog: (level: DebugLog['level'], category: string, message: string, data?: any) => void;
  clearLogs: () => void;
  getLogsByCategory: (category: string) => DebugLog[];
}

const DebugContext = createContext<DebugContextType | undefined>(undefined);

export const useDebug = () => {
  const context = useContext(DebugContext);
  if (!context) {
    throw new Error('useDebug must be used within a DebugProvider');
  }
  return context;
};

interface DebugProviderProps {
  children: ReactNode;
}

export const DebugProvider: React.FC<DebugProviderProps> = ({ children }) => {
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [logs, setLogs] = useState<DebugLog[]>([]);

  const toggleDebugMode = useCallback(() => {
    setIsDebugMode(prev => !prev);
  }, []);

  const addLog = useCallback((level: DebugLog['level'], category: string, message: string, data?: any) => {
    const newLog: DebugLog = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      timestamp: new Date(),
      level,
      category,
      message,
      data
    };

    setLogs(prev => [...prev, newLog]);

    // Also log to console for development
    if (process.env.NODE_ENV === 'development') {
      const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[consoleMethod](`[${category}] ${message}`, data || '');
    }
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  const getLogsByCategory = useCallback((category: string) => {
    return logs.filter(log => log.category === category);
  }, [logs]);

  const value: DebugContextType = {
    isDebugMode,
    toggleDebugMode,
    logs,
    addLog,
    clearLogs,
    getLogsByCategory
  };

  return (
    <DebugContext.Provider value={value}>
      {children}
    </DebugContext.Provider>
  );
}; 