/**
 * Simple WebSocket test client to verify the server implementation
 * Run this with: node test-websocket.js
 * Make sure the server is running first
 */

const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');

// Test configuration
const SERVER_URL = 'http://localhost:3001';
const JWT_SECRET = process.env.JWT_SECRET || 'default_jwt_secret_change_in_production';

// Mock user data for testing (matching the new auth format)
const testAuthData = {
  userId: 1,
  email: 'test@example.com',
  role: 'admin',
  churchId: 1
};

console.log('🧪 WebSocket Test Client Starting...');
console.log(`📡 Connecting to: ${SERVER_URL}`);
console.log(`👤 Test user: ${testAuthData.email} (Church ID: ${testAuthData.churchId})`);

// Create WebSocket connection
const socket = io(SERVER_URL, {
  auth: testAuthData,
  transports: ['websocket', 'polling']
});

// Connection event handlers
socket.on('connect', () => {
  console.log('✅ Connected to WebSocket server');
  console.log(`🔗 Socket ID: ${socket.id}`);
  
  // Test joining an attendance room
  console.log('\n📋 Testing attendance room join...');
  socket.emit('join_attendance', {
    gatheringId: 1,
    date: '2025-01-21'
  });
});

socket.on('connected', (data) => {
  console.log('📨 Received welcome message:', data);
});

socket.on('joined_attendance', (data) => {
  console.log('✅ Successfully joined attendance room:', data);
  
  // Test leaving the room after 2 seconds
  setTimeout(() => {
    console.log('\n🚪 Testing attendance room leave...');
    socket.emit('leave_attendance', {
      gatheringId: 1,
      date: '2025-01-21'
    });
  }, 2000);
});

socket.on('left_attendance', (data) => {
  console.log('✅ Successfully left attendance room:', data);
  
  // Close connection after testing
  setTimeout(() => {
    console.log('\n🏁 Test completed, closing connection...');
    socket.close();
  }, 1000);
});

socket.on('attendance_update', (data) => {
  console.log('📊 Received attendance update:', data);
});

socket.on('visitor_update', (data) => {
  console.log('👥 Received visitor update:', data);
});

socket.on('user_joined', (data) => {
  console.log('👋 User joined room:', data);
});

socket.on('error', (error) => {
  console.error('❌ WebSocket error:', error);
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection error:', error.message);
  process.exit(1);
});

socket.on('disconnect', (reason) => {
  console.log('📴 Disconnected:', reason);
  process.exit(0);
});

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down test client...');
  socket.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down test client...');
  socket.close();
  process.exit(0);
});
