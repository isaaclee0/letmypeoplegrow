/**
 * WebSocket broadcast utilities for real-time updates
 * This module provides a simple interface for routes to broadcast updates
 * without directly coupling them to the WebSocket service
 */

let webSocketService = null;

/**
 * Initialize the broadcast service with the WebSocket service instance
 * Called from the main server file after WebSocket service is initialized
 * @param {Object} wsService - WebSocket service instance
 */
function initialize(wsService) {
  webSocketService = wsService;
}

/**
 * Broadcast attendance record updates
 * @param {number} gatheringId - Gathering ID
 * @param {string} date - Date string (YYYY-MM-DD)
 * @param {number} churchId - Church ID
 * @param {Array} attendanceRecords - Array of attendance record updates
 * @param {Object} options - Additional options
 */
function broadcastAttendanceRecords(gatheringId, date, churchId, attendanceRecords, options = {}) {
  if (!webSocketService) {
    return; // WebSocket not available, skip broadcast
  }

  webSocketService.broadcastAttendanceUpdate(gatheringId, date, churchId, {
    type: 'attendance_records',
    records: attendanceRecords,
    ...options
  });
}

/**
 * Broadcast visitor updates
 * @param {number} gatheringId - Gathering ID  
 * @param {string} date - Date string (YYYY-MM-DD)
 * @param {number} churchId - Church ID
 * @param {Array} visitors - Array of visitor updates
 * @param {Object} options - Additional options
 */
function broadcastVisitorUpdates(gatheringId, date, churchId, visitors, options = {}) {
  if (!webSocketService) {
    return; // WebSocket not available, skip broadcast
  }

  webSocketService.broadcastVisitorUpdate(gatheringId, date, churchId, {
    type: 'visitors',
    visitors: visitors,
    ...options
  });
}

/**
 * Broadcast visitor family addition
 * @param {number} gatheringId - Gathering ID
 * @param {string} date - Date string (YYYY-MM-DD)
 * @param {number} churchId - Church ID
 * @param {Object} family - Family data
 * @param {Array} visitors - Added visitors
 */
function broadcastVisitorFamilyAdded(gatheringId, date, churchId, family, visitors) {
  if (!webSocketService) {
    return; // WebSocket not available, skip broadcast
  }

  webSocketService.broadcastVisitorUpdate(gatheringId, date, churchId, {
    type: 'visitor_family_added',
    family: family,
    visitors: visitors
  });
}

/**
 * Broadcast visitor family update
 * @param {number} gatheringId - Gathering ID
 * @param {string} date - Date string (YYYY-MM-DD)
 * @param {number} churchId - Church ID
 * @param {Object} family - Updated family data
 * @param {Array} visitors - Updated visitors
 */
function broadcastVisitorFamilyUpdated(gatheringId, date, churchId, family, visitors) {
  if (!webSocketService) {
    return; // WebSocket not available, skip broadcast
  }

  webSocketService.broadcastVisitorUpdate(gatheringId, date, churchId, {
    type: 'visitor_family_updated',
    family: family,
    visitors: visitors
  });
}

/**
 * Broadcast full attendance list refresh
 * @param {number} gatheringId - Gathering ID
 * @param {string} date - Date string (YYYY-MM-DD)
 * @param {number} churchId - Church ID
 * @param {Array} attendanceList - Full attendance list
 * @param {Array} visitors - Full visitors list
 */
function broadcastFullRefresh(gatheringId, date, churchId, attendanceList, visitors) {
  if (!webSocketService) {
    return; // WebSocket not available, skip broadcast
  }

  webSocketService.broadcastAttendanceUpdate(gatheringId, date, churchId, {
    type: 'full_refresh',
    attendanceList: attendanceList,
    visitors: visitors
  });
}

/**
 * Broadcast headcount updates
 * @param {string} event - Event name
 * @param {Object} data - Data to broadcast
 * @param {string} roomName - Room name (optional, for room-based broadcasting)
 */
function websocketBroadcast(event, data, roomName) {
  if (!webSocketService) {
    return; // WebSocket not available, skip broadcast
  }

  // Use the WebSocket service's broadcast method
  webSocketService.broadcastToChurch(data.churchId || 'default', event, data);
}

/**
 * Get connection status
 * @returns {boolean} True if WebSocket service is available
 */
function isConnected() {
  return webSocketService !== null;
}

module.exports = {
  initialize,
  broadcastAttendanceRecords,
  broadcastVisitorUpdates,
  broadcastVisitorFamilyAdded,
  broadcastVisitorFamilyUpdated,
  broadcastFullRefresh,
  websocketBroadcast,
  isConnected
};
