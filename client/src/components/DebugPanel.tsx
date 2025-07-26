import React, { useState } from 'react';
import { useDebug, DebugLog } from '../contexts/DebugContext';
import {
  BugAntIcon,
  XMarkIcon,
  TrashIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  InformationCircleIcon,
  ExclamationTriangleIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline';

const DebugPanel: React.FC = () => {
  const { isDebugMode, logs, clearLogs, getLogsByCategory } = useDebug();
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  if (!isDebugMode) return null;

  const categories = ['all', ...Array.from(new Set(logs.map(log => log.category)))];
  const filteredLogs = selectedCategory === 'all' 
    ? logs 
    : getLogsByCategory(selectedCategory);

  const getLogIcon = (level: DebugLog['level']) => {
    switch (level) {
      case 'error':
        return <ExclamationCircleIcon className="h-4 w-4 text-red-500" />;
      case 'warn':
        return <ExclamationTriangleIcon className="h-4 w-4 text-yellow-500" />;
      case 'info':
        return <InformationCircleIcon className="h-4 w-4 text-blue-500" />;
      default:
        return <BugAntIcon className="h-4 w-4 text-gray-500" />;
    }
  };

  const getLogColor = (level: DebugLog['level']) => {
    switch (level) {
      case 'error':
        return 'bg-red-50 border-red-200';
      case 'warn':
        return 'bg-yellow-50 border-yellow-200';
      case 'info':
        return 'bg-blue-50 border-blue-200';
      default:
        return 'bg-gray-50 border-gray-200';
    }
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-lg z-50">
      {/* Header */}
      <div className="flex items-center justify-between p-3 bg-gray-100 border-b border-gray-200">
        <div className="flex items-center space-x-2">
          <BugAntIcon className="h-5 w-5 text-gray-600" />
          <span className="font-medium text-gray-700">Debug Panel</span>
          <span className="text-sm text-gray-500">({logs.length} logs)</span>
        </div>
        
        <div className="flex items-center space-x-2">
          {/* Category Filter */}
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="text-sm border border-gray-300 rounded px-2 py-1"
          >
            {categories.map(category => (
              <option key={category} value={category}>
                {category === 'all' ? 'All Categories' : category}
              </option>
            ))}
          </select>
          
          <button
            onClick={clearLogs}
            className="p-1 text-gray-500 hover:text-red-600 transition-colors"
            title="Clear logs"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
          
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 text-gray-500 hover:text-gray-700 transition-colors"
          >
            {isExpanded ? (
              <ChevronDownIcon className="h-4 w-4" />
            ) : (
              <ChevronUpIcon className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Logs */}
      {isExpanded && (
        <div className="max-h-96 overflow-y-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-4 text-center text-gray-500">
              No logs to display
            </div>
          ) : (
            <div className="space-y-1 p-2">
              {filteredLogs.map((log) => (
                <div
                  key={log.id}
                  className={`p-3 rounded border ${getLogColor(log.level)}`}
                >
                  <div className="flex items-start space-x-2">
                    {getLogIcon(log.level)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-700">
                          {log.category}
                        </span>
                        <span className="text-xs text-gray-500">
                          {log.timestamp.toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">{log.message}</p>
                      {log.data && (
                        <details className="mt-2">
                          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                            View Data
                          </summary>
                          <pre className="text-xs bg-gray-100 p-2 rounded mt-1 overflow-x-auto">
                            {JSON.stringify(log.data, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DebugPanel; 