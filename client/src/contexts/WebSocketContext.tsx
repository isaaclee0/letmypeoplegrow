import React, { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';

// WebSocket event types
export interface AttendanceUpdate {
  type: 'attendance_records' | 'full_refresh';
  gatheringId: number;
  date: string;
  records?: Array<{ individualId: number; present: boolean }>;
  attendanceList?: any[];
  visitors?: any[];
  updatedBy?: number;
  updatedAt?: string;
  timestamp: string;
}

export interface VisitorUpdate {
  type: 'visitors' | 'visitor_family_added' | 'visitor_family_updated';
  gatheringId: number;
  date: string;
  family?: { id?: number; name?: string };
  visitors: any[];
  timestamp: string;
}

export interface UserActivity {
  userId: number;
  userEmail: string;
  timestamp: string;
}

export interface ActiveUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

export interface RoomUsersUpdate {
  activeUsers: ActiveUser[];
  timestamp: string;
}

// WebSocket context type
interface WebSocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  activeUsers: ActiveUser[];
  joinAttendanceRoom: (gatheringId: number, date: string) => void;
  leaveAttendanceRoom: (gatheringId: number, date: string) => void;
  onAttendanceUpdate: (callback: (update: AttendanceUpdate) => void) => () => void;
  onVisitorUpdate: (callback: (update: VisitorUpdate) => void) => () => void;
  onUserActivity: (callback: (activity: UserActivity) => void) => () => void;
  onRoomUsersUpdate: (callback: (update: RoomUsersUpdate) => void) => () => void;
  getCurrentRoom: () => string | null;
  getConnectionStats: () => { connected: boolean; room: string | null; socketId: string | null };
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

interface WebSocketProviderProps {
  children: ReactNode;
}

export const WebSocketProvider: React.FC<WebSocketProviderProps> = ({ children }) => {
  console.log('🔌 WebSocketProvider initialized');
  
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [activeUsers, setActiveUsers] = useState<ActiveUser[]>([]);
  
  // Flag to prevent multiple initialization attempts
  const initializingRef = useRef(false);
  
  // Refs to store callbacks to avoid dependency issues
  const attendanceCallbacks = useRef<Set<(update: AttendanceUpdate) => void>>(new Set());
  const visitorCallbacks = useRef<Set<(update: VisitorUpdate) => void>>(new Set());
  const userActivityCallbacks = useRef<Set<(activity: UserActivity) => void>>(new Set());
  const roomUsersCallbacks = useRef<Set<(update: RoomUsersUpdate) => void>>(new Set());
  
  // Connection management with improved duplicate prevention
  useEffect(() => {
    // Only connect if user is authenticated and has a valid token
    if (!user) {
      if (socket) {
        console.log('🔌 Disconnecting WebSocket (user logged out)');
        socket.disconnect();
        setSocket(null);
        setIsConnected(false);
        setConnectionStatus('disconnected');
        setCurrentRoom(null);
        setActiveUsers([]);
      }
      return;
    }

    // Prevent multiple connections (especially important in React StrictMode)
    if (socket && socket.auth?.userId === user.id) {
      // Check if socket is still connected or connecting
      if (socket.connected || socket.connecting) {
        console.log('🔌 WebSocket already exists for current user, reusing connection');
        setIsConnected(socket.connected);
        setConnectionStatus(socket.connected ? 'connected' : 'connecting');
        return;
      } else {
        // Socket exists but is disconnected, clean it up
        console.log('🔌 Cleaning up disconnected socket before creating new one');
        socket.disconnect();
        setSocket(null);
      }
    }

    // Prevent multiple initialization attempts
    if (initializingRef.current) {
      console.log('🔌 WebSocket initialization already in progress, skipping');
      return;
    }

    // Set initialization flag
    initializingRef.current = true;

    // Since the app uses cookie-based authentication, we'll use a different approach
    // We'll pass the user info and let the server validate the session via cookies
    const getUserAuthData = () => {
      if (!user) {
        console.log('🔌 No user available for WebSocket auth');
        return null;
      }
      
      console.log('🔌 User data for WebSocket auth:', {
        id: user.id,
        email: user.email,
        role: user.role,
        church_id: user.church_id
      });
      
      // Generate a temporary token for WebSocket auth using user data
      // The server will still validate the actual session via cookies
      // If church_id is missing, we'll use a fallback (the user must have access to some church data 
      // since they can use the REST API)
      const churchId = user.church_id || '1'; // Fallback to '1' if missing
      
      console.log('🔌 Church ID resolution:', {
        userChurchId: user.church_id,
        resolvedChurchId: churchId,
        usingFallback: !user.church_id
      });
      
      return {
        userId: user.id,
        email: user.email,
        role: user.role,
        churchId: churchId
      };
    };

    const authData = getUserAuthData();
    if (!authData) {
      console.warn('🔌 No user auth data available for WebSocket connection');
      return;
    }

    setConnectionStatus('connecting');

    // Determine server URL
    // In Docker development, the client runs on port 3000 and connects to server on port 3001
    // But since we access via nginx on port 80, we should connect to the same origin
    const serverUrl = process.env.REACT_APP_SERVER_URL || 
                     (process.env.NODE_ENV === 'development' ? window.location.origin : window.location.origin);
    
    console.log('🔌 WebSocket serverUrl resolution:', {
      REACT_APP_SERVER_URL: process.env.REACT_APP_SERVER_URL,
      NODE_ENV: process.env.NODE_ENV,
      'window.location.origin': window.location.origin,
      'resolved serverUrl': serverUrl
    });

    console.log('🔌 Initializing WebSocket connection...', {
      serverUrl,
      authData,
      userAuthenticated: !!user
    });

    // Create socket connection with polling-only for debugging
    console.log('🔌 Creating socket connection to:', serverUrl, 'with auth:', authData);
    const newSocket = io(serverUrl, {
      auth: authData,
      withCredentials: true, // Important: send cookies with WebSocket connection
      transports: ['polling'], // Polling-only for debugging
      timeout: 30000, // Even longer timeout for debugging
      reconnection: true,
      reconnectionAttempts: 15, // Reasonable number of attempts
      reconnectionDelay: 2000,   // Slower reconnection for stability
      reconnectionDelayMax: 10000, // Longer max delay
      forceNew: true, // Force new connection for debugging
      upgrade: false,   // Disable upgrades to websocket for now
      rememberUpgrade: false // Don't remember upgrade
    });

    // Connection event handlers with detailed debugging
    newSocket.on('connect', () => {
      console.log('✅ WebSocket connected:', newSocket.id, {
        transport: newSocket.io.engine.transport.name,
        upgraded: newSocket.io.engine.upgraded,
        readyState: newSocket.io.engine.readyState
      });
      setIsConnected(true);
      setConnectionStatus('connected');
      initializingRef.current = false; // Reset initialization flag
    });

    newSocket.on('connected', (data) => {
      console.log('📨 WebSocket welcome message:', data);
    });

    newSocket.on('disconnect', (reason) => {
      console.log('📴 WebSocket disconnected:', reason, {
        transport: newSocket.io?.engine?.transport?.name,
        upgraded: newSocket.io?.engine?.upgraded
      });
      setIsConnected(false);
      setConnectionStatus('disconnected');
      setCurrentRoom(null);
      setActiveUsers([]);
    });

    newSocket.on('connect_error', (error) => {
      console.error('❌ WebSocket connection error:', error.message);
      setConnectionStatus('error');
      initializingRef.current = false; // Reset initialization flag on error
    });

    newSocket.on('reconnect', (attemptNumber) => {
      console.log(`🔄 WebSocket reconnected after ${attemptNumber} attempts`);
      setConnectionStatus('connected');
    });

    newSocket.on('reconnect_error', (error) => {
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
      console.log('👋 User joined room:', activity);
      userActivityCallbacks.current.forEach(callback => {
        try {
          callback(activity);
        } catch (error) {
          console.error('Error in user activity callback:', error);
        }
      });
    });

    // Room management handlers
    newSocket.on('joined_attendance', (data) => {
      console.log('✅ Joined attendance room:', data);
      setCurrentRoom(data.roomName);
      
      // Set initial active users from server
      if (data.activeUsers) {
        console.log('👥 Initial active users:', data.activeUsers);
        setActiveUsers(data.activeUsers);
      }
    });

    newSocket.on('left_attendance', (data) => {
      console.log('🚪 Left attendance room:', data);
      setCurrentRoom(null);
      setActiveUsers([]);
    });

    // Handle room users updates
    newSocket.on('room_users_updated', (update: RoomUsersUpdate) => {
      console.log('👥 Room users updated:', update);
      setActiveUsers(update.activeUsers);
      roomUsersCallbacks.current.forEach(callback => {
        try {
          callback(update);
        } catch (error) {
          console.error('Error in room users callback:', error);
        }
      });
    });

    newSocket.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
    });

    // Debug transport events
    newSocket.io.on('upgrade', () => {
      console.log('🔄 Transport upgraded to:', newSocket.io.engine.transport.name);
    });
    
    newSocket.io.on('upgradeError', (error) => {
      console.error('❌ Transport upgrade error:', error);
    });

    setSocket(newSocket);

    // Cleanup on unmount or user change
    return () => {
      console.log('🧹 Cleaning up WebSocket connection');
      initializingRef.current = false; // Reset flag during cleanup
      newSocket.disconnect();
    };
  }, [user]); // Depend on user to reconnect when auth changes

  // Join attendance room
  const joinAttendanceRoom = (gatheringId: number, date: string) => {
    if (!socket || !isConnected) {
      console.warn('⚠️ Cannot join room: WebSocket not connected');
      return;
    }

    console.log(`📋 Joining attendance room: gathering ${gatheringId}, date ${date}`);
    socket.emit('join_attendance', { gatheringId, date });
  };

  // Leave attendance room
  const leaveAttendanceRoom = (gatheringId: number, date: string) => {
    if (!socket || !isConnected) {
      console.warn('⚠️ Cannot leave room: WebSocket not connected');
      return;
    }

    console.log(`🚪 Leaving attendance room: gathering ${gatheringId}, date ${date}`);
    socket.emit('leave_attendance', { gatheringId, date });
  };

  // Subscribe to attendance updates
  const onAttendanceUpdate = (callback: (update: AttendanceUpdate) => void): (() => void) => {
    attendanceCallbacks.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      attendanceCallbacks.current.delete(callback);
    };
  };

  // Subscribe to visitor updates
  const onVisitorUpdate = (callback: (update: VisitorUpdate) => void): (() => void) => {
    visitorCallbacks.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      visitorCallbacks.current.delete(callback);
    };
  };

  // Subscribe to user activity
  const onUserActivity = (callback: (activity: UserActivity) => void): (() => void) => {
    userActivityCallbacks.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      userActivityCallbacks.current.delete(callback);
    };
  };

  // Subscribe to room users updates
  const onRoomUsersUpdate = (callback: (update: RoomUsersUpdate) => void): (() => void) => {
    roomUsersCallbacks.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      roomUsersCallbacks.current.delete(callback);
    };
  };

  // Get current room
  const getCurrentRoom = (): string | null => {
    return currentRoom;
  };

  // Get connection statistics
  const getConnectionStats = () => {
    return {
      connected: isConnected,
      room: currentRoom,
      socketId: socket?.id || null
    };
  };

  const value: WebSocketContextType = {
    socket,
    isConnected,
    connectionStatus,
    activeUsers,
    joinAttendanceRoom,
    leaveAttendanceRoom,
    onAttendanceUpdate,
    onVisitorUpdate,
    onUserActivity,
    onRoomUsersUpdate,
    getCurrentRoom,
    getConnectionStats
  };

  return (
    <WebSocketContext.Provider value={value}>
      {children}
    </WebSocketContext.Provider>
  );
};

// Custom hook to use WebSocket context
export const useWebSocket = (): WebSocketContextType => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};
