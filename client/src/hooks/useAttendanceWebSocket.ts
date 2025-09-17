import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useWebSocket, AttendanceUpdate, VisitorUpdate } from '../contexts/WebSocketContext';
import { useAuth } from '../contexts/AuthContext';
import { Individual, Visitor } from '../services/api';

// Global state to prevent multiple hooks from causing join/leave storms
// But allow legitimate multi-tab usage by tracking per-hook-instance
let globalRoomState: { 
  currentRoom: string | null; 
  isChangingRoom: boolean; 
  lastChangeTime: number;
  pendingLeaveOperations: Set<string>; // Track pending leave operations
  recentHookOperations: Map<string, number>; // Track recent operations per hook
} = {
  currentRoom: null,
  isChangingRoom: false,
  lastChangeTime: 0,
  pendingLeaveOperations: new Set(),
  recentHookOperations: new Map()
};

interface AttendanceWebSocketOptions {
  gatheringId: number | null;
  date: string | null;
  enabled?: boolean;
  onAttendanceChange?: (records: Array<{ individualId: number; present: boolean }>) => void;
  onVisitorChange?: (visitors: Visitor[]) => void;
  onFullRefresh?: (attendanceList: Individual[], visitors: Visitor[]) => void;
  onError?: (error: string) => void;
}

interface AttendanceWebSocketReturn {
  isConnected: boolean;
  isInRoom: boolean;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  roomName: string | null;
  lastUpdate: Date | null;
  userActivity: Array<{ userId: number; userEmail: string; timestamp: string }>;
  joinRoom: () => void;
  leaveRoom: () => void;
  forceReconnect: () => void;
}

