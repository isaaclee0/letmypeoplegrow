/**
 * Performance optimization utilities for large datasets and bulk operations
 */
import { useCallback, useMemo, useRef, useEffect, useState } from 'react';

/**
 * Debounce utility with cleanup
 */
export const debounce = <T extends (...args: any[]) => any>(
  func: T,
  wait: number
): T & { cancel: () => void } => {
  let timeoutId: NodeJS.Timeout | null = null;
  
  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    
    timeoutId = setTimeout(() => {
      func(...args);
    }, wait);
  }) as T & { cancel: () => void };
  
  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  
  return debounced;
};

/**
 * Throttle utility for limiting function calls
 */
export const throttle = <T extends (...args: any[]) => any>(
  func: T,
  limit: number
): T => {
  let inThrottle: boolean;
  return ((...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  }) as T;
};

/**
 * Virtual scrolling hook for large lists
 */
export const useVirtualScrolling = <T>(
  items: T[],
  itemHeight: number,
  containerHeight: number,
  overscan: number = 5
) => {
  const scrollTop = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const visibleRange = useMemo(() => {
    const startIndex = Math.floor(scrollTop.current / itemHeight);
    const endIndex = Math.min(
      startIndex + Math.ceil(containerHeight / itemHeight),
      items.length - 1
    );
    
    return {
      start: Math.max(0, startIndex - overscan),
      end: Math.min(items.length - 1, endIndex + overscan)
    };
  }, [items.length, itemHeight, containerHeight, overscan]);
  
  const visibleItems = useMemo(() => {
    return items.slice(visibleRange.start, visibleRange.end + 1);
  }, [items, visibleRange]);
  
  const totalHeight = items.length * itemHeight;
  const offsetY = visibleRange.start * itemHeight;
  
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    scrollTop.current = event.currentTarget.scrollTop;
  }, []);
  
  return {
    containerRef,
    visibleItems,
    totalHeight,
    offsetY,
    handleScroll,
    visibleRange
  };
};

/**
 * Pagination hook for large datasets
 */
export const usePagination = <T>(
  items: T[],
  itemsPerPage: number = 50
) => {
  const [currentPage, setCurrentPage] = useState(1);
  
  const totalPages = Math.ceil(items.length / itemsPerPage);
  
  const paginatedItems = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return items.slice(startIndex, endIndex);
  }, [items, currentPage, itemsPerPage]);
  
  const goToPage = useCallback((page: number) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  }, [totalPages]);
  
  const nextPage = useCallback(() => {
    if (currentPage < totalPages) {
      setCurrentPage(prev => prev + 1);
    }
  }, [currentPage, totalPages]);
  
  const prevPage = useCallback(() => {
    if (currentPage > 1) {
      setCurrentPage(prev => prev - 1);
    }
  }, [currentPage]);
  
  return {
    currentPage,
    totalPages,
    paginatedItems,
    goToPage,
    nextPage,
    prevPage,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1
  };
};

/**
 * Memoized search and filter hook
 */
export const useOptimizedSearch = <T>(
  items: T[],
  searchFields: (keyof T)[],
  initialSearchTerm: string = ''
) => {
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm);
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState(initialSearchTerm);
  
  // Debounce search term updates
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 300);
    
    return () => clearTimeout(timer);
  }, [searchTerm]);
  
  const filteredItems = useMemo(() => {
    if (!debouncedSearchTerm.trim()) {
      return items;
    }
    
    const searchLower = debouncedSearchTerm.toLowerCase();
    
    return items.filter(item => {
      return searchFields.some(field => {
        const value = item[field];
        if (typeof value === 'string') {
          return value.toLowerCase().includes(searchLower);
        }
        if (typeof value === 'number') {
          return value.toString().includes(searchLower);
        }
        return false;
      });
    });
  }, [items, debouncedSearchTerm, searchFields]);
  
  return {
    searchTerm,
    setSearchTerm,
    filteredItems,
    isSearching: searchTerm !== debouncedSearchTerm
  };
};

/**
 * Batch operation hook for handling large operations
 */
export const useBatchOperation = <T, R>(
  batchSize: number = 10,
  delayBetweenBatches: number = 100
) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [results, setResults] = useState<R[]>([]);
  const [errors, setErrors] = useState<Error[]>([]);
  
  const executeBatch = useCallback(async (
    items: T[],
    operation: (item: T) => Promise<R>,
    onProgress?: (current: number, total: number) => void
  ) => {
    setIsProcessing(true);
    setProgress({ current: 0, total: items.length });
    setResults([]);
    setErrors([]);
    
    const batchResults: R[] = [];
    const batchErrors: Error[] = [];
    
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (item, index) => {
        try {
          const result = await operation(item);
          batchResults.push(result);
          return { success: true, result, index: i + index };
        } catch (error) {
          batchErrors.push(error as Error);
          return { success: false, error, index: i + index };
        }
      });
      
      await Promise.all(batchPromises);
      
      const currentProgress = Math.min(i + batchSize, items.length);
      setProgress({ current: currentProgress, total: items.length });
      
      if (onProgress) {
        onProgress(currentProgress, items.length);
      }
      
      // Delay between batches to prevent overwhelming the system
      if (i + batchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }
    
    setResults(batchResults);
    setErrors(batchErrors);
    setIsProcessing(false);
    
    return {
      results: batchResults,
      errors: batchErrors,
      successCount: batchResults.length,
      errorCount: batchErrors.length
    };
  }, [batchSize, delayBetweenBatches]);
  
  return {
    executeBatch,
    isProcessing,
    progress,
    results,
    errors
  };
};

/**
 * Memory-efficient grouping for large datasets
 */
export const useOptimizedGrouping = <T, K extends string | number>(
  items: T[],
  getGroupKey: (item: T) => K,
  sortGroupsBy?: (a: [K, T[]], b: [K, T[]]) => number
) => {
  return useMemo(() => {
    const groups = new Map<K, T[]>();
    
    // Group items efficiently
    items.forEach(item => {
      const key = getGroupKey(item);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(item);
    });
    
    // Convert to array and sort if needed
    let groupArray = Array.from(groups.entries());
    
    if (sortGroupsBy) {
      groupArray.sort(sortGroupsBy);
    }
    
    return groupArray;
  }, [items, getGroupKey, sortGroupsBy]);
};

/**
 * Intersection Observer hook for lazy loading
 */
export const useIntersectionObserver = (
  callback: () => void,
  options: IntersectionObserverInit = {}
) => {
  const targetRef = useRef<HTMLElement>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  
  useEffect(() => {
    if (!targetRef.current) return;
    
    observerRef.current = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        callback();
      }
    }, options);
    
    observerRef.current.observe(targetRef.current);
    
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [callback, options]);
  
  return targetRef;
};

/**
 * Performance monitoring hook
 */
export const usePerformanceMonitor = (componentName: string) => {
  const renderStartTime = useRef<number>(Date.now());
  const renderCount = useRef<number>(0);
  
  useEffect(() => {
    renderCount.current += 1;
    const renderTime = Date.now() - renderStartTime.current;
    
    if (process.env.NODE_ENV === 'development') {
      console.log(`🔍 ${componentName} - Render #${renderCount.current} took ${renderTime}ms`);
    }
    
    renderStartTime.current = Date.now();
  });
  
  const logPerformance = useCallback((operation: string, startTime: number) => {
    const duration = Date.now() - startTime;
    if (process.env.NODE_ENV === 'development') {
      console.log(`⚡ ${componentName} - ${operation} took ${duration}ms`);
    }
  }, [componentName]);
  
  return { logPerformance };
};


