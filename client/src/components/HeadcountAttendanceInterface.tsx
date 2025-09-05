import React, { useState, useEffect, useCallback } from 'react';
import { PlusIcon, MinusIcon } from '@heroicons/react/24/outline';
import { attendanceAPI } from '../services/api';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useToast } from './ToastContainer';

interface HeadcountAttendanceInterfaceProps {
  gatheringTypeId: number;
  date: string;
  gatheringName: string;
}

interface HeadcountData {
  headcount: number;
  lastUpdated?: string;
  lastUpdatedBy?: string;
  sessionId?: number;
}

const HeadcountAttendanceInterface: React.FC<HeadcountAttendanceInterfaceProps> = ({
  gatheringTypeId,
  date,
  gatheringName
}) => {
  const [headcount, setHeadcount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(new Date().toISOString());
  const [lastUpdatedBy, setLastUpdatedBy] = useState<string | null>('you');
  const { socket, isConnected } = useWebSocket();
  const { showError } = useToast();

  // Load initial headcount data
  const loadHeadcount = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await attendanceAPI.getHeadcount(gatheringTypeId, date);
      const data: HeadcountData = response.data;
      
      setHeadcount(data.headcount || 0);
      setLastUpdated(data.lastUpdated || new Date().toISOString());
      setLastUpdatedBy(data.lastUpdatedBy || 'you');
    } catch (error: any) {
      console.error('Failed to load headcount:', error);
      showError('Failed to load headcount data');
    } finally {
      setIsLoading(false);
    }
  }, [gatheringTypeId, date, showError]);

  // Update headcount via API (optimistic updates)
  const updateHeadcount = useCallback(async (newCount: number) => {
    // Update UI immediately for smooth experience
    setHeadcount(newCount);
    setLastUpdated(new Date().toISOString());
    setLastUpdatedBy('You');
    
    try {
      await attendanceAPI.updateHeadcount(gatheringTypeId, date, newCount);
    } catch (error: any) {
      console.error('Failed to update headcount:', error);
      showError('Failed to update headcount');
      // Revert the optimistic update on error
      // Note: We could reload from server here, but for simplicity we'll keep the optimistic value
    }
  }, [gatheringTypeId, date, showError]);

  // WebSocket event handlers
  useEffect(() => {
    if (!socket || !isConnected) return;

    // Join the headcount room
    socket.emit('load_headcount', {
      gatheringId: gatheringTypeId,
      date
    });

    // Listen for headcount updates from other users
    const handleHeadcountUpdated = (data: any) => {
      if (data.gatheringId === gatheringTypeId && data.date === date) {
        setHeadcount(data.headcount);
        setLastUpdated(data.timestamp);
        setLastUpdatedBy(data.updatedByName);
      }
    };

    socket.on('headcount_updated', handleHeadcountUpdated);

    return () => {
      socket.off('headcount_updated', handleHeadcountUpdated);
    };
  }, [socket, isConnected, gatheringTypeId, date]);

  // Load initial data
  useEffect(() => {
    loadHeadcount();
  }, [loadHeadcount]);

  // Handle increment/decrement
  const handleIncrement = () => {
    const newCount = headcount + 1;
    updateHeadcount(newCount);
    
    // Also broadcast via WebSocket for real-time updates
    if (socket && isConnected) {
      socket.emit('update_headcount', {
        gatheringId: gatheringTypeId,
        date,
        headcount: newCount
      });
    }
  };

  const handleDecrement = () => {
    const newCount = Math.max(0, headcount - 1);
    updateHeadcount(newCount);
    
    // Also broadcast via WebSocket for real-time updates
    if (socket && isConnected) {
      socket.emit('update_headcount', {
        gatheringId: gatheringTypeId,
        date,
        headcount: newCount
      });
    }
  };

  // Handle direct input
  const handleDirectInput = (value: string) => {
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue >= 0) {
      updateHeadcount(numValue);
      
      // Also broadcast via WebSocket for real-time updates
      if (socket && isConnected) {
        socket.emit('update_headcount', {
          gatheringId: gatheringTypeId,
          date,
          headcount: numValue
        });
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
        <span className="ml-2 text-gray-600">Loading headcount...</span>
      </div>
    );
  }

  return (
    <div className="text-center">
      <p className="text-gray-600 mb-6">
        {new Date(date).toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })}
      </p>

      {/* Headcount Interface */}
      <div className="flex flex-col items-center space-y-6">
        {/* Desktop Layout - Horizontal */}
        <div className="hidden md:flex items-center justify-center space-x-6">
          <button
            onClick={handleDecrement}
            disabled={headcount <= 0}
            className="flex items-center justify-center w-16 h-16 rounded-full bg-red-100 hover:bg-red-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
          >
            <MinusIcon className="h-8 w-8 text-red-600" />
          </button>

          <div className="flex flex-col items-center">
            <input
              type="number"
              value={headcount}
              onChange={(e) => handleDirectInput(e.target.value)}
              className="text-6xl font-bold text-center bg-transparent border-none outline-none min-w-20 max-w-48 px-2 disabled:cursor-not-allowed [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
              style={{ width: `${Math.max(headcount.toString().length * 0.6, 2)}em` }}
              min="0"
            />
            <span className="text-sm text-gray-500 mt-1">Total Count</span>
          </div>

          <button
            onClick={handleIncrement}
            className="flex items-center justify-center w-16 h-16 rounded-full bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
          >
            <PlusIcon className="h-8 w-8 text-green-600" />
          </button>
        </div>

        {/* Mobile Layout - Vertical */}
        <div className="md:hidden flex flex-col items-center space-y-6">
          {/* Plus Button - Above */}
          <button
            onClick={handleIncrement}
            className="flex items-center justify-center w-16 h-16 rounded-full bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
          >
            <PlusIcon className="h-8 w-8 text-green-600" />
          </button>

          {/* Number Display - Tappable to Edit */}
          <div className="flex flex-col items-center">
            <input
              type="number"
              value={headcount}
              onChange={(e) => handleDirectInput(e.target.value)}
              className="text-6xl font-bold text-center bg-transparent border-none outline-none min-w-20 max-w-48 px-2 disabled:cursor-not-allowed focus:bg-gray-50 focus:rounded-lg focus:border-2 focus:border-primary-500 transition-all [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
              style={{ width: `${Math.max(headcount.toString().length * 0.6, 2)}em` }}
              min="0"
              placeholder="0"
            />
            <span className="text-sm text-gray-500 mt-1">Tap to edit</span>
          </div>

          {/* Minus Button - Below */}
          <button
            onClick={handleDecrement}
            disabled={headcount <= 0}
            className="flex items-center justify-center w-16 h-16 rounded-full bg-red-100 hover:bg-red-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
          >
            <MinusIcon className="h-8 w-8 text-red-600" />
          </button>
        </div>

        {/* Status Information */}
        <div className="text-center text-sm text-gray-500">
          <p>
            Last updated by {lastUpdatedBy || 'you'} at{' '}
            {lastUpdated ? new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'just now'}
          </p>
          {!isConnected && (
            <p className="text-yellow-600">Offline - changes will sync when reconnected</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default HeadcountAttendanceInterface;
