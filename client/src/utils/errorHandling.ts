/**
 * Shared error handling utilities for consistent error management
 */
import { ERROR_MESSAGES } from './constants';

export interface ApiError {
  response?: {
    data?: {
      error?: string;
      message?: string;
      details?: any;
    };
    status?: number;
  };
  message?: string;
  code?: string;
}

export interface ErrorResult {
  message: string;
  type: 'network' | 'validation' | 'permission' | 'server' | 'unknown';
  details?: any;
}

/**
 * Standardizes error handling across the application
 */
export const handleApiError = (error: ApiError): ErrorResult => {
  // Network errors
  if (!error.response) {
    return {
      message: ERROR_MESSAGES.NETWORK_ERROR,
      type: 'network'
    };
  }

  const { status, data } = error.response;
  
  // Permission errors
  if (status === 403 || status === 401) {
    return {
      message: ERROR_MESSAGES.PERMISSION_DENIED,
      type: 'permission'
    };
  }
  
  // Validation errors
  if (status === 400) {
    const message = data?.error || data?.message || ERROR_MESSAGES.VALIDATION_FAILED;
    return {
      message,
      type: 'validation',
      details: data?.details
    };
  }
  
  // Server errors
  if (status && status >= 500) {
    return {
      message: data?.error || 'Server error occurred. Please try again later.',
      type: 'server'
    };
  }
  
  // Other errors
  return {
    message: data?.error || data?.message || error.message || ERROR_MESSAGES.OPERATION_FAILED,
    type: 'unknown'
  };
};

/**
 * Creates a user-friendly error message for display
 */
export const getDisplayError = (error: ApiError): string => {
  const errorResult = handleApiError(error);
  return errorResult.message;
};

/**
 * Logs errors consistently for debugging
 */
export const logError = (
  context: string,
  error: ApiError,
  additionalInfo?: any
): void => {
  const errorResult = handleApiError(error);
  
  console.group(`🚨 Error in ${context}`);
  console.error('Error type:', errorResult.type);
  console.error('Message:', errorResult.message);
  console.error('Original error:', error);
  
  if (errorResult.details) {
    console.error('Details:', errorResult.details);
  }
  
  if (additionalInfo) {
    console.error('Additional info:', additionalInfo);
  }
  
  console.groupEnd();
};

/**
 * Hook for consistent error handling in components
 */
export const useErrorHandler = () => {
  const handleError = (context: string, error: ApiError, additionalInfo?: any): string => {
    logError(context, error, additionalInfo);
    return getDisplayError(error);
  };

  return { handleError };
};

/**
 * Validation error formatter
 */
export const formatValidationErrors = (errors: string[]): string => {
  if (errors.length === 0) return '';
  if (errors.length === 1) return errors[0];
  
  return `Multiple errors: ${errors.join(', ')}`;
};

/**
 * Retry utility for handling transient errors
 */
export const withRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> => {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      // Don't retry on validation or permission errors
      const errorResult = handleApiError(error as ApiError);
      if (errorResult.type === 'validation' || errorResult.type === 'permission') {
        throw error;
      }
      
      // Don't retry on the last attempt
      if (attempt === maxRetries) {
        break;
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
  
  throw lastError;
};

/**
 * Graceful degradation for non-critical operations
 */
export const safeExecute = async <T>(
  operation: () => Promise<T>,
  fallback?: T,
  context?: string
): Promise<T | undefined> => {
  try {
    return await operation();
  } catch (error) {
    if (context) {
      logError(`Safe execution in ${context}`, error as ApiError);
    }
    return fallback;
  }
};

/**
 * Batch error handling for multiple operations
 */
export const handleBatchErrors = (
  results: Array<{ success: boolean; error?: ApiError; data?: any }>
): {
  successCount: number;
  errorCount: number;
  errors: ErrorResult[];
  hasPermissionError: boolean;
} => {
  const errors: ErrorResult[] = [];
  let successCount = 0;
  let hasPermissionError = false;
  
  results.forEach(result => {
    if (result.success) {
      successCount++;
    } else if (result.error) {
      const errorResult = handleApiError(result.error);
      errors.push(errorResult);
      
      if (errorResult.type === 'permission') {
        hasPermissionError = true;
      }
    }
  });
  
  return {
    successCount,
    errorCount: errors.length,
    errors,
    hasPermissionError
  };
};
