import { useState, useEffect, useRef, useCallback } from 'react';
import io from 'socket.io-client';
import { useAuth } from '../contexts/AuthContext';
import { AttendanceUpdate, VisitorUpdate, UserActivity } from '../contexts/WebSocketContext';

interface AttendanceWebSocketConnection {
  socket: ReturnType<typeof io> | null;
  isConnected: boolean;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  sendAttendanceUpdate: (gatheringId: number, date: string, records: Array<{ individualId: number; present: boolean }>) => Promise<void>;
  sendHeadcountUpdate: (gatheringId: number, date: string, headcount: number, mode?: string) => Promise<void>;
  loadAttendanceData: (gatheringId: number, date: string) => Promise<{ attendanceList: any[]; visitors: any[] }>;
  onAttendanceUpdate: (callback: (update: AttendanceUpdate) => void) => () => void;
  onVisitorUpdate: (callback: (update: VisitorUpdate) => void) => () => void;
  onUserActivity: (callback: (activity: UserActivity) => void) => () => void;
}

export const useAttendanceWebSocketConnection = (): AttendanceWebSocketConnection => {
  const { user, refreshTokenAndUserData } = useAuth();
  const [socket, setSocket] = useState<ReturnType<typeof io> | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  
  // Refs to store callbacks
  const attendanceCallbacks = useRef<Set<(update: AttendanceUpdate) => void>>(new Set());
  const visitorCallbacks = useRef<Set<(update: VisitorUpdate) => void>>(new Set());
  const userActivityCallbacks = useRef<Set<(activity: UserActivity) => void>>(new Set());
  
  // Generate unique tab ID that distinguishes between browser tabs and PWA
  const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  const tabId = useRef(`${isPWA ? 'pwa' : 'tab'}_${Math.random().toString(36).substr(2, 9)}`);
  
  // Connection management
  const connectingRef = useRef(false);
  const userRef = useRef(user);
  userRef.current = user;

  // Connect to WebSocket when user is available
  useEffect(() => {
    if (!userRef.current || connectingRef.current) {
      return;
    }

    connectingRef.current = true;
    setConnectionStatus('connecting');

    const getUserAuthData = () => {
      if (!userRef.current) {
        return null;
      }
      
      if (!userRef.current.church_id) {
        console.log('🔌 No church_id found, refreshing user data...');
        refreshTokenAndUserData().then(() => {
          connectingRef.current = false;
        });
        return null;
      }
      
      return {
        userId: userRef.current.id,
        email: userRef.current.email,
        role: userRef.current.role,
        churchId: userRef.current.church_id
      };
    };

    const authData = getUserAuthData();
    if (!authData) {
      connectingRef.current = false;
      return;
    }

    const serverUrl = window.location.origin;
    const connectionId = `attendance_${authData.userId}_${tabId.current}_${Date.now()}`;
    
    console.log(`🔌 Creating attendance WebSocket connection for ${isPWA ? 'PWA' : 'browser tab'}`, {
      tabId: tabId.current,
      connectionId,
      userId: authData.userId,
      churchId: authData.churchId
    });
    
    const socketConfig = {
      auth: {
        ...authData,
        tabId: tabId.current,
        connectionId: connectionId
      },
      withCredentials: true,
      transports: ['websocket', 'polling'],
      timeout: 5000, // Reduced from 8000ms for faster initial connection
      reconnection: true,
      reconnectionAttempts: 5, // Increased from 3 for better reliability
      reconnectionDelay: 300, // Reduced from 500ms for faster reconnection
      reconnectionDelayMax: 3000, // Reduced from 5000ms
      forceNew: true, // Force new connection for each tab to avoid conflicts
      upgrade: true,
      rememberUpgrade: true,
      autoConnect: true,
      query: {
        tabId: tabId.current,
        connectionId: connectionId
      },
      pingTimeout: 30000,
      pingInterval: 15000,
      maxReconnectionAttempts: 5 // Increased from 3
    };
    
    console.log(`🔌 [Tab ${tabId.current}] Connecting to WebSocket for attendance...`, { serverUrl, authData, connectionId });
    
    const newSocket = io(serverUrl, socketConfig);

    // Connection event handlers
    newSocket.on('connect', () => {
      console.log(`✅ [Tab ${tabId.current}] WebSocket connected for attendance:`, newSocket.id);
      setIsConnected(true);
      setConnectionStatus('connected');
      connectingRef.current = false;
    });

    newSocket.on('disconnect', (reason: string) => {
      console.log('📴 WebSocket disconnected:', reason);
      setIsConnected(false);
      setConnectionStatus('disconnected');
      
      if (reason !== 'io client disconnect') {
        setConnectionStatus('connecting');
      }
    });

    newSocket.on('connect_error', async (error: Error) => {
      console.error('❌ WebSocket connection error:', error.message);
      
      if (error.message && error.message.includes('Church ID mismatch')) {
        console.log('🔧 Church ID mismatch - refreshing token...');
        try {
          await refreshTokenAndUserData();
        } catch (refreshError) {
          console.error('❌ Failed to refresh token:', refreshError);
        }
      }
      
      setIsConnected(false);
      setConnectionStatus('error');
      connectingRef.current = false;
    });

    newSocket.on('reconnect', (attemptNumber: number) => {
      console.log(`🔄 WebSocket reconnected after ${attemptNumber} attempts`);
      setConnectionStatus('connected');
    });

    newSocket.on('reconnect_error', (error: Error) => {
      console.error('❌ WebSocket reconnection error:', error.message);
    });

    newSocket.on('reconnect_failed', () => {
      console.error('❌ WebSocket reconnection failed');
      setConnectionStatus('error');
    });

    // Event handlers for real-time updates
    newSocket.on('attendance_update', (update: AttendanceUpdate) => {
      console.log('📊 Received attendance update:', update);
      attendanceCallbacks.current.forEach(callback => {
        try {
          callback(update);
        } catch (error) {
          console.error('Error in attendance callback:', error);
        }
      });
    });

    newSocket.on('visitor_update', (update: VisitorUpdate) => {
      console.log('👥 Received visitor update:', update);
      visitorCallbacks.current.forEach(callback => {
        try {
          callback(update);
        } catch (error) {
          console.error('Error in visitor callback:', error);
        }
      });
    });

    newSocket.on('user_joined', (activity: UserActivity) => {
      console.log('👋 User joined:', activity);
      userActivityCallbacks.current.forEach(callback => {
        try {
          callback(activity);
        } catch (error) {
          console.error('Error in user activity callback:', error);
        }
      });
    });

    setSocket(newSocket);

    // Cleanup on unmount
    return () => {
      console.log('🧹 Cleaning up WebSocket connection');
      connectingRef.current = false;
      newSocket.disconnect();
    };
  }, [user?.id, user?.church_id, refreshTokenAndUserData]);

  // Send attendance update via WebSocket
  const sendAttendanceUpdate = useCallback(async (gatheringId: number, date: string, records: Array<{ individualId: number; present: boolean }>): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!socket || !isConnected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      console.log(`📤 Sending attendance update: gathering ${gatheringId}, date ${date}`, records);
      
      const handleSuccess = () => {
        socket.off('attendance_update_error', handleError);
        resolve();
      };
      
      const handleError = (error: { message?: string }) => {
        socket.off('attendance_update_success', handleSuccess);
        reject(new Error(error.message || 'Failed to update attendance'));
      };

      socket.once('attendance_update_success', handleSuccess);
      socket.once('attendance_update_error', handleError);

      socket.emit('record_attendance', {
        gatheringId,
        date,
        records
      });

      setTimeout(() => {
        socket.off('attendance_update_success', handleSuccess);
        socket.off('attendance_update_error', handleError);
        reject(new Error('WebSocket attendance update timeout'));
      }, 10000);
    });
  }, [socket, isConnected]);

  // Send headcount update via WebSocket
  const sendHeadcountUpdate = useCallback(async (gatheringId: number, date: string, headcount: number, mode: string = 'combined'): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!socket || !isConnected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      console.log(`📤 Sending headcount update: gathering ${gatheringId}, date ${date}, headcount ${headcount}, mode ${mode}`);
      
      const handleSuccess = () => {
        socket.off('headcount_update_error', handleError);
        resolve();
      };
      
      const handleError = (error: { message?: string }) => {
        socket.off('headcount_update_success', handleSuccess);
        reject(new Error(error.message || 'Failed to update headcount'));
      };

      socket.once('headcount_update_success', handleSuccess);
      socket.once('headcount_update_error', handleError);

      socket.emit('update_headcount', {
        gatheringId,
        date,
        headcount,
        mode
      });

      setTimeout(() => {
        socket.off('headcount_update_success', handleSuccess);
        socket.off('headcount_update_error', handleError);
        reject(new Error('WebSocket headcount update timeout'));
      }, 10000);
    });
  }, [socket, isConnected]);

  // Load attendance data via WebSocket
  const loadAttendanceData = useCallback(async (gatheringId: number, date: string): Promise<{ attendanceList: any[]; visitors: any[] }> => {
    return new Promise((resolve, reject) => {
      if (!socket || !isConnected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      console.log(`📤 Loading attendance data: gathering ${gatheringId}, date ${date}`);
      
      const handleSuccess = (data: { attendanceList?: any[], visitors?: any[] }) => {
        socket.off('load_attendance_error', handleError);
        resolve({
          attendanceList: data.attendanceList || [],
          visitors: data.visitors || []
        });
      };
      
      const handleError = (error: { message?: string }) => {
        socket.off('load_attendance_success', handleSuccess);
        reject(new Error(error.message || 'Failed to load attendance data'));
      };

      socket.once('load_attendance_success', handleSuccess);
      socket.once('load_attendance_error', handleError);

      socket.emit('load_attendance', {
        gatheringId,
        date
      });

      setTimeout(() => {
        socket.off('load_attendance_success', handleSuccess);
        socket.off('load_attendance_error', handleError);
        reject(new Error('WebSocket load attendance timeout'));
      }, 10000);
    });
  }, [socket, isConnected]);

  // Subscribe to attendance updates
  const onAttendanceUpdate = useCallback((callback: (update: AttendanceUpdate) => void): (() => void) => {
    attendanceCallbacks.current.add(callback);
    return () => {
      attendanceCallbacks.current.delete(callback);
    };
  }, []);

  // Subscribe to visitor updates
  const onVisitorUpdate = useCallback((callback: (update: VisitorUpdate) => void): (() => void) => {
    visitorCallbacks.current.add(callback);
    return () => {
      visitorCallbacks.current.delete(callback);
    };
  }, []);

  // Subscribe to user activity
  const onUserActivity = useCallback((callback: (activity: UserActivity) => void): (() => void) => {
    userActivityCallbacks.current.add(callback);
    return () => {
      userActivityCallbacks.current.delete(callback);
    };
  }, []);

  return {
    socket,
    isConnected,
    connectionStatus,
    sendAttendanceUpdate,
    sendHeadcountUpdate,
    loadAttendanceData,
    onAttendanceUpdate,
    onVisitorUpdate,
    onUserActivity
  };
};
