import React, { createContext, useState, useEffect, useRef, useCallback, ReactNode, useContext } from 'react';
import io from 'socket.io-client';
import { useAuth } from './AuthContext';
import { useToast } from './ToastContext';
import { useSettings } from './SettingsContext';
import { useNavigate } from 'react-router-dom';
// Simple translation placeholder
const useTranslation = () => {
  return {
    t: (key: string) => key,
    i18n: {
      changeLanguage: () => Promise.resolve(),
    },
  };
};

// Define event types for type safety
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
  socket: ReturnType<typeof io> | null;
  isConnected: boolean;
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' | 'offline';
  isOfflineMode: boolean;
  activeUsers: ActiveUser[];
  sendAttendanceUpdate: (gatheringId: number, date: string, records: Array<{ individualId: number; present: boolean }>) => Promise<void>;
  sendHeadcountUpdate: (gatheringId: number, date: string, headcount: number, mode?: string) => Promise<void>;
  loadAttendanceData: (gatheringId: number, date: string) => Promise<{ attendanceList: any[]; visitors: any[] }>;
  onAttendanceUpdate: (callback: (update: AttendanceUpdate) => void) => () => void;
  onVisitorUpdate: (callback: (update: VisitorUpdate) => void) => () => void;
  onUserActivity: (callback: (activity: UserActivity) => void) => () => void;
  onRoomUsersUpdate: (callback: (update: RoomUsersUpdate) => void) => () => void;
  getCurrentRoom: () => string | null;
  getConnectionStats: () => { connected: boolean; room: string | null; socketId: string | null };
  retryConnection: () => void;
}

const WebSocketContext = createContext<WebSocketContextType | null>(null);

interface WebSocketProviderProps {
  children: ReactNode;
}

