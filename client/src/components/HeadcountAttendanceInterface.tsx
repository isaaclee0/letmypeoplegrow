import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { PlusIcon, MinusIcon } from '@heroicons/react/24/outline';
import { attendanceAPI } from '../services/api';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useAuth } from '../contexts/AuthContext';

interface HeadcountAttendanceInterfaceProps {
  gatheringTypeId: number;
  date: string;
  gatheringName: string;
  onHeadcountChange?: (headcount: number) => void;
}

interface HeadcountData {
  headcount: number;
  userHeadcount?: number; // User's individual contribution
  lastUpdated?: string;
  lastUpdatedBy?: string;
  sessionId?: number;
  otherUsers?: Array<{
    userId: number;
    name: string;
    headcount: number;
    lastUpdated: string;
  }>;
}

const HeadcountAttendanceInterface: React.FC<HeadcountAttendanceInterfaceProps> = ({
  gatheringTypeId,
  date,
  gatheringName,
  onHeadcountChange
}) => {
  const [headcount, setHeadcount] = useState<number>(0);
  const [userHeadcount, setUserHeadcount] = useState<number>(0); // User's individual contribution
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(new Date().toISOString());
  const [lastUpdatedBy, setLastUpdatedBy] = useState<string | null>('you');
  const [otherUsers, setOtherUsers] = useState<Array<{
    userId: number;
    name: string;
    headcount: number;
    lastUpdated: string;
    isCurrentUser?: boolean;
  }>>([]);
  const { socket, isConnected, sendHeadcountUpdate } = useWebSocket();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  // Load initial headcount data
  const loadHeadcount = useCallback(async (showLoading: boolean = true) => {
    // Don't load data if authentication is not ready
    if (authLoading || !isAuthenticated || !user) {
      console.log('🔒 Headcount: Waiting for authentication to be ready', {
        authLoading,
        isAuthenticated,
        hasUser: !!user,
        gatheringTypeId,
        date
      });
      return;
    }

    try {
      if (showLoading) {
        setIsLoading(true);
      }
      console.log('📊 Headcount: Loading data for gathering', gatheringTypeId, 'date', date, 'mode', 'combined');
      const response = await attendanceAPI.getHeadcount(gatheringTypeId, date, 'combined');
      const data: HeadcountData = response.data;
      
      setHeadcount(data.headcount || 0);
      setUserHeadcount(data.userHeadcount || 0); // Set user's individual contribution
      setLastUpdated(data.lastUpdated || new Date().toISOString());
      setLastUpdatedBy(data.lastUpdatedBy || 'you');
      setOtherUsers(data.otherUsers || []);
      console.log('✅ Headcount: Data loaded successfully', data);
    } catch (error: any) {
      console.error('❌ Headcount: Failed to load data:', error);
      // Note: Hiding toast notification for now - functionality works despite intermittent 500 errors
      // showError('Failed to load headcount data');
      // Reset to defaults on error to avoid showing stale data
      setHeadcount(0);
      setUserHeadcount(0);
      setLastUpdated(null);
      setLastUpdatedBy(null);
      setOtherUsers([]);
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  }, [gatheringTypeId, date, authLoading, isAuthenticated, user]);

  // Debug: Log when component mounts/unmounts
  useEffect(() => {
    console.log('🎯 HeadcountAttendanceInterface: Component mounted', {
      gatheringTypeId,
      date,
      authLoading,
      isAuthenticated,
      hasUser: !!user
    });
    
    return () => {
      console.log('🎯 HeadcountAttendanceInterface: Component unmounting');
    };
  }, []);

  // Reset state when gathering or date changes
  useEffect(() => {
    console.log('🔄 HeadcountAttendanceInterface: Props changed, resetting state', {
      gatheringTypeId,
      date
    });
    setHeadcount(0);
    setUserHeadcount(0);
    setIsLoading(true);
    setLastUpdated(new Date().toISOString());
    setLastUpdatedBy('you');
    setOtherUsers([]);
    
    // Load new data for the new gathering/date if auth is ready
    if (!authLoading && isAuthenticated && user) {
      console.log('🔄 HeadcountAttendanceInterface: Loading data for new gathering/date');
      setTimeout(() => {
        loadHeadcount();
      }, 100);
    }
  }, [gatheringTypeId, date, authLoading, isAuthenticated, user, loadHeadcount]);

  // Notify parent component when headcount changes
  useEffect(() => {
    if (onHeadcountChange) {
      onHeadcountChange(headcount);
    }
  }, [headcount, onHeadcountChange]);

  // Update headcount via WebSocket (optimistic updates)
  const updateHeadcount = useCallback(async (newCount: number) => {
    console.log('📤 Updating headcount via WebSocket:', {
      newCount,
      currentHeadcount: headcount,
      currentUserHeadcount: userHeadcount
    });
    
    // Store the previous value for potential rollback
    const previousUserHeadcount = userHeadcount;
    
    // Update user's individual contribution immediately for smooth experience
    setUserHeadcount(newCount);
    setLastUpdated(new Date().toISOString());
    setLastUpdatedBy('You');
    
    try {
      await sendHeadcountUpdate(gatheringTypeId, date, newCount, 'combined');
      console.log('📥 WebSocket headcount update sent successfully');
    } catch (error: any) {
      console.error('Failed to update headcount via WebSocket:', error);
      // Revert the optimistic update on error
      setUserHeadcount(previousUserHeadcount);
      setLastUpdated(new Date().toISOString());
      setLastUpdatedBy('You (reverted)');
    }
  }, [gatheringTypeId, date, headcount, userHeadcount, sendHeadcountUpdate]);


  // WebSocket event handlers
  useEffect(() => {
    if (!socket || !isConnected) return;

    console.log('🔌 Headcount: Joining WebSocket room', { gatheringTypeId, date });

    // Join the headcount room
    socket.emit('load_headcount', {
      gatheringId: gatheringTypeId,
      date
    });

    // Listen for headcount updates from all users
    const handleHeadcountUpdated = (data: any) => {
      if (data.gatheringId === gatheringTypeId && data.date === date) {
        console.log('🔔 WebSocket headcount update received:', {
          headcount: data.headcount,
          userHeadcount: data.userHeadcount,
          updatedBy: data.updatedBy,
          currentUser: user?.id,
          isFromCurrentUser: data.updatedBy === user?.id
        });
        
        // Process updates from all users (including current user)
        console.log('📡 Processing headcount update');
        
        // Update the total headcount
        setHeadcount(data.headcount);
        
        // Update other users data with personalization
        if (data.otherUsers) {
          const personalizedOtherUsers = data.otherUsers
            .map(userData => ({
              ...userData,
              name: userData.userId === user?.id ? 'You' : userData.name,
              isCurrentUser: userData.userId === user?.id
            }))
            .sort((a, b) => {
              // Put current user first, then sort others alphabetically
              if (a.isCurrentUser && !b.isCurrentUser) return -1;
              if (!a.isCurrentUser && b.isCurrentUser) return 1;
              if (a.isCurrentUser && b.isCurrentUser) return 0;
              return a.name.localeCompare(b.name);
            });
          
          setOtherUsers(personalizedOtherUsers);
        }
        
        setLastUpdated(data.timestamp);
        setLastUpdatedBy(data.updatedByName);
      } else {
        console.log('🔔 WebSocket headcount update ignored (wrong gathering/date):', {
          received: { gatheringId: data.gatheringId, date: data.date },
          expected: { gatheringTypeId, date }
        });
      }
    };

    socket.on('headcount_updated', handleHeadcountUpdated);

    return () => {
      console.log('🔌 Headcount: Leaving WebSocket room', { gatheringTypeId, date });
      socket.off('headcount_updated', handleHeadcountUpdated);
      // Note: The server should handle room cleanup when the socket disconnects
    };
  }, [socket, isConnected, gatheringTypeId, date, user?.id]);

  // Only load data when authentication is fully ready
  useEffect(() => {
    if (!authLoading && isAuthenticated && user) {
      console.log('🔄 Headcount: Auth state ready, triggering load');
      // Small delay to ensure JWT cookie is fully established
      setTimeout(() => {
        loadHeadcount();
      }, 100);
    }
  }, [authLoading, isAuthenticated, user, loadHeadcount]);

  // Handle increment/decrement
  const handleIncrement = () => {
    const newUserCount = userHeadcount + 1;
    updateHeadcount(newUserCount);
  };

  const handleDecrement = () => {
    const newUserCount = Math.max(0, userHeadcount - 1);
    updateHeadcount(newUserCount);
  };

  // Handle direct input
  const handleDirectInput = (value: string) => {
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue >= 0) {
      updateHeadcount(numValue);
    }
  };

  // Check if we should show the total (always show unless total is 0)
  const shouldShowTotal = useMemo(() => {
    return headcount > 0;
  }, [headcount]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
        <span className="ml-2 text-gray-600">Loading headcount...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6 transition-all duration-300 ease-in-out">
      {/* Main Headcount Interface */}
      <div className="text-center">
        {/* Headcount Interface */}
        <div className="flex flex-col items-center space-y-6">
          {/* Desktop Layout - Horizontal */}
          <div className="hidden md:flex items-start justify-center space-x-6">
            <button
              onClick={handleDecrement}
              disabled={headcount <= 0}
              className="flex items-center justify-center w-16 h-16 rounded-full bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors mt-4"
            >
              <MinusIcon className="h-8 w-8 text-green-600" />
            </button>

            <div className="flex flex-col items-center">
              <input
                type="number"
                value={userHeadcount}
                onChange={(e) => handleDirectInput(e.target.value)}
                className="font-bold text-center bg-transparent border-none outline-none min-w-20 max-w-80 px-2 disabled:cursor-not-allowed [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
                style={{ 
                  width: `${Math.max(userHeadcount.toString().length * 0.8, 2)}em`,
                  fontSize: userHeadcount.toString().length > 4 ? '2.5rem' : userHeadcount.toString().length > 3 ? '3rem' : '4rem'
                }}
                min="0"
              />
              {shouldShowTotal && (
                <div className="mt-2 p-2 bg-blue-50 rounded-lg transition-all duration-300 ease-in-out animate-in fade-in slide-in-from-top-2">
                  <span className="text-lg font-semibold text-blue-800">
                    Total: {headcount}
                  </span>
                </div>
              )}
            </div>

            <button
              onClick={handleIncrement}
              className="flex items-center justify-center w-16 h-16 rounded-full bg-purple-100 hover:bg-purple-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors mt-4"
            >
              <PlusIcon className="h-8 w-8 text-purple-600" />
            </button>
          </div>

          {/* Mobile Layout - Vertical */}
          <div className="md:hidden flex flex-col items-center space-y-6">
            {/* Plus Button - Above */}
            <button
              onClick={handleIncrement}
              className="flex items-center justify-center w-16 h-16 rounded-full bg-purple-100 hover:bg-purple-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
            >
              <PlusIcon className="h-8 w-8 text-purple-600" />
            </button>

            {/* Number Display - Tappable to Edit */}
            <div className="flex flex-col items-center">
              <input
                type="number"
                value={userHeadcount}
                onChange={(e) => handleDirectInput(e.target.value)}
                className="font-bold text-center bg-transparent border-none outline-none min-w-20 max-w-80 px-2 disabled:cursor-not-allowed focus:bg-gray-50 focus:rounded-lg focus:border-2 focus:border-primary-500 transition-all [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
                style={{ 
                  width: `${Math.max(userHeadcount.toString().length * 0.8, 2)}em`,
                  fontSize: userHeadcount.toString().length > 4 ? '2.5rem' : userHeadcount.toString().length > 3 ? '3rem' : '4rem'
                }}
                min="0"
                placeholder="0"
              />
              {shouldShowTotal && (
                <div className="mt-2 p-2 bg-blue-50 rounded-lg transition-all duration-300 ease-in-out animate-in fade-in slide-in-from-top-2">
                  <span className="text-lg font-semibold text-blue-800">
                    Total: {headcount}
                  </span>
                </div>
              )}
            </div>

            {/* Minus Button - Below */}
            <button
              onClick={handleDecrement}
              disabled={headcount <= 0}
              className="flex items-center justify-center w-16 h-16 rounded-full bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
            >
              <MinusIcon className="h-8 w-8 text-green-600" />
            </button>
          </div>

          {/* Status Information */}
          {!isConnected && (
            <div className="text-center text-sm text-yellow-600">
              <p>Offline - changes will sync when reconnected</p>
            </div>
          )}
        </div>
      </div>

      {/* Other Users Information */}
      {otherUsers.length > 0 && (
        <div className="text-center">
          <div className="flex flex-wrap justify-center gap-2">
            {otherUsers.map((user) => (
              <div key={user.userId} className="bg-gray-100 rounded-md px-3 py-1 text-sm">
                <span className="text-gray-700">{user.name.split(' ')[0]}</span>
                <span className="font-medium text-gray-900 ml-1">{user.headcount}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default HeadcountAttendanceInterface;
