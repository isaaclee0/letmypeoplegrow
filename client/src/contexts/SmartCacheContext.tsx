import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface CacheStrategy {
  name: string;
  maxAge: number; // in milliseconds
  staleWhileRevalidate: boolean;
  priority: 'high' | 'medium' | 'low';
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  strategy: CacheStrategy;
  isStale: boolean;
}

interface SmartCacheContextType {
  getCachedData: <T>(key: string) => CacheEntry<T> | null;
  setCachedData: <T>(key: string, data: T, strategy: CacheStrategy) => void;
  invalidateCache: (key: string) => void;
  clearAllCache: () => void;
  getCacheStats: () => { totalEntries: number; staleEntries: number; memoryUsage: string };
}

const SmartCacheContext = createContext<SmartCacheContextType | undefined>(undefined);

// Predefined cache strategies
export const CACHE_STRATEGIES = {
  // Static content that rarely changes (logos, icons, etc.)
  STATIC: {
    name: 'static',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    staleWhileRevalidate: true,
    priority: 'high' as const
  },
  
  // User preferences and settings
  USER_PREFERENCES: {
    name: 'user-preferences',
    maxAge: 60 * 60 * 1000, // 1 hour
    staleWhileRevalidate: true,
    priority: 'medium' as const
  },
  
  // Dynamic content that changes frequently (attendance data, etc.)
  DYNAMIC: {
    name: 'dynamic',
    maxAge: 5 * 60 * 1000, // 5 minutes
    staleWhileRevalidate: false,
    priority: 'low' as const
  },
  
  // Navigation and UI state
  NAVIGATION: {
    name: 'navigation',
    maxAge: 30 * 60 * 1000, // 30 minutes
    staleWhileRevalidate: true,
    priority: 'high' as const
  }
};

export const SmartCacheProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [cache, setCache] = useState<Map<string, CacheEntry<any>>>(new Map());

  // Clean up stale entries periodically
  useEffect(() => {
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      setCache(prevCache => {
        const newCache = new Map(prevCache);
        let removedCount = 0;
        
        for (const [key, entry] of newCache.entries()) {
          if (now - entry.timestamp > entry.strategy.maxAge) {
            newCache.delete(key);
            removedCount++;
          } else {
            // Mark as stale if past maxAge but still within staleWhileRevalidate
            entry.isStale = now - entry.timestamp > entry.strategy.maxAge;
          }
        }
        
        if (removedCount > 0) {
          console.log(`🧹 Cleaned up ${removedCount} stale cache entries`);
        }
        
        return newCache;
      });
    }, 60000); // Clean up every minute

    return () => clearInterval(cleanupInterval);
  }, []);

  const getCachedData = <T,>(key: string, allowStale: boolean = false): CacheEntry<T> | null => {
    const entry = cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    const age = now - entry.timestamp;

    // If data is expired and no stale-while-revalidate, return null (unless allowStale is true)
    if (age > entry.strategy.maxAge && !entry.strategy.staleWhileRevalidate && !allowStale) {
      cache.delete(key);
      return null;
    }

    // Mark as stale if past maxAge
    if (age > entry.strategy.maxAge) {
      entry.isStale = true;
    }

    return entry;
  };

  const setCachedData = <T,>(key: string, data: T, strategy: CacheStrategy): void => {
    const entry: CacheEntry<T> = {
      data,
      timestamp: Date.now(),
      strategy,
      isStale: false
    };
    
    setCache(prevCache => {
      const newCache = new Map(prevCache);
      newCache.set(key, entry);
      return newCache;
    });
    
    console.log(`💾 Cached data for key "${key}" with strategy "${strategy.name}"`);
  };

  const invalidateCache = (key: string): void => {
    setCache(prevCache => {
      const newCache = new Map(prevCache);
      newCache.delete(key);
      return newCache;
    });
    console.log(`🗑️ Invalidated cache for key "${key}"`);
  };

  const clearAllCache = (): void => {
    setCache(new Map());
    console.log('🧹 Cleared all cache');
  };

  const getCacheStats = () => {
    const totalEntries = cache.size;
    const staleEntries = Array.from(cache.values()).filter(entry => entry.isStale).length;
    
    // Estimate memory usage (rough calculation)
    const memoryUsage = `${Math.round(JSON.stringify(Array.from(cache.entries())).length / 1024)}KB`;
    
    return { totalEntries, staleEntries, memoryUsage };
  };

  const value: SmartCacheContextType = {
    getCachedData,
    setCachedData,
    invalidateCache,
    clearAllCache,
    getCacheStats
  };

  return (
    <SmartCacheContext.Provider value={value}>
      {children}
    </SmartCacheContext.Provider>
  );
};

export const useSmartCache = (): SmartCacheContextType => {
  const context = useContext(SmartCacheContext);
  if (context === undefined) {
    throw new Error('useSmartCache must be used within a SmartCacheProvider');
  }
  return context;
};
