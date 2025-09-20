import React from 'react';
import { useSmartCache } from '../contexts/SmartCacheContext';

export const CacheDebugPanel: React.FC = () => {
  const smartCache = useSmartCache();
  const stats = smartCache.getCacheStats();

  const handleClearCache = () => {
    smartCache.clearAllCache();
  };

  const handleTestStaticCache = () => {
    // Simulate caching some static data
    smartCache.setCachedData('test-static', { 
      timestamp: Date.now(),
      data: 'This is static data that will be cached for 24 hours'
    }, {
      name: 'test-static',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      staleWhileRevalidate: true,
      priority: 'high'
    });
  };

  const handleTestDynamicCache = () => {
    // Simulate caching some dynamic data
    smartCache.setCachedData('test-dynamic', { 
      timestamp: Date.now(),
      data: 'This is dynamic data that will be cached for 5 minutes'
    }, {
      name: 'test-dynamic',
      maxAge: 5 * 60 * 1000, // 5 minutes
      staleWhileRevalidate: false,
      priority: 'low'
    });
  };

  return (
    <div className="fixed bottom-4 right-4 bg-white rounded-lg shadow-lg p-4 max-w-sm z-50">
      <h3 className="font-semibold text-gray-800 mb-3">Cache Debug Panel</h3>
      
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span>Total Entries:</span>
          <span className="font-mono">{stats.totalEntries}</span>
        </div>
        <div className="flex justify-between">
          <span>Stale Entries:</span>
          <span className="font-mono text-orange-600">{stats.staleEntries}</span>
        </div>
        <div className="flex justify-between">
          <span>Memory Usage:</span>
          <span className="font-mono">{stats.memoryUsage}</span>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <button
          onClick={handleTestStaticCache}
          className="w-full px-3 py-1 bg-blue-100 text-blue-700 rounded text-sm hover:bg-blue-200"
        >
          Test Static Cache
        </button>
        <button
          onClick={handleTestDynamicCache}
          className="w-full px-3 py-1 bg-green-100 text-green-700 rounded text-sm hover:bg-green-200"
        >
          Test Dynamic Cache
        </button>
        <button
          onClick={handleClearCache}
          className="w-full px-3 py-1 bg-red-100 text-red-700 rounded text-sm hover:bg-red-200"
        >
          Clear All Cache
        </button>
      </div>
    </div>
  );
};
