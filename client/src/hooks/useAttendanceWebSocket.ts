import { useEffect, useRef, useCallback, useState } from 'react';
import { useWebSocket, AttendanceUpdate, VisitorUpdate } from '../contexts/WebSocketContext';
import { Individual, Visitor } from '../services/api';

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
    joinAttendanceRoom, 
    leaveAttendanceRoom, 
    onAttendanceUpdate, 
    onVisitorUpdate,
    onUserActivity,
    getCurrentRoom,
    socket
  } = useWebSocket();

  const [isInRoom, setIsInRoom] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [userActivity, setUserActivity] = useState<Array<{ userId: number; userEmail: string; timestamp: string }>>([]);
  
  // Keep track of current room parameters
  const currentGatheringId = useRef<number | null>(null);
  const currentDate = useRef<string | null>(null);

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

  // Join room when parameters change
  const joinRoom = useCallback(() => {
    if (!enabled || !gatheringId || !date || !isConnected) {
      return;
    }

    console.log(`📋 Joining attendance WebSocket room: gathering ${gatheringId}, date ${date}`);
    joinAttendanceRoom(gatheringId, date);
    currentGatheringId.current = gatheringId;
    currentDate.current = date;
  }, [enabled, gatheringId, date, isConnected, joinAttendanceRoom]);

  // Leave current room
  const leaveRoom = useCallback(() => {
    if (currentGatheringId.current && currentDate.current && isConnected) {
      console.log(`🚪 Leaving attendance WebSocket room: gathering ${currentGatheringId.current}, date ${currentDate.current}`);
      leaveAttendanceRoom(currentGatheringId.current, currentDate.current);
    }
    setIsInRoom(false);
    currentGatheringId.current = null;
    currentDate.current = null;
  }, [isConnected, leaveAttendanceRoom]);

  // Auto-join room when connected and parameters are available
  useEffect(() => {
    if (enabled && gatheringId && date && isConnected) {
      // Only join if we're not already in the correct room
      if (currentGatheringId.current !== gatheringId || currentDate.current !== date) {
        console.log(`📋 Room change detected: ${currentGatheringId.current}:${currentDate.current} -> ${gatheringId}:${date}`);
        
        // Leave previous room if different
        if (currentGatheringId.current && currentDate.current) {
          leaveAttendanceRoom(currentGatheringId.current, currentDate.current);
        }
        
        // Small delay to avoid rapid join/leave cycles
        const timeoutId = setTimeout(() => {
          joinRoom();
        }, 100);
        
        return () => clearTimeout(timeoutId);
      } else {
        console.log(`📋 Already in correct room: ${gatheringId}:${date}`);
      }
    } else if (!enabled || !gatheringId || !date) {
      // Leave room if no longer needed
      if (currentGatheringId.current || currentDate.current) {
        console.log('📋 Leaving room - conditions no longer met');
        leaveRoom();
      }
    }
  }, [enabled, gatheringId, date, isConnected]);

  // Leave room when component unmounts or connection is lost
  useEffect(() => {
    return () => {
      if (currentGatheringId.current && currentDate.current) {
        leaveRoom();
      }
    };
  }, [leaveRoom]);

  // Check if we're in the correct room (stable version)
  useEffect(() => {
    const currentRoom = getCurrentRoom();
    const expectedRoom = gatheringId && date ? `attendance:${gatheringId}:${date}` : null;
    
    // Note: Server includes church_id in room name, so we check if our expected room is contained in current room
    const inCorrectRoom = currentRoom && expectedRoom && currentRoom.includes(`:${gatheringId}:${date}`);
    const newIsInRoom = Boolean(inCorrectRoom);
    
    if (newIsInRoom !== isInRoom) {
      console.log(`📋 Room status changed: ${isInRoom} -> ${newIsInRoom} (currentRoom: ${currentRoom}, expected: ${expectedRoom})`);
      setIsInRoom(newIsInRoom);
    }
  }, [gatheringId, date, isConnected]);

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