export const useAttendanceWebSocket = (options: AttendanceWebSocketOptions): AttendanceWebSocketReturn => {
  const {
    gatheringId,
    date,
    enabled = true,
    onAttendanceChange,
    onVisitorChange,
    onFullRefresh,
    onError
  } = options;

  const { 
    isConnected, 
    connectionStatus, 
    onAttendanceUpdate, 
    onVisitorUpdate,
    onUserActivity,
    getCurrentRoom,
    socket
  } = useWebSocket();

  const { user } = useAuth(); // Add user context to get church ID

  const [isInRoom, setIsInRoom] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [userActivity, setUserActivity] = useState<Array<{ userId: number; userEmail: string; timestamp: string }>>([]);
  
  // Keep track of current room parameters
  const currentGatheringId = useRef<number | null>(null);
  const currentDate = useRef<string | null>(null);
  
  // Simplified debouncing - single timeout per hook instance
  const joinTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isProcessingRoomChange = useRef(false);

  // Stable callbacks to avoid dependency issues
  const stableOnAttendanceChange = useRef(onAttendanceChange);
  const stableOnVisitorChange = useRef(onVisitorChange);
  const stableOnFullRefresh = useRef(onFullRefresh);
  const stableOnError = useRef(onError);

  // Update callback refs when they change
  useEffect(() => {
    stableOnAttendanceChange.current = onAttendanceChange;
    stableOnVisitorChange.current = onVisitorChange;
    stableOnFullRefresh.current = onFullRefresh;
    stableOnError.current = onError;
  }, [onAttendanceChange, onVisitorChange, onFullRefresh, onError]);

  // Unique hook ID for multi-tab debugging
  const hookId = useRef(Math.random().toString(36).substr(2, 9));

  // Simplified join room logic
  const joinRoom = useCallback(() => {
    console.log(`[Hook ${hookId.current}] 🚪 joinRoom called - enabled=${enabled}, gatheringId=${gatheringId}, date=${date}, isConnected=${isConnected}`);
    
    if (!enabled || !gatheringId || !date || !isConnected) {
      console.log(`[Hook ${hookId.current}] 📋 Cannot join room - conditions not met: enabled=${enabled}, gatheringId=${gatheringId}, date=${date}, isConnected=${isConnected}`);
      return;
    }

    // Get church ID from user context, fallback to 1 if not available
    const churchId = user?.church_id || '1';
    const targetRoom = `attendance:${churchId}:${gatheringId}:${date}`;
    
    // Simple debouncing - prevent rapid calls
    if (joinTimeoutRef.current) {
      clearTimeout(joinTimeoutRef.current);
    }

    if (isProcessingRoomChange.current) {
      console.log(`[Hook ${hookId.current}] 📋 Already processing room change, deferring join`);
      setTimeout(() => joinRoom(), 100);
      return;
    }

    joinTimeoutRef.current = setTimeout(() => {
      if (!enabled || !gatheringId || !date || !isConnected) {
        return;
      }
 
      isProcessingRoomChange.current = true;
      
      console.log(`[Hook ${hookId.current}] 📋 Joining attendance WebSocket room: gathering ${gatheringId}, date ${date}`);
      // Room system disabled - using manual broadcasting
      currentGatheringId.current = gatheringId;
      currentDate.current = date;
      
      // Reset processing flag after a short delay
      setTimeout(() => {
        isProcessingRoomChange.current = false;
      }, 200);
    }, 100);
  }, [enabled, gatheringId, date, isConnected, user?.church_id]);

  // Simplified leave room logic
  const leaveRoom = useCallback(() => {
    if (!currentGatheringId.current || !currentDate.current) {
      console.log(`[Hook ${hookId.current}] 🚪 No room to leave - already clean`);
      return;
    }

    if (isProcessingRoomChange.current) {
      console.log(`[Hook ${hookId.current}] 🚪 Skipping leave - already processing room change`);
      return;
    }

    // Clear any pending join operation
    if (joinTimeoutRef.current) {
      clearTimeout(joinTimeoutRef.current);
      joinTimeoutRef.current = null;
    }

    isProcessingRoomChange.current = true;
    
    console.log(`[Hook ${hookId.current}] 🚪 Leaving attendance room: gathering ${currentGatheringId.current}, date ${currentDate.current}`);
    // Room system disabled - no leave needed
    
    // Clear current room tracking
    currentGatheringId.current = null;
    currentDate.current = null;
    
    // Reset processing flag after a short delay
    setTimeout(() => {
      isProcessingRoomChange.current = false;
    }, 200);
  }, []);

  // Auto-join room when connected and parameters are available
  useEffect(() => {
    console.log(`[Hook ${hookId.current}] 📋 Room check: enabled=${enabled}, gatheringId=${gatheringId}, date=${date}, isConnected=${isConnected}, processing=${isProcessingRoomChange.current}`);
    
    if (enabled && gatheringId && date && isConnected) {
      // Join the room if not already in the correct room
      if (currentGatheringId.current !== gatheringId || currentDate.current !== date) {
        console.log(`[Hook ${hookId.current}] 📋 Room change detected: ${currentGatheringId.current}:${currentDate.current} -> ${gatheringId}:${date}`);
        
        // Leave previous room if any (directly, no global coordination needed)
        if (currentGatheringId.current && currentDate.current) {
          console.log(`[Hook ${hookId.current}] 📋 Leaving previous room before joining new one`);
          // Room system disabled - no leave needed
          
          // Small delay to ensure leave completes before join
          setTimeout(() => {
            joinRoom();
          }, 100);
        } else {
          // No previous room to leave, join immediately
          joinRoom();
        }
      } else {
        // Already in correct room, don't leave - this was causing premature leaves
        console.log(`[Hook ${hookId.current}] 📋 Already in correct room: ${gatheringId}:${date}`);
      }
    } else if (currentGatheringId.current || currentDate.current) {
      // Only leave if we actually need to disconnect from the current room
      console.log(`[Hook ${hookId.current}] 📋 Leaving room - conditions no longer met (enabled=${enabled}, gatheringId=${gatheringId}, date=${date}, isConnected=${isConnected})`);
      leaveRoom();
    }
  }, [enabled, gatheringId, date, isConnected]); // Removed joinRoom and leaveRoom to prevent infinite loops

  // Leave room when component unmounts or connection is lost
  useEffect(() => {
    return () => {
      // Clear any pending timeouts on unmount
      if (joinTimeoutRef.current) {
        clearTimeout(joinTimeoutRef.current);
        joinTimeoutRef.current = null;
      }
      
      // Only leave room if we actually have one to leave and aren't already processing
      if (currentGatheringId.current && currentDate.current && isConnected && !isProcessingRoomChange.current) {
        const roomKey = `${hookId.current}:${currentGatheringId.current}:${currentDate.current}`;
        
        // Check if this hook instance isn't already leaving the room
        if (!globalRoomState.pendingLeaveOperations.has(roomKey)) {
          console.log(`[Hook ${hookId.current}] 🧹 Cleanup: Leaving room on unmount`);
          globalRoomState.pendingLeaveOperations.add(roomKey);
          // Room system disabled - no leave needed
          
          // Clean up after a delay
          setTimeout(() => {
            globalRoomState.pendingLeaveOperations.delete(roomKey);
          }, 1000);
        } else {
          console.log(`[Hook ${hookId.current}] 🧹 Cleanup: Hook instance already leaving room`);
        }
      }
    };
  }, [isConnected]);

  // Check if we're in the correct room (stable version)
  useEffect(() => {
    const currentRoom = getCurrentRoom();
    // Get church ID from user context, fallback to 1 if not available
    const churchId = user?.church_id || '1';
    const expectedRoom = gatheringId && date ? `attendance:${churchId}:${gatheringId}:${date}` : null;
    
    // Check for exact room match
    const inCorrectRoom = currentRoom && expectedRoom && currentRoom === expectedRoom;
    const newIsInRoom = Boolean(inCorrectRoom);
    
    if (newIsInRoom !== isInRoom) {
      console.log(`📋 Room status changed: ${isInRoom} -> ${newIsInRoom} (currentRoom: ${currentRoom}, expected: ${expectedRoom})`);
      setIsInRoom(newIsInRoom);
    }
  }, [isInRoom, gatheringId, date, getCurrentRoom]); // Removed user?.church_id to prevent excessive re-runs

  // Handle attendance updates
  useEffect(() => {
    const unsubscribe = onAttendanceUpdate((update: AttendanceUpdate) => {
      console.log('📊 [WEBSOCKET] Received attendance update:', {
        updateType: update.type,
        updateGathering: update.gatheringId,
        updateDate: update.date,
        currentGathering: gatheringId,
        currentDate: date,
        willProcess: update.gatheringId === gatheringId && update.date === date,
        recordsCount: update.records?.length || 0,
        hasAttendanceList: !!update.attendanceList,
        hasVisitors: !!update.visitors
      });

      // Only process updates for the current gathering and date
      if (update.gatheringId !== gatheringId || update.date !== date) {
        console.log('📊 [WEBSOCKET] Ignoring update - different gathering/date');
        return;
      }

      setLastUpdate(new Date());

      try {
        if (update.type === 'attendance_records' && update.records) {
          console.log('📊 [WEBSOCKET] Processing attendance records update:', update.records);
          stableOnAttendanceChange.current?.(update.records);
        } else if (update.type === 'full_refresh') {
          console.log('🔄 [WEBSOCKET] Processing full refresh update');
          if (update.attendanceList && update.visitors) {
            stableOnFullRefresh.current?.(update.attendanceList, update.visitors);
          }
        }
      } catch (error) {
        console.error('Error processing attendance update:', error);
        stableOnError.current?.('Failed to process attendance update');
      }
    });

    return unsubscribe;
  }, [gatheringId, date, onAttendanceUpdate]);

  // Handle visitor updates
  useEffect(() => {
    const unsubscribe = onVisitorUpdate((update: VisitorUpdate) => {
      // Only process updates for the current gathering and date
      if (update.gatheringId !== gatheringId || update.date !== date) {
        return;
      }

      setLastUpdate(new Date());

      try {
        console.log('👥 Processing visitor update:', update);
        if (update.visitors) {
          stableOnVisitorChange.current?.(update.visitors);
        }
      } catch (error) {
        console.error('Error processing visitor update:', error);
        stableOnError.current?.('Failed to process visitor update');
      }
    });

    return unsubscribe;
  }, [gatheringId, date, onVisitorUpdate]);

  // Handle user activity
  useEffect(() => {
    const unsubscribe = onUserActivity((activity) => {
      setUserActivity(prev => {
        // Keep only last 10 activities and avoid duplicates
        const filtered = prev.filter(a => a.userId !== activity.userId || a.timestamp !== activity.timestamp);
        return [activity, ...filtered].slice(0, 10);
      });
    });

    return unsubscribe;
  }, [onUserActivity]);

  // Force reconnect function
  const forceReconnect = useCallback(() => {
    if (socket) {
      console.log('🔄 Force reconnecting WebSocket...');
      socket.disconnect();
      socket.connect();
    }
  }, [socket]);

  return {
    isConnected,
    isInRoom,
    connectionStatus,
    roomName: getCurrentRoom(),
    lastUpdate,
    userActivity,
    joinRoom,
    leaveRoom,
    forceReconnect
  };
};