export const WebSocketProvider: React.FC<WebSocketProviderProps> = ({ children }) => {
  // Generate unique tab ID that distinguishes between browser tabs and PWA
  const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  const tabId = useRef(`${isPWA ? 'pwa' : 'tab'}_${Math.random().toString(36).substr(2, 9)}`);
  const providerInitialized = useRef(false);
  
  if (!providerInitialized.current) {
    console.log(`🔌 WebSocketProvider initialized for ${isPWA ? 'PWA' : 'browser tab'} ${tabId.current}`);
    providerInitialized.current = true;
  }
  
  const { user, refreshTokenAndUserData } = useAuth();
  const [socket, setSocket] = useState<ReturnType<typeof io> | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error' | 'offline'>('disconnected');
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [activeUsers, setActiveUsers] = useState<ActiveUser[]>([]);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  
  // Flag to prevent multiple initialization attempts
  const initializingRef = useRef(false);
  const connectionAttemptsRef = useRef(0);
  const lastConnectionAttemptRef = useRef(0);
  const connectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
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

    // CRITICAL: Verify user has church_id before attempting connection
    // This prevents "Church ID mismatch" errors when cached data is stale
    // (e.g., same user logging in from multiple locations)
    if (!userRef.current.church_id) {
      console.log('🔌 User data incomplete (missing church_id), skipping WebSocket connection until validated');
      // Cache-first loading will trigger auth validation which will update the user
      // When user is updated with church_id, this effect will re-run
      return;
    }

    // Clean up existing socket if it exists (only if user changed)
    if (socket) {
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

    // Prevent connection if already connected
    if (socket && isConnected) {
      console.log(`🔌 [Tab ${tabId.current}] WebSocket already connected, skipping reconnection`);
      return;
    }

    // Debounce rapid connection attempts (minimum 1 second between attempts)
    const now = Date.now();
    if (now - lastConnectionAttemptRef.current < 1000) {
      console.log(`🔌 [Tab ${tabId.current}] Connection attempt too soon, debouncing...`);
      return;
    }
    lastConnectionAttemptRef.current = now;

    // Set initialization flag and increment connection attempts
    initializingRef.current = true;
    connectionAttemptsRef.current += 1;

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
      // If church_id is missing, we'll refresh the user data to get the latest church_id
      // This prevents church ID mismatch errors
      if (!userRef.current.church_id) {
        console.log('🔌 No church_id found in user data, refreshing user data before WebSocket connection');
        // Return null to prevent connection attempt until we have refreshed user data
        refreshTokenAndUserData().then(() => {
          // Connection will be retried on next user update
          console.log('🔌 User data refreshed, WebSocket connection will be retried');
          initializingRef.current = false;
        });
        return null;
      }
      
      const churchId = userRef.current.church_id;
      
      console.log('🔌 Church ID resolution:', {
        userChurchId: userRef.current.church_id,
        resolvedChurchId: churchId,
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
      initializingRef.current = false;
      return;
    }

    setConnectionStatus('connecting');

    // Use relative URL for WebSocket connection to match API configuration
    const serverUrl = window.location.origin;
    
    console.log('🔌 WebSocket serverUrl resolution:', {
      serverUrl,
      origin: window.location.origin,
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      port: window.location.port
    });

    console.log(`🔌 [Tab ${tabId.current}] Initializing WebSocket connection...`, {
      serverUrl,
      authData,
      userAuthenticated: !!userRef.current
    });

    // Add a small delay to ensure server is ready
    setTimeout(() => {
      createSocketConnection(serverUrl, authData, tabId, initializingRef, connectionAttemptsRef, lastConnectionAttemptRef);
    }, 100);
  }, [user?.id]); // Trigger connection when user becomes available (use stable user.id to prevent unnecessary reconnects)

  // Separate function for socket creation to avoid closure issues
  const createSocketConnection = (serverUrl: string, authData: any, tabId: React.MutableRefObject<string>, initializingRef: React.MutableRefObject<boolean>, connectionAttemptsRef: React.MutableRefObject<number>, lastConnectionAttemptRef: React.MutableRefObject<number>) => {
    // Create socket connection with fallback from WebSocket to polling
    const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    // Optimized configuration for better stability and multi-tab support
    const connectionId = `${authData.userId}_${tabId.current}_${Date.now()}`;
    
    // Track connection state for retry logic
    const connectionState = {
      hasEverConnected: false,
      reconnectAttemptCount: 0
    };
    
    console.log(`🔌 Creating WebSocket connection for ${isPWA ? 'PWA' : 'browser tab'}`, {
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
      withCredentials: true, // Important: send cookies with WebSocket connection
      transports: ['websocket', 'polling'], // Try WebSocket first, fallback to polling
      timeout: 10000, // 10-second timeout to allow retry attempts to complete
      reconnection: true,
      reconnectionAttempts: 5, // Increased attempts for better reliability
      reconnectionDelay: 1000, // Initial reconnection delay
      reconnectionDelayMax: 5000, // Max delay between attempts
      randomizationFactor: 0.5, // Add some randomization to prevent thundering herd
      forceNew: true, // Force new connection for each tab/PWA to prevent conflicts
      upgrade: true, // Enable upgrade to WebSocket
      rememberUpgrade: false, // Don't remember upgrade to allow fresh connections
      autoConnect: true, // Automatically connect
      // Simplified query parameters
      query: {
        tabId: tabId.current,
        connectionId: connectionId
      },
      // Optimized stability settings
      pingTimeout: 30000, // Reduced ping timeout
      pingInterval: 15000, // Reduced ping interval for faster detection
      maxReconnectionAttempts: 5
    };
    
    // Socket configuration optimized for multi-tab support
    
    const newSocket = io(serverUrl, socketConfig);

    // Set up offline mode timeout - increased to allow socket.io retry mechanism to complete
    // Calculate timeout: initial delay + (reconnectionAttempts * maxDelay) + buffer
    // 1000ms initial + (5 attempts * 5000ms max) + 5000ms buffer = ~35 seconds
    const OFFLINE_TIMEOUT_MS = 35000;
    connectionTimeoutRef.current = setTimeout(() => {
      // Only enter offline mode if browser is online (if browser is offline, we already handled it via event listener)
      if (!navigator.onLine) {
        console.log(`📴 Browser is offline - offline mode already active`);
        return;
      }
      
      if (!newSocket.connected && !connectionState.hasEverConnected) {
        console.log(`⏰ [Tab ${tabId.current}] Connection timeout after ${OFFLINE_TIMEOUT_MS}ms - entering offline mode`);
        console.log(`📦 [Tab ${tabId.current}] Offline mode: App will continue to function with cached data`);
        setIsOfflineMode(true);
        setConnectionStatus('offline');
        initializingRef.current = false;
      }
    }, OFFLINE_TIMEOUT_MS);

    // Connection event handlers
    newSocket.on('connect', () => {
      console.log(`✅ [Tab ${tabId.current}] WebSocket connected:`, newSocket.id);
      connectionState.hasEverConnected = true;
      setIsConnected(true);
      setConnectionStatus('connected');
      
      // Only exit offline mode if browser is online (don't exit if browser is offline)
      if (navigator.onLine) {
        setIsOfflineMode(false); // Exit offline mode
      } else {
        console.log(`📴 Browser is offline - keeping offline mode active despite WebSocket connection`);
      }
      
      initializingRef.current = false; // Reset initialization flag
      connectionAttemptsRef.current = 0; // Reset connection attempts on success
      lastConnectionAttemptRef.current = 0; // Reset last attempt time
      connectionState.reconnectAttemptCount = 0; // Reset reconnect attempt count
      
      // Clear the offline timeout since we're connected
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    });

    newSocket.on('connected', (data) => {
      console.log(`📨 [Tab ${tabId.current}] WebSocket welcome message:`, data);
    });

    newSocket.on('disconnect', (reason: string) => {
      console.log(`📴 [Tab ${tabId.current}] WebSocket disconnected:`, reason);
      setIsConnected(false);
      setConnectionStatus('disconnected');
      setCurrentRoom(null);
      setActiveUsers([]);
      
      // Set connecting status for reconnection attempts
      if (reason !== 'io client disconnect') {
        setConnectionStatus('connecting');
      }
    });

    newSocket.on('connect_error', async (error: Error) => {
      console.error(`❌ [Tab ${tabId.current}] WebSocket connection error:`, error.message);
      
      // Check if this is a church ID mismatch error and try to fix it
      if (error.message && error.message.includes('Church ID mismatch')) {
        console.log(`🔧 [Tab ${tabId.current}] Detected church ID mismatch - attempting to refresh token and user data`);
        try {
          const refreshSuccess = await refreshTokenAndUserData();
          if (refreshSuccess) {
            console.log(`✅ [Tab ${tabId.current}] Token and user data refreshed successfully - will retry connection on next attempt`);
            // The WebSocket will automatically retry and should work with the fresh token
            // Don't reset initializingRef here - let socket.io handle the retry
          } else {
            console.log(`❌ [Tab ${tabId.current}] Failed to refresh token and user data - falling back to page refresh`);
            window.location.reload();
          }
          return;
        } catch (refreshError) {
          console.error(`❌ [Tab ${tabId.current}] Failed to handle church ID mismatch:`, refreshError);
          console.log(`🔄 [Tab ${tabId.current}] Falling back to page refresh`);
          window.location.reload();
          return;
        }
      }
      
      // Check if this is a server unavailable error (timeout, connection refused, etc.)
      if (error.message && (
        error.message.includes('timeout') || 
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('Network Error') ||
        error.message.includes('Failed to fetch')
      )) {
        console.log(`🌐 [Tab ${tabId.current}] Server appears to be unavailable - socket.io will retry automatically`);
        // Keep status as 'connecting' to show retry is in progress
        setConnectionStatus('connecting');
        // Don't reset initializingRef - let socket.io handle retries
        return;
      }
      
      // For other errors, still allow socket.io to retry
      setIsConnected(false);
      setConnectionStatus('connecting'); // Keep as 'connecting' to allow retries
      // Don't reset initializingRef on error - let socket.io handle retries
    });

    newSocket.on('reconnect_attempt', (attemptNumber: number) => {
      connectionState.reconnectAttemptCount = attemptNumber;
      console.log(`🔄 [Tab ${tabId.current}] WebSocket reconnection attempt ${attemptNumber}...`);
      setConnectionStatus('connecting');
      // Reset the offline timeout on each retry attempt to give it more time
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
      connectionTimeoutRef.current = setTimeout(() => {
        // Only enter offline mode if browser is online (if browser is offline, we already handled it)
        if (!navigator.onLine) {
          console.log(`📴 Browser is offline - offline mode already active`);
          return;
        }
        
        if (!newSocket.connected && !connectionState.hasEverConnected) {
          console.log(`⏰ [Tab ${tabId.current}] Connection timeout after retry attempts - entering offline mode`);
          setIsOfflineMode(true);
          setConnectionStatus('offline');
          initializingRef.current = false;
        }
      }, OFFLINE_TIMEOUT_MS);
    });

    newSocket.on('reconnect', (attemptNumber: number) => {
      console.log(`🔄 [Tab ${tabId.current}] WebSocket reconnected after ${attemptNumber} attempts`);
      connectionState.hasEverConnected = true;
      setConnectionStatus('connected');
      connectionState.reconnectAttemptCount = 0;
      
      // Clear the offline timeout since we're connected
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    });

    newSocket.on('reconnect_error', (error: Error) => {
      console.error(`❌ [Tab ${tabId.current}] WebSocket reconnection error (attempt ${connectionState.reconnectAttemptCount}):`, error.message);
      // Keep status as 'connecting' to show retry is still in progress
      setConnectionStatus('connecting');
    });

    newSocket.on('reconnect_failed', () => {
      console.error(`❌ [Tab ${tabId.current}] WebSocket reconnection failed after all attempts`);
      
      // Check if browser is offline - if so, enter offline mode immediately
      if (!navigator.onLine) {
        console.log(`📴 Browser is offline - entering offline mode`);
        setIsOfflineMode(true);
        setConnectionStatus('offline');
        initializingRef.current = false;
        return; // Don't retry if browser is offline
      }
      
      setConnectionStatus('error');
      initializingRef.current = false; // Allow manual retry after all automatic retries fail
      
      // Set up a delayed retry mechanism - wait 10 seconds then try again
      // Only if browser is still online
      setTimeout(() => {
        if (!navigator.onLine) {
          console.log(`📴 Browser went offline during delayed retry - entering offline mode`);
          setIsOfflineMode(true);
          setConnectionStatus('offline');
          return;
        }
        
        if (!newSocket.connected && userRef.current) {
          console.log(`🔄 [Tab ${tabId.current}] Attempting delayed retry after reconnect_failed...`);
          // Reset flags to allow retry
          initializingRef.current = false;
          connectionAttemptsRef.current = 0;
          lastConnectionAttemptRef.current = 0;
          // Trigger reconnection by disconnecting and reconnecting
          newSocket.disconnect();
          newSocket.connect();
        }
      }, 10000); // Wait 10 seconds before delayed retry
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

    // Room management handlers (DISABLED - server uses manual broadcasting)
    // These handlers are kept for compatibility but the server doesn't send these events
    newSocket.on('joined_attendance', (data) => {
      console.log('📋 Room system disabled - ignoring joined_attendance event:', data);
    });

    newSocket.on('left_attendance', (data) => {
      console.log('📋 Room system disabled - ignoring left_attendance event:', data);
    });

    newSocket.on('room_users_updated', (update: RoomUsersUpdate) => {
      console.log('📋 Room system disabled - ignoring room_users_updated event:', update);
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
  }; // End of createSocketConnection function

  // Listen for browser offline/online events to immediately enter/exit offline mode
  useEffect(() => {
    const handleOnline = () => {
      console.log('🌐 Browser came online - attempting WebSocket reconnection');
      setIsOfflineMode(false);
      // If socket exists but not connected, trigger reconnection
      if (socket && !socket.connected && userRef.current) {
        socket.connect();
      }
    };

    const handleOffline = () => {
      console.log('📴 Browser went offline - entering offline mode immediately');
      setIsOfflineMode(true);
      setConnectionStatus('offline');
      // Clear any pending timeout since we're already offline
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
        connectionTimeoutRef.current = null;
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Check initial network status
    if (!navigator.onLine) {
      console.log('📴 Browser is offline on page load - entering offline mode');
      setIsOfflineMode(true);
      setConnectionStatus('offline');
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [socket]);

  // Cleanup on unmount or user change
  useEffect(() => {
    return () => {
      if (socket) {
        console.log('🧹 Cleaning up WebSocket connection');
        initializingRef.current = false; // Reset flag during cleanup
        socket.disconnect();
      }
    };
  }, [socket]);


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
      
      const handleError = (error: { message?: string }) => {
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

  // Send headcount update via WebSocket
  const sendHeadcountUpdate = async (gatheringId: number, date: string, headcount: number, mode: string = 'combined'): Promise<void> => {
    return new Promise((resolve, reject) => {
      if (!socket || !isConnected) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      console.log(`📤 Sending headcount update via WebSocket: gathering ${gatheringId}, date ${date}, headcount ${headcount}, mode ${mode}`);
      
      // Set up one-time listeners for response
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

      // Send the update
      socket.emit('update_headcount', {
        gatheringId,
        date,
        headcount,
        mode
      });

      // Add timeout to prevent hanging
      setTimeout(() => {
        socket.off('headcount_update_success', handleSuccess);
        socket.off('headcount_update_error', handleError);
        reject(new Error('WebSocket headcount update timeout'));
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
  const onAttendanceUpdate = useCallback((callback: (update: AttendanceUpdate) => void): (() => void) => {
    attendanceCallbacks.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      attendanceCallbacks.current.delete(callback);
    };
  }, []);

  // Subscribe to visitor updates
  const onVisitorUpdate = useCallback((callback: (update: VisitorUpdate) => void): (() => void) => {
    visitorCallbacks.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      visitorCallbacks.current.delete(callback);
    };
  }, []);


  // Subscribe to user activity
  const onUserActivity = useCallback((callback: (activity: UserActivity) => void): (() => void) => {
    userActivityCallbacks.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      userActivityCallbacks.current.delete(callback);
    };
  }, []);

  // Subscribe to room users updates
  const onRoomUsersUpdate = useCallback((callback: (update: RoomUsersUpdate) => void): (() => void) => {
    roomUsersCallbacks.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      roomUsersCallbacks.current.delete(callback);
    };
  }, []);

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

  // Retry connection function
  const retryConnection = () => {
    // Don't retry if browser is offline
    if (!navigator.onLine) {
      console.log(`📴 Browser is offline - cannot retry connection`);
      setIsOfflineMode(true);
      setConnectionStatus('offline');
      return;
    }
    
    console.log(`🔄 [Tab ${tabId.current}] Manual connection retry requested`);
    setIsOfflineMode(false);
    setConnectionStatus('connecting');
    initializingRef.current = false;
    connectionAttemptsRef.current = 0;
    lastConnectionAttemptRef.current = 0;
    
    // Clear any existing timeout
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    
    // If socket exists, try to reconnect it
    if (socket) {
      socket.disconnect();
      socket.connect();
    } else if (userRef.current) {
      // Trigger reconnection by calling the connection effect
      // This will be handled by the useEffect that watches user?.id
      // Force a re-trigger by updating a dependency
      const currentUser = userRef.current;
      userRef.current = null; // Temporarily clear to allow re-trigger
      setTimeout(() => {
        userRef.current = currentUser;
      }, 100);
    }
  };

  const value: WebSocketContextType = {
    socket,
    isConnected,
    connectionStatus,
    isOfflineMode,
    activeUsers,
    sendAttendanceUpdate,
    sendHeadcountUpdate,
    loadAttendanceData,
    onAttendanceUpdate,
    onVisitorUpdate,
    onUserActivity,
    onRoomUsersUpdate,
    getCurrentRoom,
    getConnectionStats,
    retryConnection
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
