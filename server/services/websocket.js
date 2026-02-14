const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('../config/logger');
const Database = require('../config/database');

class WebSocketService {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // Track user connections
    this.attendanceRooms = new Map(); // Track room subscriptions
    this.recentUpdates = new Map(); // Track recent updates for deduplication
    this.churchSockets = new Map(); // Track sockets by church ID for efficient broadcasting
  }

  /**
   * Initialize WebSocket server
   * @param {http.Server} server - HTTP server instance
   */
  initialize(server) {
    try {
      this.io = new Server(server, {
        cors: {
          origin: process.env.CLIENT_URL || true,
          methods: ['GET', 'POST'],
          credentials: true
        },
        // Connection stability settings - generous timeouts for mobile/background tabs
        pingTimeout: 60000, // 60s timeout to handle mobile throttling and slow proxies
        pingInterval: 25000, // 25s interval - less aggressive to reduce unnecessary disconnects
        transports: ['websocket', 'polling'],
        // Additional stability settings
        allowEIO3: true, // Backward compatibility
        maxHttpBufferSize: 1e6, // 1MB buffer size
        connectTimeout: 8000, // 8 second connection timeout
        // Connection management
        allowUpgrades: true,
        perMessageDeflate: false // Disable compression for better performance
      });

      this.setupAuthentication();
      this.setupConnectionHandling();
      
      // Set up periodic cleanup of deduplication entries
      this.cleanupInterval = setInterval(() => {
        this.cleanupRecentUpdates();
        this.cleanupStaleConnections();
      }, 30000); // Clean up every 30 seconds
      
      logger.info('WebSocket service initialized successfully');
      return this.io;
    } catch (error) {
      console.error('❌ Failed to initialize WebSocket service:', error);
      throw error;
    }
  }

  /**
   * Setup authentication middleware for WebSocket connections
   * Uses JWT token validation like the REST API for security
   */
  setupAuthentication() {
    this.io.use(async (socket, next) => {
      try {
        const jwt = require('jsonwebtoken');
        const Database = require('../config/database');
        
        // Extract JWT token from cookies (same as REST API)
        let token = null;
        
        // Parse cookies from handshake headers
        const cookieHeader = socket.handshake.headers.cookie;
        if (cookieHeader) {
          const cookies = cookieHeader.split('; ');
          const authTokenCookie = cookies.find(cookie => cookie.startsWith('authToken='));
          if (authTokenCookie) {
            token = authTokenCookie.split('=')[1];
          }
        }
        
        // Also check auth data as fallback (but verify it)
        const authData = socket.handshake.auth;
        
        logger.debugLog('WebSocket auth attempt', {
          hasToken: !!token,
          hasAuthData: !!authData,
          authDataKeys: authData ? Object.keys(authData) : 'none',
          cookieHeader: cookieHeader ? 'present' : 'missing'
        });
        
        if (!token) {
          logger.warn('WebSocket auth failed: no token found', {
            socketId: socket.id,
            cookieHeader: cookieHeader ? 'present but no authToken' : 'missing'
          });
          return next(new Error('Authentication required - no token'));
        }

        // Verify JWT token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Get user details from database to ensure they still exist and are active
        const users = await Database.query(
          'SELECT id, email, role, first_name, last_name, is_active, church_id FROM users WHERE id = ? AND is_active = true',
          [decoded.userId]
        );

        if (users.length === 0) {
          logger.warn('WebSocket auth failed: user not found or inactive', {
            socketId: socket.id,
            userId: decoded.userId
          });
          return next(new Error('User not found or inactive'));
        }

        const user = users[0];
        const churchId = decoded.churchId || user.church_id;
        
        // Verify auth data matches token if provided
        if (authData) {
          if (authData.userId && authData.userId !== decoded.userId) {
            logger.warn('WebSocket auth failed: user ID mismatch', {
              socketId: socket.id,
              tokenUserId: decoded.userId,
              authDataUserId: authData.userId
            });
            return next(new Error('Authentication data mismatch'));
          }
          
          if (authData.churchId && authData.churchId !== churchId) {
            logger.warn('WebSocket auth failed: church ID mismatch', {
              socketId: socket.id,
              tokenChurchId: churchId,
              authDataChurchId: authData.churchId
            });
            return next(new Error('Church ID mismatch'));
          }
        }
        
        // Add verified user info to socket
        socket.userId = user.id;
        socket.userEmail = user.email;
        socket.userRole = user.role;
        socket.churchId = churchId;

        logger.info('WebSocket authentication successful', {
          userId: socket.userId,
          email: socket.userEmail,
          role: socket.userRole,
          churchId: socket.churchId,
          socketId: socket.id
        });

        next();
      } catch (error) {
        console.error('❌ WebSocket authentication error:', error);
        
        let errorMessage = 'Authentication failed';
        if (error.name === 'TokenExpiredError') {
          errorMessage = 'Token expired';
        } else if (error.name === 'JsonWebTokenError') {
          errorMessage = 'Invalid token';
        }
        
        logger.warn('WebSocket authentication failed', {
          error: error.message,
          errorName: error.name,
          socketId: socket.id
        });
        
        next(new Error(errorMessage));
      }
    });
  }

  /**
   * Setup connection and disconnection handling
   */
  setupConnectionHandling() {
    this.io.on('connection', (socket) => {
      const userKey = `${socket.churchId}:${socket.userId}`;
      logger.debugLog('New connection attempt', {
        socketId: socket.id,
        userId: socket.userId,
        churchId: socket.churchId,
        totalClients: this.io.engine.clientsCount,
        existingUserConnections: this.connectedUsers.get(userKey)?.size || 0,
        tabId: socket.handshake?.auth?.tabId,
        connectionId: socket.handshake?.auth?.connectionId
      });
      this.handleConnection(socket);
    });
  }

  /**
   * Handle new WebSocket connection
   * @param {Socket} socket - Socket.io socket instance
   */
  handleConnection(socket) {
    const userKey = `${socket.churchId}:${socket.userId}`;
    
    // Track user connection
    if (!this.connectedUsers.has(userKey)) {
      this.connectedUsers.set(userKey, new Set());
    }
    this.connectedUsers.get(userKey).add(socket.id);

    // Track socket by church ID for efficient broadcasting
    if (!this.churchSockets.has(socket.churchId)) {
      this.churchSockets.set(socket.churchId, new Set());
    }
    this.churchSockets.get(socket.churchId).add(socket.id);

    logger.debugLog('WebSocket client connected', {
      socketId: socket.id,
      userId: socket.userId,
      churchId: socket.churchId,
      userRole: socket.userRole,
      totalConnections: this.io.engine.clientsCount,
      userConnections: this.connectedUsers.get(userKey).size,
      allUserKeys: Array.from(this.connectedUsers.keys())
    });

    logger.info('WebSocket client connected', {
      socketId: socket.id,
      userId: socket.userId,
      churchId: socket.churchId,
      userRole: socket.userRole,
      totalConnections: this.io.engine.clientsCount
    });

    // Handle attendance room subscription (DISABLED - using manual broadcasting for better UX)
    // Room-based broadcasting is too restrictive - only users viewing the exact same 
    // gathering/date would receive updates. Manual broadcasting ensures all church users 
    // see real-time updates regardless of which gathering they're currently viewing.
    // socket.on('join_attendance', (data) => {
    //   this.handleJoinAttendance(socket, data);
    // });

    // Handle leaving attendance room (DISABLED - using manual broadcasting for better UX)
    // socket.on('leave_attendance', (data) => {
    //   this.handleLeaveAttendance(socket, data);
    // });

    // Handle recording attendance via WebSocket
    socket.on('record_attendance', (data) => {
      this.handleRecordAttendance(socket, data);
    });

    // Handle loading attendance data via WebSocket
    socket.on('load_attendance', (data) => {
      this.handleLoadAttendance(socket, data);
    });

    // Handle headcount updates via WebSocket
    socket.on('update_headcount', (data) => {
      this.handleUpdateHeadcount(socket, data);
    });

    // Handle headcount mode updates via WebSocket
    socket.on('update_headcount_mode', (data) => {
      this.handleUpdateHeadcountMode(socket, data);
    });

    // Handle loading headcount data via WebSocket
    socket.on('load_headcount', (data) => {
      this.handleLoadHeadcount(socket, data);
    });

    // Handle ping for connection health
    socket.on('ping', () => {
      socket.emit('pong');
    });

    // Handle test messages for debugging
    socket.on('test_message', (data) => {
      logger.debugLog('WebSocket Test - Message received', {
        socketId: socket.id,
        userId: socket.userId,
        churchId: socket.churchId,
        data: data
      });
      
      // Echo back to sender
      socket.emit('test_echo', {
        ...data,
        echoed: true,
        serverTimestamp: new Date().toISOString(),
        serverSocketId: socket.id
      });

      // Broadcast to all other clients in the same church using the io instance
      const broadcastData = {
        ...data,
        broadcast: true,
        serverTimestamp: new Date().toISOString(),
        fromSocketId: socket.id
      };
      
      logger.debugLog('Broadcasting test message to church', socket.churchId);
      
      // Get sockets for this church only (optimized broadcasting)
      const churchSocketIds = this.churchSockets.get(socket.churchId);
      let broadcastCount = 0;
      
      if (churchSocketIds) {
        churchSocketIds.forEach((socketId) => {
          // Don't send to self, only to other clients in same church
          if (socketId !== socket.id) {
            const clientSocket = this.io.sockets.sockets.get(socketId);
            if (clientSocket) {
              logger.debugLog(`Sending to socket ${socketId} (user ${clientSocket.userId})`);
              clientSocket.emit('test_message', broadcastData);
              broadcastCount++;
            }
          }
        });
      }
      
      logger.debugLog(`Broadcasted to ${broadcastCount} other clients in church ${socket.churchId}`);
    });

    // Handle test room functionality
    socket.on('join_test_room', (data) => {
      this.handleJoinTestRoom(socket, data);
    });

    socket.on('leave_test_room', (data) => {
      this.handleLeaveTestRoom(socket, data);
    });

    socket.on('test_room_message', (data) => {
      this.handleTestRoomMessage(socket, data);
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      this.handleDisconnection(socket, reason);
    });

    // Send welcome message
    socket.emit('connected', {
      message: 'WebSocket connection established',
      userId: socket.userId,
      churchId: socket.churchId
    });
  }

  /**
   * Handle joining an attendance room
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Room data {gatheringId, date}
   */
  handleJoinAttendance(socket, data) {
    try {
      const { gatheringId, date } = data;
      
      if (!gatheringId || !date) {
        socket.emit('error', { message: 'gatheringId and date are required' });
        return;
      }

      const roomName = this.getAttendanceRoomName(gatheringId, date, socket.churchId);
      
      // Join the room
      socket.join(roomName);
      
      // Track room subscription
      if (!this.attendanceRooms.has(roomName)) {
        this.attendanceRooms.set(roomName, new Set());
      }
      this.attendanceRooms.get(roomName).add(socket.id);

      logger.info('User joined attendance room', {
        userId: socket.userId,
        userEmail: socket.userEmail,
        churchId: socket.churchId,
        roomName,
        gatheringId,
        date,
        roomSize: this.attendanceRooms.get(roomName).size,
        allSocketsInRoom: Array.from(this.attendanceRooms.get(roomName))
      });

      // Get current users in the room (including this user)
      const roomUsers = this.getRoomUsers(roomName);

      socket.emit('joined_attendance', {
        roomName,
        gatheringId,
        date,
        message: 'Successfully joined attendance room',
        activeUsers: roomUsers
      });

      // Notify others in the room about new user
      socket.to(roomName).emit('user_joined', {
        userId: socket.userId,
        userEmail: socket.userEmail,
        timestamp: new Date().toISOString()
      });

      // Send updated user list to all users in the room
      this.io.to(roomName).emit('room_users_updated', {
        activeUsers: roomUsers,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Error joining attendance room', {
        error: error.message,
        userId: socket.userId,
        data
      });
      socket.emit('error', { message: 'Failed to join attendance room' });
    }
  }

  /**
   * Handle recording attendance via WebSocket
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Attendance data {gatheringId, date, records}
   */
  async handleRecordAttendance(socket, data) {
    let gatheringId, date, records;
    
    try {
      ({ gatheringId, date, records } = data);
      
      if (!gatheringId || !date || !records || !Array.isArray(records)) {
        socket.emit('attendance_update_error', { message: 'Invalid attendance data' });
        return;
      }

      // Create deduplication key based on user, gathering, date, and records
      const recordsKey = records.map(r => `${r.individualId}:${r.present}`).sort().join(',');
      const dedupeKey = `${socket.userId}:${gatheringId}:${date}:${recordsKey}`;
      const now = Date.now();
      
      // Smart deduplication: only block very rapid duplicates (within 500ms)
      // This prevents double-clicks but allows legitimate updates from different tabs
      if (this.recentUpdates.has(dedupeKey)) {
        const lastUpdate = this.recentUpdates.get(dedupeKey);
        const timeSinceLastUpdate = now - lastUpdate;
        
        if (timeSinceLastUpdate < 500) { // Only block if within 500ms (very rapid duplicate)
          logger.info('Rapid duplicate WebSocket attendance update blocked', {
            userId: socket.userId,
            churchId: socket.churchId,
            gatheringId,
            date,
            recordsCount: records.length,
            timeSinceLastUpdate
          });
          // Still send success to avoid client retries
          socket.emit('attendance_update_success');
          return;
        }
      }
      
      // Track this update
      this.recentUpdates.set(dedupeKey, now);
      
      // Clean up old deduplication entries (older than 5 seconds)
      for (const [key, timestamp] of this.recentUpdates.entries()) {
        if (now - timestamp > 5000) {
          this.recentUpdates.delete(key);
        }
      }

      logger.info('WebSocket attendance update received', {
        userId: socket.userId,
        churchId: socket.churchId,
        gatheringId,
        date,
        recordsCount: records.length
      });

      // Import the attendance recording logic
      const Database = require('../config/database');
      const { columnExists } = require('../utils/databaseSchema');

      await Database.transaction(async (conn) => {
        const hasSessionsChurchId = await columnExists('attendance_sessions', 'church_id');
        
        // Get or create attendance session
        let sessionResult;
        if (hasSessionsChurchId) {
          sessionResult = await conn.query(
            'SELECT * FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
            [gatheringId, date, socket.churchId]
          );
        } else {
          sessionResult = await conn.query(
            'SELECT * FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
            [gatheringId, date]
          );
        }

        let sessionId;
        if (sessionResult.length === 0) {
          // Create session
          const insertSessionQuery = hasSessionsChurchId
            ? 'INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id) VALUES (?, ?, ?, ?)'
            : 'INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by) VALUES (?, ?, ?)';
          const insertSessionParams = hasSessionsChurchId
            ? [gatheringId, date, socket.userId, socket.churchId]
            : [gatheringId, date, socket.userId];
          
          const insertResult = await conn.query(insertSessionQuery, insertSessionParams);
          sessionId = insertResult.insertId;
        } else {
          sessionId = sessionResult[0].id;
        }

        // Check if attendance_records has church_id column
        const hasAttendanceRecordsChurchId = await columnExists('attendance_records', 'church_id');
        
        // Record attendance
        for (const record of records) {
          const { individualId, present } = record;
          
          // Use REPLACE INTO to handle concurrent updates more reliably, same as REST API
          if (hasAttendanceRecordsChurchId) {
            await conn.query(
              'REPLACE INTO attendance_records (session_id, individual_id, present, church_id) VALUES (?, ?, ?, ?)',
              [sessionId, individualId, present, socket.churchId]
            );
          } else {
            await conn.query(
              'REPLACE INTO attendance_records (session_id, individual_id, present) VALUES (?, ?, ?)',
              [sessionId, individualId, present]
            );
          }
          
          // Update last_attendance_date if person is marked present (same as REST API)
          if (present) {
            const hasIndividualsChurchId = await columnExists('individuals', 'church_id');
            if (hasIndividualsChurchId) {
              await conn.query(
                'UPDATE individuals SET last_attendance_date = ? WHERE id = ? AND church_id = ?',
                [date, individualId, socket.churchId]
              );
            } else {
              await conn.query(
                'UPDATE individuals SET last_attendance_date = ? WHERE id = ?',
                [date, individualId]
              );
            }
          }
        }
      });

      // Broadcast to all clients in the same church (optimized church-based broadcasting)
      const broadcastData = {
        type: 'attendance_records',
        gatheringId,
        date,
        records,
        updatedBy: socket.userId,
        updatedAt: new Date().toISOString(),
        timestamp: new Date().toISOString()
      };
      
      logger.debugLog('Broadcasting attendance update to church', socket.churchId);
      
      // Get sockets for this church only (O(church_sockets) instead of O(all_sockets))
      const churchSocketIds = this.churchSockets.get(socket.churchId);
      let broadcastCount = 0;
      
      if (churchSocketIds) {
        churchSocketIds.forEach((socketId) => {
          const clientSocket = this.io.sockets.sockets.get(socketId);
          if (clientSocket) {
            logger.debugLog(`Sending attendance update to socket ${socketId} (user ${clientSocket.userId})`);
            clientSocket.emit('attendance_update', broadcastData);
            broadcastCount++;
          }
        });
      }
      
      logger.debugLog(`Attendance update broadcasted to ${broadcastCount} clients in church ${socket.churchId}`);

      // Send success confirmation to sender
      socket.emit('attendance_update_success');

      logger.info('WebSocket attendance update processed successfully', {
        userId: socket.userId,
        gatheringId,
        date,
        recordsCount: records.length
      });

    } catch (error) {
      logger.error('Error processing WebSocket attendance update', {
        error: error.message,
        stack: error.stack,
        userId: socket.userId,
        churchId: socket.churchId,
        gatheringId,
        date,
        data
      });
      
      // Send detailed error in development, generic error in production
      const errorMessage = process.env.NODE_ENV === 'development' 
        ? `Failed to process attendance update: ${error.message}`
        : 'Failed to process attendance update';
        
      socket.emit('attendance_update_error', { message: errorMessage });
    }
  }

  /**
   * Handle loading attendance data via WebSocket
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Load data {gatheringId, date}
   */
  async handleLoadAttendance(socket, data) {
    let gatheringId, date;
    
    try {
      ({ gatheringId, date } = data);
      
      if (!gatheringId || !date) {
        socket.emit('load_attendance_error', { message: 'gatheringId and date are required' });
        return;
      }

      logger.info('WebSocket load attendance request', {
        userId: socket.userId,
        churchId: socket.churchId,
        gatheringId,
        date
      });

      // Import database and utility functions
      const Database = require('../config/database');
      const { columnExists } = require('../utils/databaseSchema');

      await Database.transaction(async (conn) => {
        // Check schema capabilities
        const hasIndividualsChurchId = await columnExists('individuals', 'church_id');
        const hasAttendanceRecordsChurchId = await columnExists('attendance_records', 'church_id');
        const hasSessionsChurchId = await columnExists('attendance_sessions', 'church_id');
        const hasPeopleTypeAtTime = await columnExists('attendance_records', 'people_type_at_time');

        // Use historical people_type if available
        const peopleTypeExpression = hasPeopleTypeAtTime 
          ? `COALESCE(ar.people_type_at_time, i.people_type) as people_type`
          : `i.people_type`;

        // Load attendance list (same logic as REST API)
        let attendanceListQuery;
        let attendanceListParams;
        
        if (hasIndividualsChurchId) {
          attendanceListQuery = `
            SELECT 
              i.id,
              i.first_name as firstName,
              i.last_name as lastName,
              i.last_attendance_date as lastAttendanceDate,
              ${peopleTypeExpression},
              f.family_name as familyName,
              f.id as familyId,
              COALESCE(ar.present, false) as present
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id AND f.church_id = ?
            LEFT JOIN gathering_lists gl ON i.id = gl.individual_id AND gl.church_id = ?
            LEFT JOIN attendance_sessions ats ON ats.gathering_type_id = ? AND ats.session_date = ? AND ats.church_id = ?
            LEFT JOIN attendance_records ar ON ar.session_id = ats.id AND ar.individual_id = i.id AND ar.church_id = ?
            WHERE i.church_id = ? AND gl.gathering_type_id = ?
            AND (
              (f.family_type = 'regular' AND ${hasPeopleTypeAtTime 
                ? 'COALESCE(ar.people_type_at_time, i.people_type)' 
                : 'i.people_type'} = 'regular') OR 
              (f.family_type IS NULL AND ${hasPeopleTypeAtTime 
                ? 'COALESCE(ar.people_type_at_time, i.people_type)' 
                : 'i.people_type'} = 'regular')
            )
            AND (
              i.is_active = true OR 
              ar.present = 1 OR 
              ar.present = true OR
              -- Include archived people only if they have attendance records for past gatherings
              (i.is_active = false AND ar.present = 1)
            )
            ORDER BY f.family_name, i.first_name, i.last_name
          `;
          attendanceListParams = [socket.churchId, socket.churchId, gatheringId, date, socket.churchId, socket.churchId, socket.churchId, gatheringId];
        } else {
          attendanceListQuery = `
            SELECT 
              i.id,
              i.first_name as firstName,
              i.last_name as lastName,
              i.last_attendance_date as lastAttendanceDate,
              ${peopleTypeExpression},
              f.family_name as familyName,
              f.id as familyId,
              COALESCE(ar.present, false) as present
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id
            LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
            LEFT JOIN attendance_sessions ats ON ats.gathering_type_id = ? AND ats.session_date = ?
            LEFT JOIN attendance_records ar ON ar.session_id = ats.id AND ar.individual_id = i.id
            WHERE gl.gathering_type_id = ?
            AND (
              (f.family_type = 'regular' AND ${hasPeopleTypeAtTime 
                ? 'COALESCE(ar.people_type_at_time, i.people_type)' 
                : 'i.people_type'} = 'regular') OR 
              (f.family_type IS NULL AND ${hasPeopleTypeAtTime 
                ? 'COALESCE(ar.people_type_at_time, i.people_type)' 
                : 'i.people_type'} = 'regular')
            )
            AND (
              i.is_active = true OR 
              ar.present = 1 OR 
              ar.present = true OR
              -- Include archived people only if they have attendance records for past gatherings
              (i.is_active = false AND ar.present = 1)
            )
            ORDER BY f.family_name, i.first_name, i.last_name
          `;
          attendanceListParams = [gatheringId, date, gatheringId];
        }

        const attendanceList = await conn.query(attendanceListQuery, attendanceListParams);

        // Load visitors (same logic as REST API)
        // Use historical people_type if available
        const visitorPeopleTypeExpression = hasPeopleTypeAtTime
          ? `COALESCE(ar.people_type_at_time, i.people_type) as people_type`
          : `i.people_type`;
        
        let visitorsQuery;
        let visitorsParams;
        
        if (hasIndividualsChurchId) {
          visitorsQuery = `
            SELECT 
              i.id,
              i.first_name as firstName,
              i.last_name as lastName,
              i.last_attendance_date as lastAttendanceDate,
              ${visitorPeopleTypeExpression},
              f.family_name as familyName,
              f.id as familyId,
              f.family_type as familyType,
              f.family_notes as familyNotes,
              f.last_attended as familyLastAttended,
              COALESCE(ar.present, false) as present
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id AND f.church_id = ?
            LEFT JOIN attendance_sessions ats ON ats.gathering_type_id = ? AND ats.session_date = ? AND ats.church_id = ?
            LEFT JOIN attendance_records ar ON ar.session_id = ats.id AND ar.individual_id = i.id AND ar.church_id = ?
            WHERE i.church_id = ? AND ${hasPeopleTypeAtTime 
              ? `(COALESCE(ar.people_type_at_time, i.people_type) IN ('local_visitor', 'traveller_visitor') OR (ar.people_type_at_time IS NULL AND i.people_type IN ('local_visitor', 'traveller_visitor')))`
              : `i.people_type IN ('local_visitor', 'traveller_visitor')`}
            AND EXISTS (
              SELECT 1 FROM gathering_lists gl 
              WHERE gl.individual_id = i.id 
              AND gl.gathering_type_id = ? 
              AND gl.church_id = ?
            )
            ORDER BY f.family_name, i.first_name, i.last_name
          `;
          visitorsParams = [socket.churchId, gatheringId, date, socket.churchId, socket.churchId, socket.churchId, gatheringId, socket.churchId];
        } else {
          visitorsQuery = `
            SELECT 
              i.id,
              i.first_name as firstName,
              i.last_name as lastName,
              i.last_attendance_date as lastAttendanceDate,
              ${visitorPeopleTypeExpression},
              f.family_name as familyName,
              f.id as familyId,
              f.family_type as familyType,
              f.family_notes as familyNotes,
              f.last_attended as familyLastAttended,
              COALESCE(ar.present, false) as present
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id
            LEFT JOIN attendance_sessions ats ON ats.gathering_type_id = ? AND ats.session_date = ?
            LEFT JOIN attendance_records ar ON ar.session_id = ats.id AND ar.individual_id = i.id
            WHERE ${hasPeopleTypeAtTime 
              ? `(COALESCE(ar.people_type_at_time, i.people_type) IN ('local_visitor', 'traveller_visitor') OR (ar.people_type_at_time IS NULL AND i.people_type IN ('local_visitor', 'traveller_visitor')))`
              : `i.people_type IN ('local_visitor', 'traveller_visitor')`}
            AND EXISTS (
              SELECT 1 FROM gathering_lists gl 
              WHERE gl.individual_id = i.id 
              AND gl.gathering_type_id = ?
            )
            ORDER BY f.family_name, i.first_name, i.last_name
          `;
          visitorsParams = [gatheringId, date, gatheringId];
        }

        const rawVisitors = await conn.query(visitorsQuery, visitorsParams);

        // Get visitor config for service-date filtering
        let localVisitorServiceLimit = 6;
        let travellerVisitorServiceLimit = 2;
        try {
          const vcRows = await conn.query(
            'SELECT local_visitor_service_limit, traveller_visitor_service_limit FROM visitor_config WHERE church_id = ?',
            [socket.churchId]
          );
          if (vcRows.length > 0) {
            localVisitorServiceLimit = vcRows[0].local_visitor_service_limit;
            travellerVisitorServiceLimit = vcRows[0].traveller_visitor_service_limit;
          }
        } catch (e) { /* use defaults */ }

        // Get last N service dates for filtering
        const getServiceDates = async (limit) => {
          try {
            const rows = await conn.query(
              `SELECT DISTINCT session_date FROM attendance_sessions
               WHERE gathering_type_id = ? AND church_id = ? AND session_date <= ?
               ORDER BY session_date DESC LIMIT ?`,
              [gatheringId, socket.churchId, date, limit]
            );
            return rows.map(r => r.session_date);
          } catch (e) { return []; }
        };

        const localServiceDates = await getServiceDates(localVisitorServiceLimit);
        const travellerServiceDates = await getServiceDates(travellerVisitorServiceLimit);

        // Map WebSocket visitors to match REST API format
        // Note: Convert BigInt IDs to Numbers to match REST API format (processApiResponse)
        const allVisitors = (rawVisitors || []).map(v => {
          const isLocal = (v.familyType === 'local_visitor') || (v.people_type === 'local_visitor');
          const familyId = v.familyId ? Number(v.familyId) : null;
          return {
            id: Number(v.id),
            name: `${v.firstName || ''} ${v.lastName || ''}`.trim() || 'Unknown',
            firstName: v.firstName,
            lastName: v.lastName,
            present: v.present === 1 || v.present === true,
            lastAttendanceDate: v.lastAttendanceDate,
            peopleType: v.people_type,
            visitorType: isLocal ? 'potential_regular' : 'temporary_other',
            visitorFamilyGroup: familyId ? String(familyId) : null,
            familyId: familyId,
            familyName: v.familyName,
            lastAttended: v.familyLastAttended,
            notes: v.familyNotes || null
          };
        });

        // Apply service-limit filtering (match REST API behavior)
        const visitors = allVisitors.filter(v => {
          // Always show present visitors
          if (v.present) return true;
          // Show visitors with no attendance date (newly added)
          if (!v.lastAttendanceDate) return true;

          const relevantDates = v.peopleType === 'local_visitor' ? localServiceDates : travellerServiceDates;
          if (relevantDates.length === 0) return false;

          const lastDate = new Date(v.lastAttendanceDate);
          lastDate.setHours(0, 0, 0, 0);
          const lastDateStr = lastDate.toISOString().split('T')[0];

          const oldestDate = relevantDates[relevantDates.length - 1];
          if (!oldestDate) return false;
          const oldestDateStr = new Date(oldestDate).toISOString().split('T')[0];

          return lastDateStr >= oldestDateStr;
        });

        // Send successful response
        socket.emit('load_attendance_success', {
          attendanceList: attendanceList || [],
          visitors: visitors,
          gatheringId,
          date,
          timestamp: new Date().toISOString()
        });

        logger.info('WebSocket load attendance completed successfully', {
          userId: socket.userId,
          gatheringId,
          date,
          attendanceCount: attendanceList?.length || 0,
          visitorsCount: visitors?.length || 0
        });
      });

    } catch (error) {
      logger.error('Error processing WebSocket load attendance', {
        error: error.message,
        stack: error.stack,
        userId: socket.userId,
        churchId: socket.churchId,
        gatheringId,
        date,
        data
      });
      
      const errorMessage = process.env.NODE_ENV === 'development' 
        ? `Failed to load attendance data: ${error.message}`
        : 'Failed to load attendance data';
        
      socket.emit('load_attendance_error', { message: errorMessage });
    }
  }

  /**
   * Handle leaving an attendance room
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Room data {gatheringId, date}
   */
  handleLeaveAttendance(socket, data) {
    try {
      const { gatheringId, date } = data;
      const roomName = this.getAttendanceRoomName(gatheringId, date, socket.churchId);
      
      // Leave the room
      socket.leave(roomName);
      
      // Remove from room tracking
      if (this.attendanceRooms.has(roomName)) {
        this.attendanceRooms.get(roomName).delete(socket.id);
        if (this.attendanceRooms.get(roomName).size === 0) {
          this.attendanceRooms.delete(roomName);
        }
      }

      logger.info('User left attendance room', {
        userId: socket.userId,
        roomName,
        gatheringId,
        date
      });

      socket.emit('left_attendance', {
        roomName,
        gatheringId,
        date,
        message: 'Successfully left attendance room'
      });

      // Send updated user list to remaining users in the room
      const roomUsers = this.getRoomUsers(roomName);
      socket.to(roomName).emit('room_users_updated', {
        activeUsers: roomUsers,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Error leaving attendance room', {
        error: error.message,
        userId: socket.userId,
        data
      });
    }
  }

  /**
   * Handle client disconnection
   * @param {Socket} socket - Socket instance
   * @param {string} reason - Disconnection reason
   */
  handleDisconnection(socket, reason) {
    const userKey = `${socket.churchId}:${socket.userId}`;
    
    // Remove from user tracking
    if (this.connectedUsers.has(userKey)) {
      this.connectedUsers.get(userKey).delete(socket.id);
      if (this.connectedUsers.get(userKey).size === 0) {
        this.connectedUsers.delete(userKey);
      }
    }

    // Remove from church socket tracking
    if (this.churchSockets.has(socket.churchId)) {
      this.churchSockets.get(socket.churchId).delete(socket.id);
      if (this.churchSockets.get(socket.churchId).size === 0) {
        this.churchSockets.delete(socket.churchId);
      }
    }

    // Remove from all room tracking
    this.attendanceRooms.forEach((sockets, roomName) => {
      if (sockets.has(socket.id)) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          this.attendanceRooms.delete(roomName);
        }
      }
    });

    logger.info('WebSocket client disconnected', {
      socketId: socket.id,
      userId: socket.userId,
      churchId: socket.churchId,
      reason,
      totalConnections: this.io.engine.clientsCount,
      remainingUserConnections: this.connectedUsers.get(userKey)?.size || 0
    });
  }

  /**
   * Generate room name for attendance updates
   * @param {number} gatheringId - Gathering ID
   * @param {string} date - Date string (YYYY-MM-DD)
   * @param {number} churchId - Church ID for isolation
   * @returns {string} Room name
   */
  getAttendanceRoomName(gatheringId, date, churchId) {
    return `attendance:${churchId}:${gatheringId}:${date}`;
  }

  /**
   * Get list of users currently in a room
   * @param {string} roomName - Room name
   * @returns {Array} Array of user objects with id, email, firstName, lastName
   */
  getRoomUsers(roomName) {
    if (!this.io || !this.attendanceRooms.has(roomName)) {
      return [];
    }

    const socketIds = this.attendanceRooms.get(roomName);
    const users = [];
    const seenUsers = new Set(); // Prevent duplicate users with multiple connections

    socketIds.forEach(socketId => {
      const socket = this.io.sockets.sockets.get(socketId);
      if (socket && socket.userId && !seenUsers.has(socket.userId)) {
        seenUsers.add(socket.userId);
        
        // Parse name from email or use fallback
        const email = socket.userEmail || '';
        const emailName = email.split('@')[0] || '';
        const nameParts = emailName.split(/[._-]/);
        
        const firstName = nameParts[0] ? nameParts[0].charAt(0).toUpperCase() + nameParts[0].slice(1) : 'U';
        const lastName = nameParts[1] ? nameParts[1].charAt(0).toUpperCase() + nameParts[1].slice(1) : '';

        users.push({
          id: socket.userId,
          email: socket.userEmail,
          firstName,
          lastName,
          role: socket.userRole
        });
      }
    });

    return users;
  }

  /**
   * Broadcast attendance update to church (updated to use church-based broadcasting)
   * @param {number} gatheringId - Gathering ID
   * @param {string} date - Date string
   * @param {number} churchId - Church ID
   * @param {Object} updateData - Update data to broadcast
   */
  broadcastAttendanceUpdate(gatheringId, date, churchId, updateData) {
    try {
      if (!this.io) {
        logger.warn('WebSocket not initialized, skipping broadcast');
        return;
      }

      logger.info('Broadcasting attendance update to church', {
        gatheringId,
        date,
        churchId,
        updateType: updateData.type,
        churchSocketCount: this.churchSockets.get(churchId)?.size || 0
      });

      // Use church-based broadcasting instead of room-based
      const broadcastData = {
        gatheringId,
        date,
        timestamp: new Date().toISOString(),
        ...updateData
      };
      
      // Get sockets for this church only (optimized church-based broadcasting)
      const churchSocketIds = this.churchSockets.get(churchId);
      let broadcastCount = 0;
      
      if (churchSocketIds) {
        churchSocketIds.forEach((socketId) => {
          const clientSocket = this.io.sockets.sockets.get(socketId);
          if (clientSocket) {
            logger.debugLog(`Sending attendance update to socket ${socketId} (user ${clientSocket.userId})`);
            clientSocket.emit('attendance_update', broadcastData);
            broadcastCount++;
          }
        });
      }
      
      logger.debugLog(`Attendance update broadcasted to ${broadcastCount} clients in church ${churchId}`);

    } catch (error) {
      logger.error('Error broadcasting attendance update', {
        error: error.message,
        gatheringId,
        date,
        churchId,
        updateData
      });
    }
  }

  /**
   * Broadcast visitor update to church (updated to use church-based broadcasting)
   * @param {number} gatheringId - Gathering ID
   * @param {string} date - Date string
   * @param {number} churchId - Church ID
   * @param {Object} updateData - Update data to broadcast
   */
  broadcastVisitorUpdate(gatheringId, date, churchId, updateData) {
    try {
      if (!this.io) {
        logger.warn('WebSocket not initialized, skipping visitor broadcast');
        return;
      }

      logger.info('Broadcasting visitor update to church', {
        gatheringId,
        date,
        churchId,
        updateType: updateData.type,
        churchSocketCount: this.churchSockets.get(churchId)?.size || 0
      });

      // Use church-based broadcasting instead of room-based
      const broadcastData = {
        gatheringId,
        date,
        timestamp: new Date().toISOString(),
        ...updateData
      };
      
      // Get sockets for this church only (optimized church-based broadcasting)
      const churchSocketIds = this.churchSockets.get(churchId);
      let broadcastCount = 0;
      
      if (churchSocketIds) {
        churchSocketIds.forEach((socketId) => {
          const clientSocket = this.io.sockets.sockets.get(socketId);
          if (clientSocket) {
            logger.debugLog(`Sending visitor update to socket ${socketId} (user ${clientSocket.userId})`);
            clientSocket.emit('visitor_update', broadcastData);
            broadcastCount++;
          }
        });
      }
      
      logger.debugLog(`Visitor update broadcasted to ${broadcastCount} clients in church ${churchId}`);

    } catch (error) {
      logger.error('Error broadcasting visitor update', {
        error: error.message,
        gatheringId,
        date,
        churchId,
        updateData
      });
    }
  }

  /**
   * Get connection statistics
   * @returns {Object} Connection stats
   */
  getStats() {
    return {
      totalConnections: this.io ? this.io.engine.clientsCount : 0,
      connectedUsers: this.connectedUsers.size,
      activeRooms: this.attendanceRooms.size,
      roomDetails: Array.from(this.attendanceRooms.entries()).map(([room, sockets]) => ({
        room,
        connections: sockets.size
      }))
    };
  }

  /**
   * Clean up old deduplication entries to prevent memory leaks
   */
  cleanupRecentUpdates() {
    const now = Date.now();
    const cutoff = now - 10000; // Remove entries older than 10 seconds
    
    for (const [key, timestamp] of this.recentUpdates.entries()) {
      if (timestamp < cutoff) {
        this.recentUpdates.delete(key);
      }
    }
    
    if (this.recentUpdates.size > 1000) {
      // Emergency cleanup if map gets too large
      logger.warn('Recent updates map getting large, clearing all entries', {
        size: this.recentUpdates.size
      });
      this.recentUpdates.clear();
    }
  }

  /**
   * Clean up stale connections to prevent memory leaks
   */
  cleanupStaleConnections() {
    if (!this.io) return;
    
    // Clean up disconnected sockets from tracking maps
    for (const [userKey, socketIds] of this.connectedUsers.entries()) {
      const activeSocketIds = new Set();
      
      for (const socketId of socketIds) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket && socket.connected) {
          activeSocketIds.add(socketId);
        }
      }
      
      if (activeSocketIds.size === 0) {
        this.connectedUsers.delete(userKey);
      } else {
        this.connectedUsers.set(userKey, activeSocketIds);
      }
    }
    
    // Clean up church socket tracking
    for (const [churchId, socketIds] of this.churchSockets.entries()) {
      const activeSocketIds = new Set();
      
      for (const socketId of socketIds) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket && socket.connected) {
          activeSocketIds.add(socketId);
        }
      }
      
      if (activeSocketIds.size === 0) {
        this.churchSockets.delete(churchId);
      } else {
        this.churchSockets.set(churchId, activeSocketIds);
      }
    }
    
    logger.debugLog('WebSocket connection cleanup completed', {
      connectedUsers: this.connectedUsers.size,
      churchSockets: this.churchSockets.size,
      totalConnections: this.io.engine.clientsCount
    });
  }

  /**
   * Gracefully shutdown WebSocket service
   */
  /**
   * Generate attendance room name
   * @param {number} gatheringId - Gathering ID
   * @param {string} date - Date string
   * @param {string} churchId - Church ID
   * @returns {string} Room name
   */
  getAttendanceRoomName(gatheringId, date, churchId) {
    return `attendance:${churchId}:${gatheringId}:${date}`;
  }

  /**
   * Handle joining test room
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Room data {roomName}
   */
  async handleJoinTestRoom(socket, data) {
    try {
      const { roomName } = data;
      
      if (!roomName) {
        socket.emit('error', { message: 'Missing room name' });
        return;
      }

      logger.debugLog(`User ${socket.userId} joining test room: ${roomName}`);
      
      // Join the Socket.IO room
      socket.join(roomName);
      
      // Track room membership for our own tracking
      if (!this.attendanceRooms.has(roomName)) {
        this.attendanceRooms.set(roomName, new Set());
      }
      this.attendanceRooms.get(roomName).add(socket.id);

      const roomSize = this.attendanceRooms.get(roomName).size;

      logger.debugLog(`User ${socket.userId} joined test room ${roomName} (${roomSize} members)`);

      // Emit confirmation to the user who joined
      socket.emit('joined_test_room', {
        roomName,
        roomSize,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error joining test room:', error);
      socket.emit('error', { message: 'Failed to join test room' });
    }
  }

  /**
   * Handle leaving test room
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Room data {roomName}
   */
  async handleLeaveTestRoom(socket, data) {
    try {
      const { roomName } = data;
      
      if (!roomName) {
        socket.emit('error', { message: 'Missing room name' });
        return;
      }

      logger.debugLog(`User ${socket.userId} leaving test room: ${roomName}`);
      
      // Leave the Socket.IO room
      socket.leave(roomName);
      
      // Remove from our tracking
      if (this.attendanceRooms.has(roomName)) {
        this.attendanceRooms.get(roomName).delete(socket.id);
        
        // Clean up empty rooms
        if (this.attendanceRooms.get(roomName).size === 0) {
          this.attendanceRooms.delete(roomName);
        }
      }

      logger.debugLog(`User ${socket.userId} left test room ${roomName}`);

      // Emit confirmation
      socket.emit('left_test_room', {
        roomName,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error leaving test room:', error);
      socket.emit('error', { message: 'Failed to leave test room' });
    }
  }

  /**
   * Handle test room messages
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Message data
   */
  async handleTestRoomMessage(socket, data) {
    try {
      const { roomName, message } = data;
      
      if (!roomName || !message) {
        socket.emit('error', { message: 'Missing room name or message' });
        return;
      }

      logger.debugLog(`Room message from user ${socket.userId} to room ${roomName}: ${message}`);
      
      // Broadcast to all clients in the room using Socket.IO rooms
      socket.to(roomName).emit('test_room_message', {
        ...data,
        fromSocketId: socket.id,
        serverTimestamp: new Date().toISOString()
      });

      logger.debugLog(`Broadcasted room message to room ${roomName}`);

    } catch (error) {
      console.error('Error handling test room message:', error);
      socket.emit('error', { message: 'Failed to send room message' });
    }
  }

  /**
   * Handle joining attendance room
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Room data {gatheringId, date}
   */
  async handleJoinAttendance(socket, data) {
    try {
      const { gatheringId, date } = data;
      
      if (!gatheringId || !date) {
        socket.emit('error', { message: 'Missing gatheringId or date' });
        return;
      }

      const roomName = this.getAttendanceRoomName(gatheringId, date, socket.churchId);
      
      // Join the Socket.IO room
      socket.join(roomName);
      
      // Track room membership
      if (!this.attendanceRooms.has(roomName)) {
        this.attendanceRooms.set(roomName, new Set());
      }
      this.attendanceRooms.get(roomName).add(socket.id);

      // Get all sockets in the room for debugging
      const roomSockets = this.attendanceRooms.get(roomName);
      const allSocketsInRoom = Array.from(roomSockets);

      logger.info('User joined attendance room', {
        userId: socket.userId,
        userEmail: socket.userEmail,
        churchId: socket.churchId,
        roomName,
        gatheringId,
        date,
        roomSize: roomSockets.size,
        allSocketsInRoom
      });

      // Emit confirmation
      socket.emit('joined_attendance', {
        roomName,
        gatheringId,
        date,
        roomSize: roomSockets.size,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Error joining attendance room', {
        error: error.message,
        stack: error.stack,
        userId: socket.userId,
        churchId: socket.churchId,
        data
      });
      socket.emit('error', { message: 'Failed to join attendance room' });
    }
  }

  /**
   * Handle leaving attendance room
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Room data {gatheringId, date}
   */
  async handleLeaveAttendance(socket, data) {
    try {
      const { gatheringId, date } = data;
      
      if (!gatheringId || !date) {
        socket.emit('error', { message: 'Missing gatheringId or date' });
        return;
      }

      const roomName = this.getAttendanceRoomName(gatheringId, date, socket.churchId);
      
      // Leave the Socket.IO room
      socket.leave(roomName);
      
      // Remove from room tracking
      if (this.attendanceRooms.has(roomName)) {
        this.attendanceRooms.get(roomName).delete(socket.id);
        
        // Clean up empty rooms
        if (this.attendanceRooms.get(roomName).size === 0) {
          this.attendanceRooms.delete(roomName);
        }
      }

      logger.info('User left attendance room', {
        userId: socket.userId,
        roomName,
        gatheringId,
        date
      });

      // Emit confirmation
      socket.emit('left_attendance', {
        roomName,
        gatheringId,
        date,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Error leaving attendance room', {
        error: error.message,
        stack: error.stack,
        userId: socket.userId,
        churchId: socket.churchId,
        data
      });
      socket.emit('error', { message: 'Failed to leave attendance room' });
    }
  }

  /**
   * Handle headcount updates via WebSocket
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Headcount data {gatheringId, date, headcount}
   */
  async handleUpdateHeadcount(socket, data) {
    let gatheringId, date, headcount, mode;
    
    try {
      ({ gatheringId, date, headcount, mode = 'separate' } = data);
      
      if (!gatheringId || !date || typeof headcount !== 'number') {
        socket.emit('headcount_update_error', { message: 'Invalid headcount data' });
        return;
      }

      // Create deduplication key
      const dedupeKey = `${socket.userId}:${gatheringId}:${date}:${headcount}`;
      const now = Date.now();
      
      // Smart deduplication: only block very rapid duplicates (within 500ms)
      if (this.recentUpdates.has(dedupeKey)) {
        const lastUpdate = this.recentUpdates.get(dedupeKey);
        const timeSinceLastUpdate = now - lastUpdate;
        
        if (timeSinceLastUpdate < 500) {
          logger.info('Rapid duplicate WebSocket headcount update blocked', {
            userId: socket.userId,
            churchId: socket.churchId,
            gatheringId,
            date,
            headcount,
            timeSinceLastUpdate
          });
          socket.emit('headcount_update_success');
          return;
        }
      }
      
      // Track this update
      this.recentUpdates.set(dedupeKey, now);

      logger.info('WebSocket headcount update received', {
        userId: socket.userId,
        churchId: socket.churchId,
        gatheringId,
        date,
        headcount
      });

      // Save the headcount to database first, then calculate combined total
      let displayHeadcount = headcount;
      let otherUsers = [];
      let sessionId;
      
      try {
        // Get or create attendance session (same logic as API)
        let sessionResult = await Database.query(`
          SELECT id, headcount_mode FROM attendance_sessions 
          WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?
        `, [gatheringId, date, socket.churchId]);

        if (sessionResult.length === 0) {
          // Create new session with the specified mode
          const newSession = await Database.query(`
            INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id, headcount_mode)
            VALUES (?, ?, ?, ?, ?)
          `, [gatheringId, date, socket.userId, socket.churchId, mode]);
          sessionId = newSession.insertId;
        } else {
          sessionId = sessionResult[0].id;
          const sessionMode = sessionResult[0].headcount_mode || 'separate';
          
          // Update session mode if it's different
          if (sessionMode !== mode) {
            await Database.query(`
              UPDATE attendance_sessions 
              SET headcount_mode = ? 
              WHERE id = ?
            `, [mode, sessionId]);
          }
        }

        // Insert or update headcount record (same logic as API)
        await Database.query(`
          INSERT INTO headcount_records (session_id, headcount, updated_by, church_id)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE 
          headcount = VALUES(headcount),
          updated_by = VALUES(updated_by),
          updated_at = CURRENT_TIMESTAMP
        `, [sessionId, headcount, socket.userId, socket.churchId]);

        // Now calculate the display value based on mode (same logic as API)
        if (mode === 'combined') {
          const combinedResult = await Database.query(`
            SELECT COALESCE(SUM(headcount), 0) as total_headcount
            FROM headcount_records 
            WHERE session_id = ?
          `, [sessionId]);
          displayHeadcount = combinedResult[0].total_headcount;
          
          logger.debugLog('WebSocket combined calculation', {
            userHeadcount: headcount,
            displayHeadcount: displayHeadcount,
            sessionId: sessionId
          });
        } else if (mode === 'averaged') {
          const averagedResult = await Database.query(`
            SELECT COALESCE(ROUND(AVG(headcount)), 0) as avg_headcount
            FROM headcount_records 
            WHERE session_id = ?
          `, [sessionId]);
          displayHeadcount = averagedResult[0].avg_headcount;
        }

        // Get other users data
        const otherUsersResult = await Database.query(`
          SELECT h.headcount, h.updated_at, u.first_name, u.last_name, u.id
          FROM headcount_records h
          LEFT JOIN users u ON h.updated_by = u.id
          WHERE h.session_id = ?
          ORDER BY h.updated_at DESC
        `, [sessionId]);
        
        // Map users with raw data (no personalization yet)
        otherUsers = otherUsersResult
          .map(user => ({
            userId: user.id,
            name: `${user.first_name} ${user.last_name}`, // Always use real name, no "You" yet
            headcount: user.headcount,
            lastUpdated: user.updated_at
          }));
        
      } catch (dbError) {
        logger.error('Database error in WebSocket headcount update:', dbError);
        // Fall back to original headcount if database query fails
      }

      logger.debugLog('Broadcasting headcount update via websocketBroadcast', {
        churchId: socket.churchId,
        headcount: displayHeadcount,
        userHeadcount: headcount,
        churchSocketsSize: this.churchSockets.size,
        churchSocketIds: this.churchSockets.get(socket.churchId)?.size || 0
      });
      
      // Use the same broadcasting method as the API
      const broadcastData = {
        gatheringId: parseInt(gatheringId),
        date,
        headcount: displayHeadcount,
        userHeadcount: headcount, // The user's individual headcount
        mode,
        updatedBy: socket.userId,
        updatedByName: socket.userName,
        timestamp: new Date().toISOString(),
        churchId: socket.churchId,
        otherUsers
      };
      
      // Use the same broadcast method as the API
      this.broadcastToChurch(socket.churchId, 'headcount_updated', broadcastData);

      // Send success response to sender
      socket.emit('headcount_update_success');

      logger.info('Headcount update broadcasted via WebSocket', {
        gatheringId,
        date,
        headcount: displayHeadcount,
        userHeadcount: headcount,
        updatedBy: socket.userId
      });

    } catch (error) {
      logger.error('WebSocket headcount update error:', {
        error: error.message,
        userId: socket.userId,
        churchId: socket.churchId,
        data
      });
      socket.emit('headcount_update_error', { message: 'Failed to update headcount' });
    }
  }

  /**
   * Handle loading headcount data via WebSocket
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Request data {gatheringId, date}
   */
  async handleLoadHeadcount(socket, data) {
    try {
      const { gatheringId, date } = data;
      
      if (!gatheringId || !date) {
        socket.emit('headcount_load_error', { message: 'Invalid request data' });
        return;
      }

      logger.info('WebSocket headcount load request', {
        userId: socket.userId,
        churchId: socket.churchId,
        gatheringId,
        date
      });

      // Acknowledge the headcount load request (no room joining needed with church-based broadcasting)
      socket.emit('headcount_loaded', {
        gatheringId: parseInt(gatheringId),
        date,
        message: 'Headcount load request acknowledged'
      });

      logger.info('WebSocket headcount load request acknowledged', {
        socketId: socket.id,
        userId: socket.userId,
        gatheringId,
        date
      });

    } catch (error) {
      logger.error('WebSocket headcount load error:', {
        error: error.message,
        userId: socket.userId,
        churchId: socket.churchId,
        data
      });
      socket.emit('headcount_load_error', { message: 'Failed to load headcount data' });
    }
  }

  /**
   * Handle headcount mode updates via WebSocket
   * @param {Socket} socket - Socket instance
   * @param {Object} data - Mode data {gatheringId, date, mode}
   */
  async handleUpdateHeadcountMode(socket, data) {
    try {
      const { gatheringId, date, mode } = data;
      
      if (!gatheringId || !date || !['separate', 'combined', 'averaged'].includes(mode)) {
        socket.emit('headcount_mode_update_error', { message: 'Invalid mode data' });
        return;
      }

      logger.info('WebSocket headcount mode update received', {
        userId: socket.userId,
        churchId: socket.churchId,
        gatheringId,
        date,
        mode
      });

      // Broadcast mode change to all clients in the same church
      const broadcastData = {
        gatheringId: parseInt(gatheringId),
        date,
        mode,
        updatedBy: socket.userId,
        updatedByName: socket.userName,
        timestamp: new Date().toISOString()
      };
      
      logger.debugLog('Broadcasting headcount mode update to church', socket.churchId);
      
      // Get sockets for this church only
      const churchSocketIds = this.churchSockets.get(socket.churchId);
      let broadcastCount = 0;
      
      if (churchSocketIds) {
        churchSocketIds.forEach((socketId) => {
          const clientSocket = this.io.sockets.sockets.get(socketId);
          if (clientSocket) {
            logger.debugLog(`Sending headcount mode update to socket ${socketId} (user ${clientSocket.userId})`);
            clientSocket.emit('headcount_mode_updated', broadcastData);
            broadcastCount++;
          }
        });
      }
      
      logger.debugLog(`Headcount mode update broadcasted to ${broadcastCount} clients in church ${socket.churchId}`);

      // Send success response to sender
      socket.emit('headcount_mode_update_success');

      logger.info('Headcount mode update broadcasted via WebSocket', {
        gatheringId,
        date,
        mode,
        updatedBy: socket.userId,
        broadcastCount
      });

    } catch (error) {
      logger.error('WebSocket headcount mode update error:', {
        error: error.message,
        userId: socket.userId,
        churchId: socket.churchId,
        data
      });
      socket.emit('headcount_mode_update_error', { message: 'Failed to update headcount mode' });
    }
  }

  shutdown() {
    if (this.io) {
      logger.info('Shutting down WebSocket service');
      this.io.close();
      this.connectedUsers.clear();
      this.attendanceRooms.clear();
      this.recentUpdates.clear();
      this.churchSockets.clear();
    }
    
    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Broadcast to all clients in a church
   * @param {string} churchId - Church ID
   * @param {string} event - Event name
   * @param {Object} data - Data to broadcast
   */
  broadcastToChurch(churchId, event, data) {
    try {
      if (!this.io) {
        logger.warn('WebSocket not initialized, skipping broadcast');
        return;
      }

      // Get all sockets for this church
      const churchSocketIds = this.churchSockets.get(churchId);
      let broadcastCount = 0;
      
      logger.debugLog(`Broadcasting ${event} to church ${churchId}`, {
        churchSocketIdsSize: churchSocketIds?.size || 0,
        totalChurches: this.churchSockets.size,
        churchIds: Array.from(this.churchSockets.keys())
      });
      
      if (churchSocketIds) {
        churchSocketIds.forEach((socketId) => {
          const clientSocket = this.io.sockets.sockets.get(socketId);
          if (clientSocket) {
            logger.debugLog(`Broadcasting ${event} to socket ${socketId} (user ${clientSocket.userId})`);
            logger.debugLog(`Data being sent`, {
              headcount: data.headcount,
              userHeadcount: data.userHeadcount,
              mode: data.mode
            });
            clientSocket.emit(event, data);
            broadcastCount++;
          } else {
            logger.debugLog(`Socket ${socketId} not found in io.sockets.sockets`);
          }
        });
      } else {
        logger.debugLog(`No sockets found for church ${churchId}`);
      }
      
      logger.debugLog(`${event} broadcasted to ${broadcastCount} clients in church ${churchId}`);
      
      logger.info(`Broadcasted ${event} to church`, {
        churchId,
        event,
        broadcastCount,
        data
      });

    } catch (error) {
      logger.error(`Error broadcasting ${event} to church`, {
        error: error.message,
        churchId,
        event,
        data
      });
    }
  }

}

// Create singleton instance
const webSocketService = new WebSocketService();

module.exports = webSocketService;
