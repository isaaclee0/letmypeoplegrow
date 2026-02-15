const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireGatheringAccess, auditLog } = require('../middleware/auth');
const { columnExists } = require('../utils/databaseSchema');
const logger = require('../config/logger');

const router = express.Router();

router.use(verifyToken);

// Middleware to disable caching
const disableCache = (req, res, next) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.removeHeader('ETag');
  next();
};

/**
 * Ensure the kiosk_checkins table exists.
 * Called lazily on first request.
 */
let tableEnsured = false;
async function ensureTable() {
  if (tableEnsured) return;
  await Database.query(`
    CREATE TABLE IF NOT EXISTS kiosk_checkins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      gathering_type_id INT NOT NULL,
      session_date DATE NOT NULL,
      individual_id INT NOT NULL,
      action ENUM('checkin', 'checkout') NOT NULL,
      signer_name VARCHAR(255) DEFAULT NULL,
      church_id VARCHAR(36) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_gathering_date (gathering_type_id, session_date),
      INDEX idx_individual (individual_id),
      INDEX idx_church_id (church_id),
      INDEX idx_action (action),
      INDEX idx_created_at (created_at)
    ) ENGINE=InnoDB
  `);
  tableEnsured = true;
}

// ===== Record kiosk check-in or check-out =====
// POST /api/kiosk/:gatheringTypeId/:date
router.post('/:gatheringTypeId/:date', disableCache, async (req, res) => {
  try {
    await ensureTable();

    const { gatheringTypeId, date } = req.params;
    const { individualIds, action, signerName } = req.body;
    // action: 'checkin' | 'checkout'

    if (!individualIds || !Array.isArray(individualIds) || individualIds.length === 0) {
      return res.status(400).json({ error: 'individualIds array is required.' });
    }
    if (!['checkin', 'checkout'].includes(action)) {
      return res.status(400).json({ error: 'action must be "checkin" or "checkout".' });
    }

    const churchId = req.user.church_id;

    await Database.transaction(async (conn) => {
      // Insert kiosk checkin/checkout records
      for (const individualId of individualIds) {
        await conn.query(`
          INSERT INTO kiosk_checkins (gathering_type_id, session_date, individual_id, action, signer_name, church_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [gatheringTypeId, date, individualId, action, signerName || null, churchId]);
      }

      // If check-in, also mark attendance as present
      if (action === 'checkin') {
        const hasSessionsChurchId = await columnExists('attendance_sessions', 'church_id');
        const hasAttendanceRecordsChurchId = await columnExists('attendance_records', 'church_id');
        const hasPeopleTypeAtTime = await columnExists('attendance_records', 'people_type_at_time');
        const hasIndividualsChurchId = await columnExists('individuals', 'church_id');

        // Create or get attendance session
        let sessionResult;
        if (hasSessionsChurchId) {
          sessionResult = await conn.query(`
            INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE updated_at = NOW()
          `, [gatheringTypeId, date, req.user.id, churchId]);
        } else {
          sessionResult = await conn.query(`
            INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE updated_at = NOW()
          `, [gatheringTypeId, date, req.user.id]);
        }

        let sessionId;
        if (sessionResult.insertId) {
          sessionId = Number(sessionResult.insertId);
        } else {
          const sessions = hasSessionsChurchId
            ? await conn.query(
                'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
                [gatheringTypeId, date, churchId]
              )
            : await conn.query(
                'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
                [gatheringTypeId, date]
              );
          if (sessions.length === 0) {
            throw new Error('Failed to create or retrieve attendance session');
          }
          sessionId = Number(sessions[0].id);
        }

        // Mark each individual as present
        for (const individualId of individualIds) {
          let peopleTypeAtTime = null;
          if (hasPeopleTypeAtTime) {
            const individualResult = hasIndividualsChurchId
              ? await conn.query('SELECT people_type FROM individuals WHERE id = ? AND church_id = ?', [individualId, churchId])
              : await conn.query('SELECT people_type FROM individuals WHERE id = ?', [individualId]);
            if (individualResult.length > 0 && individualResult[0].people_type) {
              peopleTypeAtTime = individualResult[0].people_type;
            }
          }

          if (hasAttendanceRecordsChurchId) {
            if (hasPeopleTypeAtTime && peopleTypeAtTime) {
              await conn.query(`
                INSERT INTO attendance_records (session_id, individual_id, present, church_id, people_type_at_time)
                VALUES (?, ?, true, ?, ?)
                ON DUPLICATE KEY UPDATE present = true, people_type_at_time = VALUES(people_type_at_time)
              `, [sessionId, individualId, churchId, peopleTypeAtTime]);
            } else {
              await conn.query(`
                INSERT INTO attendance_records (session_id, individual_id, present, church_id)
                VALUES (?, ?, true, ?)
                ON DUPLICATE KEY UPDATE present = true
              `, [sessionId, individualId, churchId]);
            }
          } else {
            if (hasPeopleTypeAtTime && peopleTypeAtTime) {
              await conn.query(`
                INSERT INTO attendance_records (session_id, individual_id, present, people_type_at_time)
                VALUES (?, ?, true, ?)
                ON DUPLICATE KEY UPDATE present = true, people_type_at_time = VALUES(people_type_at_time)
              `, [sessionId, individualId, peopleTypeAtTime]);
            } else {
              await conn.query(`
                INSERT INTO attendance_records (session_id, individual_id, present)
                VALUES (?, ?, true)
                ON DUPLICATE KEY UPDATE present = true
              `, [sessionId, individualId]);
            }
          }

          // Update last_attendance_date
          if (hasIndividualsChurchId) {
            await conn.query(`
              UPDATE individuals SET last_attendance_date = ? WHERE id = ? AND church_id = ?
            `, [date, individualId, churchId]);
          } else {
            await conn.query(`
              UPDATE individuals SET last_attendance_date = ? WHERE id = ?
            `, [date, individualId]);
          }
        }
      }
      // If checkout, we do NOT modify attendance records at all.
      // The kiosk_checkins log is sufficient.
    });

    // Broadcast WebSocket update for real-time attendance changes (only for checkins)
    if (action === 'checkin') {
      try {
        const websocketBroadcast = require('../utils/websocketBroadcast');
        const records = individualIds.map(id => ({ individualId: id, present: true }));
        websocketBroadcast.broadcastAttendanceRecords(
          gatheringTypeId,
          date,
          req.user.church_id,
          records,
          { updatedBy: req.user.id, updatedAt: new Date().toISOString() }
        );
      } catch (broadcastError) {
        console.error('Error broadcasting kiosk attendance update:', broadcastError);
      }
    }

    const verb = action === 'checkin' ? 'checked in' : 'checked out';
    res.json({ message: `Successfully ${verb} ${individualIds.length} person(s).` });
  } catch (error) {
    console.error('Kiosk record error:', error);
    res.status(500).json({ error: 'Failed to record kiosk action.', details: error.message });
  }
});

// ===== Get kiosk history for past gatherings =====
// GET /api/kiosk/history/:gatheringTypeId
router.get('/history/:gatheringTypeId', disableCache, async (req, res) => {
  try {
    await ensureTable();

    const { gatheringTypeId } = req.params;
    const churchId = req.user.church_id;
    const limit = parseInt(req.query.limit) || 20;

    // Get distinct session dates for this gathering that have kiosk records
    const dates = await Database.query(`
      SELECT DISTINCT session_date
      FROM kiosk_checkins
      WHERE gathering_type_id = ? AND church_id = ?
      ORDER BY session_date DESC
      LIMIT ?
    `, [gatheringTypeId, churchId, limit]);

    const sessions = [];
    for (const row of dates) {
      const dateStr = typeof row.session_date === 'string'
        ? row.session_date
        : new Date(row.session_date).toISOString().split('T')[0];

      // Get all kiosk records for this date
      const records = await Database.query(`
        SELECT 
          kc.id,
          kc.individual_id,
          kc.action,
          kc.signer_name,
          kc.created_at,
          i.first_name,
          i.last_name,
          f.family_name
        FROM kiosk_checkins kc
        LEFT JOIN individuals i ON kc.individual_id = i.id
        LEFT JOIN families f ON i.family_id = f.id
        WHERE kc.gathering_type_id = ? AND kc.session_date = ? AND kc.church_id = ?
        ORDER BY kc.created_at ASC
      `, [gatheringTypeId, dateStr, churchId]);

      sessions.push({
        date: dateStr,
        records: records.map(r => ({
          id: Number(r.id),
          individualId: Number(r.individual_id),
          action: r.action,
          signerName: r.signer_name,
          createdAt: r.created_at,
          firstName: r.first_name,
          lastName: r.last_name,
          familyName: r.family_name,
        })),
      });
    }

    res.json({ sessions });
  } catch (error) {
    console.error('Kiosk history error:', error);
    res.status(500).json({ error: 'Failed to load kiosk history.', details: error.message });
  }
});

// ===== Get kiosk detail for a specific date =====
// GET /api/kiosk/history/:gatheringTypeId/:date
router.get('/history/:gatheringTypeId/:date', disableCache, async (req, res) => {
  try {
    await ensureTable();

    const { gatheringTypeId, date } = req.params;
    const churchId = req.user.church_id;

    const records = await Database.query(`
      SELECT 
        kc.id,
        kc.individual_id,
        kc.action,
        kc.signer_name,
        kc.created_at,
        i.first_name,
        i.last_name,
        f.family_name
      FROM kiosk_checkins kc
      LEFT JOIN individuals i ON kc.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      WHERE kc.gathering_type_id = ? AND kc.session_date = ? AND kc.church_id = ?
      ORDER BY kc.created_at ASC
    `, [gatheringTypeId, date, churchId]);

    // Build a summary: for each individual, find their check-in and check-out times/signers
    const individualsMap = {};
    for (const r of records) {
      const id = Number(r.individual_id);
      if (!individualsMap[id]) {
        individualsMap[id] = {
          individualId: id,
          firstName: r.first_name,
          lastName: r.last_name,
          familyName: r.family_name,
          checkins: [],
          checkouts: [],
        };
      }
      const entry = {
        time: r.created_at,
        signerName: r.signer_name,
      };
      if (r.action === 'checkin') {
        individualsMap[id].checkins.push(entry);
      } else {
        individualsMap[id].checkouts.push(entry);
      }
    }

    const individuals = Object.values(individualsMap);

    res.json({
      date,
      gatheringTypeId: Number(gatheringTypeId),
      individuals,
      rawRecords: records.map(r => ({
        id: Number(r.id),
        individualId: Number(r.individual_id),
        action: r.action,
        signerName: r.signer_name,
        createdAt: r.created_at,
        firstName: r.first_name,
        lastName: r.last_name,
        familyName: r.family_name,
      })),
    });
  } catch (error) {
    console.error('Kiosk history detail error:', error);
    res.status(500).json({ error: 'Failed to load kiosk history detail.', details: error.message });
  }
});

module.exports = router;
