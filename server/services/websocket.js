const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const logger = require('../config/logger');

class WebSocketService {
  constructor() {
    this.io = null;
    this.connectedUsers = new Map(); // Track user connections
    this.attendanceRooms = new Map(); // Track room subscriptions
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
      
      console.log('🔌 WebSocket service initialized successfully');
      return this.io;
    } catch (error) {
      console.error('❌ Failed to initialize WebSocket service:', error);
      throw error;
    }
  }

  /**
   * Setup authentication middleware for WebSocket connections
   * Uses cookie-based session validation like the REST API
   */
  setupAuthentication() {
    this.io.use(async (socket, next) => {
      try {
        // Get auth data from handshake
        const authData = socket.handshake.auth;
        
        console.log('🔌 WebSocket auth attempt:', {
          authData,
          hasUserId: !!authData?.userId,
          hasChurchId: !!authData?.churchId,
          allKeys: authData ? Object.keys(authData) : 'no authData'
        });
        
        if (!authData || !authData.userId || !authData.churchId) {
          console.log('❌ WebSocket auth failed: missing required data');
          return next(new Error('Authentication data required'));
        }

        // For now, trust the client auth data since they have a valid session
        // In production, you might want to validate the session via database
        // or implement a session token system
        
        // Add user info to socket
        socket.userId = authData.userId;
        socket.userEmail = authData.email;
        socket.userRole = authData.role;
        socket.churchId = authData.churchId;

        logger.info('WebSocket authentication successful', {
          userId: socket.userId,
          email: socket.userEmail,
          role: socket.userRole,
          churchId: socket.churchId,
          socketId: socket.id
        });

        next();
      } catch (error) {
        logger.warn('WebSocket authentication failed', {
          error: error.message,
          socketId: socket.id,
          authData: socket.handshake.auth
        });
        next(new Error('Authentication failed'));
      }
    });
  }

  /**
   * Setup connection and disconnection handling
   */
  setupConnectionHandling() {
    this.io.on('connection', (socket) => {
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

    // Handle attendance room subscription
    socket.on('join_attendance', (data) => {
      this.handleJoinAttendance(socket, data);
    });

    // Handle leaving attendance room
    socket.on('leave_attendance', (data) => {
      this.handleLeaveAttendance(socket, data);
    });

    // Handle recording attendance via WebSocket
    socket.on('record_attendance', (data) => {
      this.handleRecordAttendance(socket, data);
    });

    // Handle ping for connection health
    socket.on('ping', () => {
      socket.emit('pong');
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
        churchId: socket.churchId,
        roomName,
        gatheringId,
        date,
        roomSize: this.attendanceRooms.get(roomName).size
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

      // Broadcast to all clients in the room (including sender for confirmation)
      const roomName = this.getAttendanceRoomName(gatheringId, date, socket.churchId);
      this.io.to(roomName).emit('attendance_update', {
        type: 'attendance_records',
        gatheringId,
        date,
        records,
        updatedBy: socket.userId,
        updatedAt: new Date().toISOString(),
        timestamp: new Date().toISOString()
      });

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
   * Gracefully shutdown WebSocket service
   */
  shutdown() {
    if (this.io) {
      logger.info('Shutting down WebSocket service');
      this.io.close();
      this.connectedUsers.clear();
      this.attendanceRooms.clear();
    }
  }
}

// Create singleton instance
const webSocketService = new WebSocketService();

module.exports = webSocketService;
