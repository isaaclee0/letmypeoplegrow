import React, { useState, useEffect, useCallback, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { PlusIcon, MinusIcon, PencilIcon, CheckIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { attendanceAPI, type AttendanceSessionState } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

interface HeadcountAttendanceInterfaceProps {
  gatheringTypeId: number;
  date: string;
  gatheringName: string;
  onHeadcountChange?: (headcount: number) => void;
  onSessionStateChange?: (state: AttendanceSessionState) => void;
  isFullscreen?: boolean;
  onExitFullscreen?: () => void;
  // WebSocket props
  socket: any;
  isConnected: boolean;
  sendHeadcountUpdate: (gatheringId: number, date: string, headcount: number, mode?: string) => Promise<any>;
}

interface HeadcountData {
  headcount: number;
  userHeadcount?: number;
  lastUpdated?: string;
  lastUpdatedBy?: string;
  sessionId?: number;
  sessionState?: AttendanceSessionState;
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
  onHeadcountChange,
  onSessionStateChange,
  isFullscreen = false,
  onExitFullscreen,
  socket,
  isConnected,
  sendHeadcountUpdate
}) => {
  const [headcount, setHeadcount] = useState<number>(0);
  const [userHeadcount, setUserHeadcount] = useState<number>(0);
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
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState<string>('');
  const [isUpdatingUserHeadcount, setIsUpdatingUserHeadcount] = useState(false);
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const loadHeadcount = useCallback(async (showLoading: boolean = true) => {
    if (authLoading || !isAuthenticated || !user) {
      return;
    }

    try {
      if (showLoading) {
        setIsLoading(true);
      }
      const response = await attendanceAPI.getHeadcount(gatheringTypeId, date, 'combined');
      const data: HeadcountData = response.data;
      
      setHeadcount(data.headcount || 0);
      setUserHeadcount(data.userHeadcount || 0);
      setLastUpdated(data.lastUpdated || new Date().toISOString());
      setLastUpdatedBy(data.lastUpdatedBy || 'you');
      setOtherUsers(data.otherUsers || []);
      if (data.sessionState) onSessionStateChange?.(data.sessionState);
    } catch (error: any) {
      console.error('Failed to load headcount:', error);
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
  }, [gatheringTypeId, date, authLoading, isAuthenticated, user, onSessionStateChange]);

  useEffect(() => {
    return () => {
      console.log('HeadcountAttendanceInterface: Component unmounting');
    };
  }, []);

  useEffect(() => {
    setHeadcount(0);
    setUserHeadcount(0);
    setIsLoading(true);
    setLastUpdated(new Date().toISOString());
    setLastUpdatedBy('you');
    setOtherUsers([]);
    
    if (!authLoading && isAuthenticated && user) {
      setTimeout(() => {
        loadHeadcount();
      }, 100);
    }
  }, [gatheringTypeId, date, authLoading, isAuthenticated, user, loadHeadcount]);

  useEffect(() => {
    if (onHeadcountChange) {
      onHeadcountChange(headcount);
    }
  }, [headcount, onHeadcountChange]);

  const updateHeadcount = useCallback(async (newCount: number) => {
    const previousUserHeadcount = userHeadcount;
    
    setUserHeadcount(newCount);
    setLastUpdated(new Date().toISOString());
    setLastUpdatedBy('You');
    
    try {
      const result = await sendHeadcountUpdate(gatheringTypeId, date, newCount, 'combined');
      if (result?.sessionState) onSessionStateChange?.(result.sessionState);
      else await loadHeadcount(false);
    } catch (error: any) {
      console.error('Failed to update headcount via WebSocket:', error);
      setUserHeadcount(previousUserHeadcount);
      setLastUpdated(new Date().toISOString());
      setLastUpdatedBy('You (reverted)');
    }
  }, [gatheringTypeId, date, userHeadcount, sendHeadcountUpdate, onSessionStateChange, loadHeadcount]);

  useEffect(() => {
    if (!socket || !isConnected) return;

    socket.emit('load_headcount', {
      gatheringId: gatheringTypeId,
      date
    });

    const handleHeadcountUpdated = (data: any) => {
      if (data.gatheringId === gatheringTypeId && data.date === date) {
        setHeadcount(data.headcount);
        
        if (data.otherUsers) {
          const personalizedOtherUsers = data.otherUsers
            .map((userData: any) => ({
              ...userData,
              name: userData.userId === user?.id ? 'You' : userData.name,
              isCurrentUser: userData.userId === user?.id
            }))
            .sort((a: any, b: any) => {
              if (a.isCurrentUser && !b.isCurrentUser) return -1;
              if (!a.isCurrentUser && b.isCurrentUser) return 1;
              return a.name.localeCompare(b.name);
            });
          
          setOtherUsers(personalizedOtherUsers);
        }
        
        setLastUpdated(data.timestamp);
        setLastUpdatedBy(data.updatedByName);
      }
    };

    socket.on('headcount_updated', handleHeadcountUpdated);

    return () => {
      socket.off('headcount_updated', handleHeadcountUpdated);
    };
  }, [socket, isConnected, gatheringTypeId, date, user?.id]);

  useEffect(() => {
    if (!authLoading && isAuthenticated && user) {
      setTimeout(() => {
        loadHeadcount();
      }, 100);
    }
  }, [authLoading, isAuthenticated, user, loadHeadcount]);

  const handleIncrement = () => {
    updateHeadcount(userHeadcount + 1);
  };

  const handleDecrement = () => {
    updateHeadcount(Math.max(0, userHeadcount - 1));
  };

  const handleDirectInput = (value: string) => {
    if (value === '' || value.trim() === '') {
      updateHeadcount(0);
      return;
    }
    const numValue = parseInt(value, 10);
    if (!isNaN(numValue) && numValue >= 0) {
      updateHeadcount(numValue);
    }
  };

  const canEditOtherUsers = useMemo(() => {
    return user && (user.role === 'admin' || user.role === 'coordinator');
  }, [user]);

  const handleStartEditUser = (userId: number, currentValue: number) => {
    if (!canEditOtherUsers) return;
    setEditingUserId(userId);
    setEditingValue(currentValue.toString());
  };

  const handleCancelEdit = () => {
    setEditingUserId(null);
    setEditingValue('');
  };

  const handleSaveEdit = async () => {
    if (!editingUserId || !canEditOtherUsers) return;
    
    let numValue: number;
    if (editingValue === '' || editingValue.trim() === '') {
      numValue = 0;
    } else {
      numValue = parseInt(editingValue, 10);
      if (isNaN(numValue) || numValue < 0) return;
    }

    setIsUpdatingUserHeadcount(true);
    try {
      const response = await attendanceAPI.updateUserHeadcount(gatheringTypeId, date, editingUserId, numValue);
      if (response.data.sessionState) onSessionStateChange?.(response.data.sessionState);
    } catch (error: any) {
      console.error('Failed to update user headcount:', error);
    } finally {
      setIsUpdatingUserHeadcount(false);
      setEditingUserId(null);
      setEditingValue('');
    }
  };

  const handleEditKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSaveEdit();
    else if (e.key === 'Escape') handleCancelEdit();
  };

  // ── Fullscreen mode (rendered via portal to escape stacking contexts) ──
  if (isFullscreen) {
    const fullscreenUI = (
      <div
        className="fixed inset-0 bg-white flex flex-col"
        style={{ zIndex: 99999 }}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 shrink-0">
          <span className="text-sm font-medium text-gray-700 truncate">
            {gatheringName}
          </span>
          <button
            onClick={onExitFullscreen}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
            </svg>
            Exit
          </button>
        </div>

        {/* Count – top third */}
        <div className="flex items-center justify-center" style={{ height: '30%' }}>
          <span
            className="font-bold text-gray-900 tabular-nums leading-none"
            style={{
              fontSize: headcount.toString().length > 4
                ? '5rem'
                : headcount.toString().length > 3
                  ? '6rem'
                  : '8rem',
            }}
          >
            {headcount}
          </span>
        </div>

        {/* Big + button – bottom two thirds */}
        <div className="flex px-4 pb-4" style={{ height: '65%' }}>
          <button
            onClick={handleIncrement}
            className="w-full h-full flex items-center justify-center rounded-2xl bg-purple-100 hover:bg-purple-200 active:bg-purple-300 transition-colors"
          >
            <svg className="text-purple-600" width="100" height="100" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>

        {!isConnected && (
          <div className="text-center text-sm text-yellow-600 pb-2 shrink-0">
            Offline - changes will sync when reconnected
          </div>
        )}
      </div>
    );

    return ReactDOM.createPortal(fullscreenUI, document.body);
  }

  // ── Standard mode (same layout during loading to prevent layout shift) ──
  return (
    <div className="space-y-6 transition-all duration-300 ease-in-out pb-12 relative">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10 rounded-lg" aria-hidden="true">
          <div className="flex flex-col items-center gap-2">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
            <span className="text-sm text-gray-500">Loading...</span>
          </div>
        </div>
      )}
      <div className="text-center">
        <div className="flex flex-col items-center space-y-6">
          {/* Desktop Layout - Horizontal (smaller buttons on md+) */}
          <div className="hidden md:flex items-center justify-center space-x-6">
            <button
              onClick={handleDecrement}
              disabled={headcount <= 0}
              className="flex items-center justify-center w-[84px] h-[84px] rounded-full bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
            >
              <MinusIcon className="h-[42px] w-[42px] text-green-600" />
            </button>

            <div className="flex items-center justify-center min-h-[84px]">
              <input
                type="number"
                value={userHeadcount}
                onChange={(e) => handleDirectInput(e.target.value)}
                className="font-bold text-center bg-transparent border-none outline-none min-w-20 max-w-80 px-2 disabled:cursor-not-allowed leading-none [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [-moz-appearance:textfield]"
                style={{
                  width: `${Math.max(userHeadcount.toString().length * 0.8, 2)}em`,
                  fontSize: userHeadcount.toString().length > 4 ? '2.5rem' : userHeadcount.toString().length > 3 ? '3rem' : '4rem'
                }}
                min="0"
              />
            </div>

            <button
              onClick={handleIncrement}
              className="flex items-center justify-center w-[84px] h-[84px] rounded-full bg-purple-100 hover:bg-purple-200 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
            >
              <PlusIcon className="h-[42px] w-[42px] text-purple-600" />
            </button>
          </div>

          {/* Mobile Layout: - button, count, + button */}
          <div className="md:hidden flex flex-col items-center space-y-4">
            <button
              onClick={handleDecrement}
              disabled={headcount <= 0}
              className="flex items-center justify-center w-28 h-28 rounded-full bg-green-100 hover:bg-green-200 active:bg-green-300 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
            >
              <MinusIcon className="h-14 w-14 text-green-600" />
            </button>

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

            <button
              onClick={handleIncrement}
              className="flex items-center justify-center w-28 h-28 rounded-full bg-purple-100 hover:bg-purple-200 active:bg-purple-300 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
            >
              <PlusIcon className="h-14 w-14 text-purple-600" />
            </button>
          </div>

          {!isConnected && (
            <div className="text-center text-sm text-yellow-600">
              <p>Offline - changes will sync when reconnected</p>
            </div>
          )}
        </div>
      </div>

      {/* The combined total stays visible; individual contributions are optional detail. */}
      <div className="flex flex-col items-center gap-1 text-center">
        <span className="text-3xl font-semibold tabular-nums text-gray-900 dark:text-gray-100">{headcount}</span>
        <span className="text-sm text-gray-500 dark:text-gray-400">Total</span>
      </div>

      {otherUsers.length > 1 && (
        <details key={`${gatheringTypeId}-${date}`} className="mx-auto max-w-md border-t border-gray-200 dark:border-gray-700 pt-4">
          <summary className="cursor-pointer text-center text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100">
            Contributions ({otherUsers.length})
          </summary>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-gray-500 dark:text-gray-400">
                <th scope="col" className="py-2 text-left font-medium">Person</th>
                <th scope="col" className="py-2 text-right font-medium">Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {otherUsers.map((userData) => (
                <tr key={userData.userId}>
                  <th scope="row" className="py-2 text-left font-normal text-gray-700 dark:text-gray-300">{userData.name}</th>
                  <td className="py-2 text-right">
                    {editingUserId === userData.userId ? (
                      <div className="flex items-center justify-end gap-2">
                        <input
                          aria-label={`Count for ${userData.name}`}
                          type="number"
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={handleEditKeyPress}
                          className="w-16 px-2 py-1 text-center text-base border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 min-h-[32px]"
                          min="0"
                          autoFocus
                        />
                        <button
                          onClick={handleSaveEdit}
                          disabled={isUpdatingUserHeadcount}
                          className="p-1.5 text-green-600 hover:text-green-700 hover:bg-green-50 rounded disabled:opacity-50 min-h-[32px] min-w-[32px] flex items-center justify-center"
                          title="Save"
                        >
                          <CheckIcon className="h-4 w-4" />
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          disabled={isUpdatingUserHeadcount}
                          className="p-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 rounded disabled:opacity-50 min-h-[32px] min-w-[32px] flex items-center justify-center"
                          title="Cancel"
                        >
                          <XMarkIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <span className="font-medium tabular-nums text-gray-900 dark:text-gray-100">{userData.headcount}</span>
                        {canEditOtherUsers && !userData.isCurrentUser && (
                          <button
                            onClick={() => handleStartEditUser(userData.userId, userData.headcount)}
                            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-all min-h-[32px] min-w-[32px] flex items-center justify-center"
                            title={`Edit ${userData.name}'s headcount`}
                          >
                            <PencilIcon className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
};

export default HeadcountAttendanceInterface;
