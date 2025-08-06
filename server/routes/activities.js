const express = require('express');
const router = express.Router();
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

// Get recent activities for dashboard
router.get('/recent', verifyToken, async (req, res) => {
  console.log('🎯 Activities route hit: /recent');
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const activities = await Database.query(`
      SELECT 
        al.id,
        al.action,
        al.table_name,
        al.record_id,
        al.new_values,
        al.created_at,
        u.first_name,
        u.last_name,
        u.email
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.created_at DESC
      LIMIT ?
    `, [limit]);

    // Process activities to make them more readable
    const processedActivities = activities.map(activity => {
      let actionText = '';
      let target = '';
      let serviceType = null;

      // Map actions to readable text
      switch (activity.action) {
        case 'RECORD_ATTENDANCE':
          actionText = 'recorded';
          target = 'Attendance';
          break;
        case 'ADD_VISITOR':
          actionText = 'added';
          target = 'Visitor';
          break;
        case 'ADD_REGULAR_ATTENDEE':
          actionText = 'added';
          target = 'Regular Attendee';
          break;
        case 'SEND_INVITATION':
          actionText = 'sent invitation to';
          target = 'New User';
          break;
        case 'RESEND_INVITATION':
          actionText = 'resent invitation to';
          target = 'User';
          break;
        case 'CANCEL_INVITATION':
          actionText = 'cancelled invitation for';
          target = 'User';
          break;
        case 'CREATE_USER':
          actionText = 'created';
          target = 'User';
          break;
        case 'UPDATE_USER':
          actionText = 'updated';
          target = 'User';
          break;
        case 'DELETE_USER':
          actionText = 'deleted';
          target = 'User';
          break;
        case 'ASSIGN_USER_GATHERINGS':
          actionText = 'assigned';
          target = 'User to Gatherings';
          break;
        case 'CSV_UPLOAD':
          actionText = 'uploaded CSV for';
          target = 'Import';
          break;
        case 'COPY_PASTE_IMPORT':
          actionText = 'imported data for';
          target = 'Import';
          break;
        case 'MASS_ASSIGN_TO_SERVICE':
          actionText = 'assigned members to';
          target = 'Service';
          break;
        case 'MASS_REMOVE_FROM_SERVICE':
          actionText = 'removed members from';
          target = 'Service';
          break;
        case 'ONBOARDING_CHURCH_INFO':
          actionText = 'updated';
          target = 'Church Information';
          break;
        case 'ONBOARDING_CREATE_GATHERING':
          actionText = 'created';
          target = 'Gathering';
          break;
        case 'ONBOARDING_DELETE_GATHERING':
          actionText = 'deleted';
          target = 'Gathering';
          break;
        case 'ONBOARDING_UPLOAD_CSV':
          actionText = 'uploaded CSV during';
          target = 'Onboarding';
          break;
        case 'ONBOARDING_IMPORT_PASTE':
          actionText = 'imported data during';
          target = 'Onboarding';
          break;
        case 'ONBOARDING_COMPLETE':
          actionText = 'completed';
          target = 'Onboarding';
          break;
        default:
          actionText = activity.action.toLowerCase().replace(/_/g, ' ');
          target = 'Item';
      }

      // Try to extract service type and date from new_values if it's JSON
      let serviceDate = null;
      let actionCount = 1;
      
      if (activity.new_values) {
        try {
          const newValues = JSON.parse(activity.new_values);
          if (newValues.serviceName) {
            serviceType = newValues.serviceName;
          } else if (newValues.gatheringTypeName) {
            serviceType = newValues.gatheringTypeName;
          } else if (newValues.serviceType) {
            serviceType = newValues.serviceType;
          }
          
          if (newValues.serviceDate) {
            serviceDate = newValues.serviceDate;
          }
          
          if (newValues.actionCount) {
            actionCount = newValues.actionCount;
          }
        } catch (e) {
          // Ignore JSON parsing errors
        }
      }

      // Map table_name to more readable service type if not found in new_values
      if (!serviceType && activity.table_name) {
        switch (activity.table_name) {
          case 'gathering_lists':
            serviceType = 'Gathering';
            break;
          case 'user_invitations':
            serviceType = 'User Management';
            break;
          case 'users':
            serviceType = 'User Management';
            break;
          case 'onboarding_progress':
            serviceType = 'Onboarding';
            break;
          case 'attendance_sessions':
            serviceType = 'Attendance';
            break;
          default:
            serviceType = activity.table_name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        }
      }

      return {
        id: activity.id,
        user: `${activity.first_name || 'Unknown'} ${activity.last_name || 'User'}`,
        action: actionText,
        target: target,
        serviceType: serviceType,
        serviceDate: serviceDate,
        actionCount: actionCount,
        timestamp: activity.created_at,
        rawAction: activity.action
      };
    });

    res.json(processedActivities);
  } catch (error) {
    console.error('Get recent activities error:', error);
    res.status(500).json({ error: 'Failed to retrieve recent activities.' });
  }
});

module.exports = router; 