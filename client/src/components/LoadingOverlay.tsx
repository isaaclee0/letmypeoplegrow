import React, { useState, useEffect } from 'react';

interface LoadingOverlayProps {
  isLoading: boolean;
  message?: string;
  showProgress?: boolean;
  progress?: number;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({ 
  isLoading, 
  message = "Loading...", 
  showProgress = false,
  progress = 0 
}) => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (isLoading) {
      // Show overlay after a short delay to avoid flashing for quick loads
      const timer = setTimeout(() => setShow(true), 100);
      return () => clearTimeout(timer);
    } else {
      setShow(false);
    }
  }, [isLoading]);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-20 backdrop-blur-sm">
      <div className="bg-white rounded-lg shadow-lg p-6 max-w-sm w-full mx-4">
        <div className="flex items-center space-x-3">
          {/* Spinner */}
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
          
          {/* Content */}
          <div className="flex-1">
            <p className="text-gray-700 font-medium">{message}</p>
            
            {showProgress && (
              <div className="mt-2">
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                  ></div>
                </div>
                <p className="text-xs text-gray-500 mt-1">{Math.round(progress)}%</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Hook for managing loading state
export const useLoadingOverlay = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("Loading...");
  const [showProgress, setShowProgress] = useState(false);
  const [progress, setProgress] = useState(0);

  const showLoading = (loadingMessage?: string, withProgress = false) => {
    setMessage(loadingMessage || "Loading...");
    setShowProgress(withProgress);
    setProgress(0);
    setIsLoading(true);
  };

  const hideLoading = () => {
    setIsLoading(false);
    setShowProgress(false);
    setProgress(0);
  };

  const updateProgress = (newProgress: number) => {
    setProgress(newProgress);
  };

  return {
    isLoading,
    message,
    showProgress,
    progress,
    showLoading,
    hideLoading,
    updateProgress
  };
};
