const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

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
        // Connection settings
        pingTimeout: 60000,
        pingInterval: 25000,
        transports: ['websocket', 'polling']
      });

      this.setupAuthentication();
      this.setupConnectionHandling();
      
      // Set up periodic cleanup of deduplication entries
      this.cleanupInterval = setInterval(() => {
        this.cleanupRecentUpdates();
      }, 30000); // Clean up every 30 seconds
      
      console.log('🔌 WebSocket service initialized successfully');
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
        
        console.log('🔌 WebSocket auth attempt:', {
          hasToken: !!token,
          hasAuthData: !!authData,
          authDataKeys: authData ? Object.keys(authData) : 'none',
          cookieHeader: cookieHeader ? 'present' : 'missing'
        });
        
        if (!token) {
          console.log('❌ WebSocket auth failed: no token found', {
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
          console.log('❌ WebSocket auth failed: user not found or inactive', {
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
            console.log('❌ WebSocket auth failed: user ID mismatch', {
              socketId: socket.id,
              tokenUserId: decoded.userId,
              authDataUserId: authData.userId
            });
            return next(new Error('Authentication data mismatch'));
          }
          
          if (authData.churchId && authData.churchId !== churchId) {
            console.log('❌ WebSocket auth failed: church ID mismatch', {
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
      console.log('🔌 New connection attempt:', {
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

    console.log('🔌 WebSocket client connected:', {
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

    // Handle ping for connection health
    socket.on('ping', () => {
      socket.emit('pong');
    });

    // Handle test messages for debugging
    socket.on('test_message', (data) => {
      console.log('📨 WebSocket Test - Message received:', {
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
      
      console.log('📤 Broadcasting test message to church', socket.churchId);
      
      // Get sockets for this church only (optimized broadcasting)
      const churchSocketIds = this.churchSockets.get(socket.churchId);
      let broadcastCount = 0;
      
      if (churchSocketIds) {
        churchSocketIds.forEach((socketId) => {
          // Don't send to self, only to other clients in same church
          if (socketId !== socket.id) {
            const clientSocket = this.io.sockets.sockets.get(socketId);
            if (clientSocket) {
              console.log(`📡 Sending to socket ${socketId} (user ${clientSocket.userId})`);
              clientSocket.emit('test_message', broadcastData);
              broadcastCount++;
            }
          }
        });
      }
      
      console.log(`📡 Broadcasted to ${broadcastCount} other clients in church ${socket.churchId}`);
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
      
      console.log('📤 Broadcasting attendance update to church', socket.churchId);
      
      // Get sockets for this church only (O(church_sockets) instead of O(all_sockets))
      const churchSocketIds = this.churchSockets.get(socket.churchId);
      let broadcastCount = 0;
      
      if (churchSocketIds) {
        churchSocketIds.forEach((socketId) => {
          const clientSocket = this.io.sockets.sockets.get(socketId);
          if (clientSocket) {
            console.log(`📡 Sending attendance update to socket ${socketId} (user ${clientSocket.userId})`);
            clientSocket.emit('attendance_update', broadcastData);
            broadcastCount++;
          }
        });
      }
      
      console.log(`📡 Attendance update broadcasted to ${broadcastCount} clients in church ${socket.churchId}`);

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
              i.people_type,
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
              f.family_type = 'regular' OR 
              (f.family_type IS NULL AND i.people_type = 'regular')
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
              i.people_type,
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
              f.family_type = 'regular' OR 
              (f.family_type IS NULL AND i.people_type = 'regular')
            )
            ORDER BY f.family_name, i.first_name, i.last_name
          `;
          attendanceListParams = [gatheringId, date, gatheringId];
        }

        const attendanceList = await conn.query(attendanceListQuery, attendanceListParams);

        // Load visitors (same logic as REST API)
        let visitorsQuery;
        let visitorsParams;
        
        if (hasIndividualsChurchId) {
          visitorsQuery = `
            SELECT 
              i.id,
              i.first_name as firstName,
              i.last_name as lastName,
              i.last_attendance_date as lastAttendanceDate,
              i.people_type,
              f.family_name as familyName,
              f.id as familyId,
              COALESCE(ar.present, false) as present
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id AND f.church_id = ?
            LEFT JOIN attendance_sessions ats ON ats.gathering_type_id = ? AND ats.session_date = ? AND ats.church_id = ?
            LEFT JOIN attendance_records ar ON ar.session_id = ats.id AND ar.individual_id = i.id AND ar.church_id = ?
            WHERE i.church_id = ? AND i.people_type IN ('local_visitor', 'traveller_visitor')
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
              i.people_type,
              f.family_name as familyName,
              f.id as familyId,
              COALESCE(ar.present, false) as present
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id
            LEFT JOIN attendance_sessions ats ON ats.gathering_type_id = ? AND ats.session_date = ?
            LEFT JOIN attendance_records ar ON ar.session_id = ats.id AND ar.individual_id = i.id
            WHERE i.people_type IN ('local_visitor', 'traveller_visitor')
            AND EXISTS (
              SELECT 1 FROM gathering_lists gl 
              WHERE gl.individual_id = i.id 
              AND gl.gathering_type_id = ?
            )
            ORDER BY f.family_name, i.first_name, i.last_name
          `;
          visitorsParams = [gatheringId, date, gatheringId];
        }

        const visitors = await conn.query(visitorsQuery, visitorsParams);

        // Send successful response
        socket.emit('load_attendance_success', {
          attendanceList: attendanceList || [],
          visitors: visitors || [],
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

    console.log('🔌 WebSocket client disconnected:', {
      socketId: socket.id,
      userId: socket.userId,
      churchId: socket.churchId,
      reason,
      totalConnections: this.io.engine.clientsCount,
      remainingUserConnections: this.connectedUsers.get(userKey)?.size || 0,
      remainingUserKeys: Array.from(this.connectedUsers.keys())
    });

    logger.info('WebSocket client disconnected', {
      socketId: socket.id,
      userId: socket.userId,
      churchId: socket.churchId,
      reason,
      totalConnections: this.io.engine.clientsCount
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
   * Broadcast attendance update to room
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

      const roomName = this.getAttendanceRoomName(gatheringId, date, churchId);
      
      logger.info('Broadcasting attendance update', {
        roomName,
        gatheringId,
        date,
        churchId,
        updateType: updateData.type,
        roomSize: this.attendanceRooms.get(roomName)?.size || 0
      });

      this.io.to(roomName).emit('attendance_update', {
        gatheringId,
        date,
        timestamp: new Date().toISOString(),
        ...updateData
      });

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
   * Broadcast visitor update to room
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

      const roomName = this.getAttendanceRoomName(gatheringId, date, churchId);
      
      logger.info('Broadcasting visitor update', {
        roomName,
        gatheringId,
        date,
        churchId,
        updateType: updateData.type
      });

      this.io.to(roomName).emit('visitor_update', {
        gatheringId,
        date,
        timestamp: new Date().toISOString(),
        ...updateData
      });

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

      console.log(`🧪 User ${socket.userId} joining test room: ${roomName}`);
      
      // Join the Socket.IO room
      socket.join(roomName);
      
      // Track room membership for our own tracking
      if (!this.attendanceRooms.has(roomName)) {
        this.attendanceRooms.set(roomName, new Set());
      }
      this.attendanceRooms.get(roomName).add(socket.id);

      const roomSize = this.attendanceRooms.get(roomName).size;

      console.log(`🧪 User ${socket.userId} joined test room ${roomName} (${roomSize} members)`);

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

      console.log(`🧪 User ${socket.userId} leaving test room: ${roomName}`);
      
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

      console.log(`🧪 User ${socket.userId} left test room ${roomName}`);

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

      console.log(`🧪 Room message from user ${socket.userId} to room ${roomName}: ${message}`);
      
      // Broadcast to all clients in the room using Socket.IO rooms
      socket.to(roomName).emit('test_room_message', {
        ...data,
        fromSocketId: socket.id,
        serverTimestamp: new Date().toISOString()
      });

      console.log(`🧪 Broadcasted room message to room ${roomName}`);

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
}

// Create singleton instance
const webSocketService = new WebSocketService();

module.exports = webSocketService;
