import { useSmartCache, CACHE_STRATEGIES } from '../contexts/SmartCacheContext';
import { useState, useEffect, useCallback } from 'react';

// Hook for caching API responses with smart strategies
export const useCachedAPI = <T>(
  key: string,
  fetchFn: () => Promise<T>,
  strategy = CACHE_STRATEGIES.DYNAMIC,
  dependencies: any[] = []
) => {
  const smartCache = useSmartCache();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    // Check cache first
    const cachedEntry = smartCache.getCachedData<T>(key);
    
    if (cachedEntry && !cachedEntry.isStale) {
      console.log(`📦 Using cached data for ${key}`);
      setData(cachedEntry.data);
      setLoading(false);
      setError(null);
      
      // If stale but has stale-while-revalidate, update in background
      if (cachedEntry.isStale && cachedEntry.strategy.staleWhileRevalidate) {
        console.log(`🔄 Updating stale data in background for ${key}`);
        try {
          const freshData = await fetchFn();
          smartCache.setCachedData(key, freshData, strategy);
          setData(freshData);
        } catch (err) {
          console.warn(`Failed to update stale data for ${key}:`, err);
        }
      }
      return;
    }

    // Fetch fresh data
    setLoading(true);
    setError(null);
    
    try {
      console.log(`🌐 Fetching fresh data for ${key}`);
      const freshData = await fetchFn();
      smartCache.setCachedData(key, freshData, strategy);
      setData(freshData);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      setError(error);
      console.error(`Failed to fetch data for ${key}:`, error);
    } finally {
      setLoading(false);
    }
  }, [key, fetchFn, strategy, smartCache, ...dependencies]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const refetch = useCallback(() => {
    smartCache.invalidateCache(key);
    fetchData();
  }, [key, fetchData, smartCache]);

  return {
    data,
    loading,
    error,
    refetch,
    isStale: smartCache.getCachedData(key)?.isStale || false
  };
};

// Hook for caching static data (logos, settings, etc.)
export const useStaticCache = <T>(
  key: string,
  fetchFn: () => Promise<T>,
  dependencies: any[] = []
) => {
  return useCachedAPI(key, fetchFn, CACHE_STRATEGIES.STATIC, dependencies);
};

// Hook for caching user preferences
export const usePreferencesCache = <T>(
  key: string,
  fetchFn: () => Promise<T>,
  dependencies: any[] = []
) => {
  return useCachedAPI(key, fetchFn, CACHE_STRATEGIES.USER_PREFERENCES, dependencies);
};

// Example usage:
/*
// In a component:
const { data: userSettings, loading } = usePreferencesCache(
  'user-settings',
  () => api.getUserSettings(),
  [userId]
);

const { data: logos, loading: logosLoading } = useStaticCache(
  'church-logos',
  () => api.getChurchLogos()
);

const { data: attendance, loading: attendanceLoading, refetch } = useCachedAPI(
  `attendance-${gatheringId}-${date}`,
  () => api.getAttendance(gatheringId, date),
  CACHE_STRATEGIES.DYNAMIC,
  [gatheringId, date]
);
*/
