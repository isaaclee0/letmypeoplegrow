#!/usr/bin/env node

/**
 * Quick test script to verify WebSocket attendance updates work properly
 * Run this from the project root to test the WebSocket fix
 */

const io = require('socket.io-client');

// Configuration for local dev environment
const SERVER_URL = 'http://localhost:3001';
const TEST_GATHERING_ID = 1;
const TEST_DATE = '2025-08-24'; // Today's date
const TEST_INDIVIDUAL_ID = 1; // Assuming there's at least one person in the system

console.log('🧪 Testing WebSocket attendance updates...');

async function testWebSocketAttendance() {
  try {
    console.log(`📡 Connecting to ${SERVER_URL}...`);
    
    // Create socket connection
    const socket = io(SERVER_URL, {
      transports: ['websocket'],
      autoConnect: false
    });

    // Connect and authenticate
    socket.connect();

    socket.on('connect', () => {
      console.log('✅ Connected to WebSocket server');
      
      // Join attendance room
      socket.emit('join_attendance', {
        gatheringId: TEST_GATHERING_ID,
        date: TEST_DATE
      });
      
      console.log(`📝 Joined attendance room for gathering ${TEST_GATHERING_ID} on ${TEST_DATE}`);
    });

    // Listen for attendance updates
    socket.on('attendance_update', (update) => {
      console.log('🔔 Received attendance update:', update);
    });

    // Listen for errors
    socket.on('attendance_update_error', (error) => {
      console.error('❌ Attendance update error:', error);
      process.exit(1);
    });

    socket.on('attendance_update_success', () => {
      console.log('✅ Attendance update successful!');
      socket.disconnect();
      process.exit(0);
    });

    // Test sending attendance update
    setTimeout(() => {
      console.log(`📤 Sending test attendance update...`);
      socket.emit('record_attendance', {
        gatheringId: TEST_GATHERING_ID,
        date: TEST_DATE,
        records: [
          { individualId: TEST_INDIVIDUAL_ID, present: true }
        ]
      });
    }, 2000);

    // Timeout after 10 seconds
    setTimeout(() => {
      console.error('⏰ Test timed out - WebSocket attendance may not be working');
      socket.disconnect();
      process.exit(1);
    }, 10000);

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Test interrupted');
  process.exit(0);
});

// Run the test
testWebSocketAttendance();
