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
  sendAttendanceUpdate: (gatheringId: number, date: string, records: Array<{ individualId: number; present: boolean }>) => Promise<void>;
  loadAttendanceData: (gatheringId: number, date: string) => Promise<{ attendanceList: any[]; visitors: any[] }>;
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
  const tabId = useRef(Math.random().toString(36).substr(2, 9));
  console.log(`🔌 WebSocketProvider initialized for tab ${tabId.current}`);
  
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
  
  // Connection management with stable user reference
  const userRef = useRef(user);
  userRef.current = user;

  useEffect(() => {
    // Only connect if user is authenticated and has a valid token
    if (!userRef.current) {
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

    // Clean up existing socket if it exists (each tab needs its own connection)
    if (socket) {
      // Always create fresh connections for each tab to ensure proper room management
      console.log(`🔌 [Tab ${tabId.current}] Cleaning up existing socket before creating new one`);
      socket.disconnect();
      setSocket(null);
      setIsConnected(false);
      setConnectionStatus('disconnected');
      setCurrentRoom(null);
      setActiveUsers([]);
    }

    // Prevent multiple initialization attempts
    if (initializingRef.current) {
      console.log(`🔌 [Tab ${tabId.current}] WebSocket initialization already in progress, skipping`);
      return;
    }

    // Set initialization flag
    initializingRef.current = true;

    // Since the app uses cookie-based authentication, we'll use a different approach
    // We'll pass the user info and let the server validate the session via cookies
    const getUserAuthData = () => {
      if (!userRef.current) {
        console.log('🔌 No user available for WebSocket auth');
        return null;
      }
      
      console.log('🔌 User data for WebSocket auth:', {
        id: userRef.current.id,
        email: userRef.current.email,
        role: userRef.current.role,
        church_id: userRef.current.church_id
      });
      
      // Generate a temporary token for WebSocket auth using user data
      // The server will still validate the actual session via cookies
      // If church_id is missing, we'll use a fallback (the user must have access to some church data 
      // since they can use the REST API)
      const churchId = userRef.current.church_id || '1'; // Fallback to '1' if missing
      
      console.log('🔌 Church ID resolution:', {
        userChurchId: userRef.current.church_id,
        resolvedChurchId: churchId,
        usingFallback: !userRef.current.church_id,
        isPWA: window.matchMedia && window.matchMedia('(display-mode: standalone)').matches,
        userAgent: navigator.userAgent.includes('PWA') ? 'PWA' : 'Browser'
      });
      
      return {
        userId: userRef.current.id,
        email: userRef.current.email,
        role: userRef.current.role,
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
    // In Docker development, ensure we connect through nginx on port 80
    let serverUrl = process.env.REACT_APP_SERVER_URL;
    
    if (!serverUrl) {
      // If no explicit server URL, construct it based on current location
      const protocol = window.location.protocol;
      const hostname = window.location.hostname;
      let port = window.location.port;
      
      // Handle port logic for Docker development
      if (port === '3000') {
        // Client is on port 3000, connect through nginx on port 80
        port = '80';
      } else if (!port || port === '') {
        // No port specified, default to 80 for HTTP
        port = '80';
      }
      
      serverUrl = `${protocol}//${hostname}:${port}`;
    }
    
    console.log('🔌 WebSocket serverUrl resolution:', {
      REACT_APP_SERVER_URL: process.env.REACT_APP_SERVER_URL,
      NODE_ENV: process.env.NODE_ENV,
      'window.location.origin': window.location.origin,
      'resolved serverUrl': serverUrl
    });

    console.log(`🔌 [Tab ${tabId.current}] Initializing WebSocket connection...`, {
      serverUrl,
      authData,
      userAuthenticated: !!userRef.current
    });

    // Create socket connection with fallback from WebSocket to polling
    const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    console.log(`🔌 [Tab ${tabId.current}] Creating socket connection to:`, serverUrl, 'with auth:', authData, 'isPWA:', isPWA);
    
    // Tab-specific configuration to prevent conflicts
    const connectionId = `${authData.userId}_${tabId.current}_${Date.now()}`;
    const socketConfig = {
      auth: { 
        ...authData, 
        tabId: tabId.current,
        connectionId: connectionId
      }, // Include tab ID and unique connection ID
      withCredentials: true, // Important: send cookies with WebSocket connection
      transports: ['polling', 'websocket'], // Start with polling, upgrade to WebSocket
      timeout: 10000, // 10 second timeout
      reconnection: true,
      reconnectionAttempts: 3, // Fewer attempts, faster failure detection
      reconnectionDelay: 1000, // 1 second delay
      reconnectionDelayMax: 5000, // 5 second max delay  
      forceNew: true, // Force new connection per tab to prevent conflicts
      upgrade: true, // Enable upgrade to WebSocket
      rememberUpgrade: true, // Remember the upgraded transport
      autoConnect: true, // Automatically connect
      // Add query parameters to make connection even more unique
      query: {
        tabId: tabId.current,
        connectionId: connectionId,
        timestamp: Date.now()
      }
    };
    
    console.log(`🔌 [Tab ${tabId.current}] Socket config for ${isPWA ? 'PWA' : 'Browser'}:`, socketConfig);
    
    const newSocket = io(serverUrl, socketConfig);

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
      
      // For unexpected disconnections, provide user feedback
      if (reason === 'transport close' || reason === 'transport error') {
        console.log('🔄 Unexpected disconnection detected, WebSocket will attempt to reconnect automatically');
      }
    });

    newSocket.on('connect_error', (error) => {
      console.error('❌ WebSocket connection error:', error.message);
      console.log('🔍 Connection details:', {
        serverUrl,
        transport: newSocket.io.opts.transports,
        forceNew: newSocket.io.opts.forceNew,
        upgrade: newSocket.io.opts.upgrade,
        attemptNumber: (newSocket as any).reconnectionAttempts || 0
      });
      setIsConnected(false);
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
      const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
      console.log(`📊 [${isPWA ? 'PWA' : 'Browser'}] Received attendance update:`, {
        ...update,
        socketId: newSocket.id,
        currentRoom: currentRoom
      });
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
      const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
      console.log(`✅ [${isPWA ? 'PWA' : 'Browser'}] Joined attendance room:`, {
        ...data,
        socketId: newSocket.id,
        authChurchId: authData?.churchId,
        isPWAMode: isPWA
      });
      setCurrentRoom(data.roomName);
      
      // Set initial active users from server
      if (data.activeUsers) {
        console.log(`👥 [${isPWA ? 'PWA' : 'Browser'}] Initial active users:`, data.activeUsers);
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
      if (socket) {
        console.log('🧹 Cleaning up WebSocket connection');
        initializingRef.current = false; // Reset flag during cleanup
        socket.disconnect();
      }
    };
  }, [user?.id]); // Trigger connection when user becomes available (use stable user.id to prevent unnecessary reconnects)

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

  // Send attendance update via WebSocket
  const sendAttendanceUpdate = async (gatheringId: number, date: string, records: Array<{ individualId: number; present: boolean }>): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!socket || !isConnected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      console.log(`📤 Sending attendance update via WebSocket: gathering ${gatheringId}, date ${date}`, records);
      
      // Set up one-time listeners for response
      const handleSuccess = () => {
        socket.off('attendance_update_error', handleError);
        resolve();
      };
      
      const handleError = (error: any) => {
        socket.off('attendance_update_success', handleSuccess);
        reject(new Error(error.message || 'Failed to update attendance'));
      };

      socket.once('attendance_update_success', handleSuccess);
      socket.once('attendance_update_error', handleError);

      // Send the update
      socket.emit('record_attendance', {
        gatheringId,
        date,
        records
      });

      // Add timeout to prevent hanging
      setTimeout(() => {
        socket.off('attendance_update_success', handleSuccess);
        socket.off('attendance_update_error', handleError);
        reject(new Error('WebSocket attendance update timeout'));
      }, 10000); // 10 second timeout
    });
  };

  // Load attendance data via WebSocket
  const loadAttendanceData = async (gatheringId: number, date: string): Promise<{ attendanceList: any[]; visitors: any[] }> => {
    return new Promise((resolve, reject) => {
      if (!socket || !isConnected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      console.log(`📤 Loading attendance data via WebSocket: gathering ${gatheringId}, date ${date}`);
      
      // Set up one-time listeners for response
      const handleSuccess = (data: any) => {
        socket.off('load_attendance_error', handleError);
        resolve({
          attendanceList: data.attendanceList || [],
          visitors: data.visitors || []
        });
      };
      
      const handleError = (error: any) => {
        socket.off('load_attendance_success', handleSuccess);
        reject(new Error(error.message || 'Failed to load attendance data'));
      };

      socket.once('load_attendance_success', handleSuccess);
      socket.once('load_attendance_error', handleError);

      // Send the load request
      socket.emit('load_attendance', {
        gatheringId,
        date
      });

      // Add timeout to prevent hanging
      setTimeout(() => {
        socket.off('load_attendance_success', handleSuccess);
        socket.off('load_attendance_error', handleError);
        reject(new Error('WebSocket load attendance timeout'));
      }, 10000); // 10 second timeout
    });
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
    sendAttendanceUpdate,
    loadAttendanceData,
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
