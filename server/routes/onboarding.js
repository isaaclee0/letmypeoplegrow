const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { body, validationResult } = require('express-validator');

const Database = require('../config/database');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');
const { secureFileUpload, createSecurityRateLimit, sanitizeString } = require('../middleware/security');
const { getSupportedCountries, supportsMobileNumbers } = require('../utils/phoneNumber');

// Helper function to create sample attendance sessions for testing
const createSampleAttendanceSessions = async (gatheringId, dayOfWeek, userId) => {
  try {
    const dayMap = {
      'Sunday': 0,
      'Monday': 1,
      'Tuesday': 2,
      'Wednesday': 3,
      'Thursday': 4,
      'Friday': 5,
      'Saturday': 6
    };
    
    const targetDay = dayMap[dayOfWeek];
    const today = new Date();
    const sessions = [];
    
    // Create sessions for the past 4 weeks
    for (let i = 1; i <= 4; i++) {
      const sessionDate = new Date(today);
      
      // Go back to the most recent occurrence of the target day
      const daysToSubtract = (today.getDay() - targetDay + 7) % 7;
      sessionDate.setDate(today.getDate() - daysToSubtract - (7 * i));
      
      // Format date as YYYY-MM-DD
      const formattedDate = sessionDate.toISOString().split('T')[0];
      
      // Create attendance session
      const sessionResult = await Database.query(`
        INSERT INTO attendance_sessions (gathering_type_id, session_date, recorded_by)
        VALUES (?, ?, ?)
      `, [gatheringId, formattedDate, userId]);
      
      sessions.push({
        id: Number(sessionResult.insertId),
        date: formattedDate
      });
    }
    
    console.log(`Created ${sessions.length} sample attendance sessions for gathering ${gatheringId}`);
    return sessions;
  } catch (error) {
    console.error('Error creating sample attendance sessions:', error);
    // Don't throw error - this is just for testing convenience
  }
};



const router = express.Router();

// Helper function to save onboarding progress
const saveOnboardingProgress = async (userId, currentStep, data = {}, completedSteps = []) => {
  try {
    // Check if progress record exists
    const existingProgress = await Database.query(
      'SELECT id FROM onboarding_progress WHERE user_id = ?',
      [userId]
    );

    if (existingProgress.length > 0) {
      // Update existing progress
      const updateData = { current_step: currentStep, updated_at: new Date() };
      
      // Add data fields if provided
      if (data.church_info) updateData.church_info = JSON.stringify(data.church_info);
      if (data.gatherings) updateData.gatherings = JSON.stringify(data.gatherings);
      if (data.csv_upload) updateData.csv_upload = JSON.stringify(data.csv_upload);
      
      // Update completed steps
      if (completedSteps.length > 0) {
        const currentCompleted = await Database.query(
          'SELECT completed_steps FROM onboarding_progress WHERE user_id = ?',
          [userId]
        );
        
        let existingCompleted = [];
        if (currentCompleted[0]?.completed_steps) {
          try {
            // Handle both string and object cases
            let parsed;
            if (typeof currentCompleted[0].completed_steps === 'string') {
              parsed = JSON.parse(currentCompleted[0].completed_steps);
            } else if (typeof currentCompleted[0].completed_steps === 'object') {
              parsed = currentCompleted[0].completed_steps;
            } else {
              console.error('Unexpected completed_steps type:', typeof currentCompleted[0].completed_steps);
              parsed = [];
            }
            existingCompleted = Array.isArray(parsed) ? parsed : [];
          } catch (parseError) {
            console.error('Failed to parse completed_steps:', parseError);
            existingCompleted = [];
          }
        }
        
        existingCompleted = [...new Set([...existingCompleted, ...completedSteps])];
        updateData.completed_steps = JSON.stringify(existingCompleted);
      }

      // Build update query with explicit columns
      const updateColumns = [];
      const updateValues = [];
      
      Object.entries(updateData).forEach(([key, value]) => {
        if (key !== 'updated_at') {
          updateColumns.push(`${key} = ?`);
          updateValues.push(value);
        }
      });
      
      if (updateColumns.length > 0) {
        updateValues.push(userId);
        await Database.query(
          `UPDATE onboarding_progress SET ${updateColumns.join(', ')}, updated_at = NOW() WHERE user_id = ?`,
          updateValues
        );
      }
    } else {
      // Create new progress record
      const progressData = {
        user_id: userId,
        current_step: currentStep,
        completed_steps: JSON.stringify(completedSteps)
      };
      
      if (data.church_info) progressData.church_info = JSON.stringify(data.church_info);
      if (data.gatherings) progressData.gatherings = JSON.stringify(data.gatherings);
      if (data.csv_upload) progressData.csv_upload = JSON.stringify(data.csv_upload);

      // Build insert query with explicit columns
      const insertColumns = Object.keys(progressData);
      const insertValues = Object.values(progressData);
      const placeholders = insertColumns.map(() => '?').join(', ');
      
      await Database.query(
        `INSERT INTO onboarding_progress (${insertColumns.join(', ')}) VALUES (${placeholders})`,
        insertValues
      );
    }
  } catch (error) {
    console.error('Save onboarding progress error:', error);
  }
};

// Configure multer for CSV uploads
const upload = multer({ 
  dest: 'uploads/',
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Check onboarding status
router.get('/status', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const settings = await Database.query('SELECT * FROM church_settings LIMIT 1');
    
    // Get user's onboarding progress
    const progress = await Database.query(
      'SELECT * FROM onboarding_progress WHERE user_id = ?',
      [req.user.id]
    );
    
    res.json({
      completed: settings.length > 0 && settings[0].onboarding_completed,
      settings: settings.length > 0 ? settings[0] : null,
      progress: progress.length > 0 ? progress[0] : null
    });
  } catch (error) {
    console.error('Get onboarding status error:', error);
    res.status(500).json({ error: 'Failed to get onboarding status' });
  }
});

// Get supported countries for onboarding
router.get('/countries', verifyToken, requireRole(['admin']), async (req, res) => {
  try {
    const countries = getSupportedCountries();
    res.json({ countries });
  } catch (error) {
    console.error('Get countries error:', error);
    res.status(500).json({ error: 'Failed to get supported countries' });
  }
});

// Step 1: Set church name
router.post('/church-info', 
  verifyToken, 
  requireRole(['admin']),
  auditLog('ONBOARDING_CHURCH_INFO'),
  [
    body('churchName')
      .trim()
      .isLength({ min: 1, max: 255 })
      .withMessage('Church name is required and must be less than 255 characters'),
    body('countryCode')
      .trim()
      .isLength({ min: 2, max: 2 })
      .isAlpha()
      .withMessage('Valid country code is required')
      .custom((value) => {
        if (!supportsMobileNumbers(value)) {
          throw new Error('Country not supported for mobile numbers');
        }
        return true;
      }),
    body('timezone')
      .optional()
      .isString()
      .withMessage('Invalid timezone'),
    body('emailFromName')
      .optional()
      .trim()
      .isLength({ max: 255 })
      .withMessage('Email from name must be less than 255 characters'),
    body('emailFromAddress')
      .optional()
      .isEmail()
      .withMessage('Invalid email address')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { churchName, countryCode, timezone, emailFromName, emailFromAddress } = req.body;

      // Check if settings already exist
      const existingSettings = await Database.query('SELECT id FROM church_settings LIMIT 1');
      
      if (existingSettings.length > 0) {
        // Update existing settings
        await Database.query(`
          UPDATE church_settings 
          SET church_name = ?, country_code = ?, timezone = ?, email_from_name = ?, email_from_address = ?, updated_at = NOW()
          WHERE id = ?
        `, [
          churchName,
          countryCode.toUpperCase(),
          timezone || 'America/New_York',
          emailFromName || 'Let My People Grow',
          emailFromAddress || 'noreply@redeemercc.org.au',
          existingSettings[0].id
        ]);
      } else {
        // Create new settings
        await Database.query(`
          INSERT INTO church_settings (church_name, country_code, timezone, email_from_name, email_from_address)
          VALUES (?, ?, ?, ?, ?)
        `, [
          churchName,
          countryCode.toUpperCase(),
          timezone || 'America/New_York',
          emailFromName || 'Let My People Grow',
          emailFromAddress || 'noreply@redeemercc.org.au'
        ]);
      }

      // Save progress
      const churchInfo = { churchName, countryCode, timezone, emailFromName, emailFromAddress };
      await saveOnboardingProgress(req.user.id, 2, { church_info: churchInfo }, [1]);

      res.json({ message: 'Church information saved successfully' });
    } catch (error) {
      console.error('Save church info error:', error);
      res.status(500).json({ error: 'Failed to save church information' });
    }
  }
);

// Step 2: Create gathering
router.post('/gathering',
  verifyToken,
  requireRole(['admin']),
  auditLog('ONBOARDING_CREATE_GATHERING'),
  [
    body('name')
      .trim()
      .isLength({ min: 1, max: 255 })
      .withMessage('Gathering name is required and must be less than 255 characters'),
    body('description')
      .optional()
      .trim(),
    body('dayOfWeek')
      .isIn(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
      .withMessage('Valid day of week is required'),
    body('startTime')
      .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Valid start time is required (HH:MM format)'),
    body('durationMinutes')
      .isInt({ min: 15, max: 480 })
      .withMessage('Duration must be between 15 and 480 minutes'),
    body('frequency')
      .isIn(['weekly', 'biweekly', 'monthly'])
      .withMessage('Valid frequency is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, description, dayOfWeek, startTime, durationMinutes, frequency } = req.body;

      const result = await Database.query(`
        INSERT INTO gathering_types (name, description, day_of_week, start_time, duration_minutes, frequency, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [name, description, dayOfWeek, startTime, durationMinutes, frequency, req.user.id]);

      // Assign the admin user to this gathering
      await Database.query(`
        INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by)
        VALUES (?, ?, ?)
      `, [req.user.id, Number(result.insertId), req.user.id]);

      // Create sample attendance sessions for testing (going back 4 weeks)
      await createSampleAttendanceSessions(Number(result.insertId), dayOfWeek, req.user.id);

      // Get all gatherings for this user to save progress
      const userGatherings = await Database.query(`
        SELECT gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.duration_minutes, gt.frequency
        FROM gathering_types gt
        JOIN user_gathering_assignments uga ON gt.id = uga.gathering_type_id
        WHERE uga.user_id = ?
        ORDER BY gt.name
      `, [req.user.id]);

      // Save progress
      await saveOnboardingProgress(req.user.id, 2, { gatherings: userGatherings });

      res.json({ 
        message: 'Gathering created successfully',
        gatheringId: Number(result.insertId) 
      });
    } catch (error) {
      console.error('Create gathering error:', error);
      res.status(500).json({ error: 'Failed to create gathering' });
    }
  }
);

// Delete gathering during onboarding
router.delete('/gathering/:gatheringId',
  verifyToken,
  requireRole(['admin']),
  auditLog('ONBOARDING_DELETE_GATHERING'),
  async (req, res) => {
    try {
      const { gatheringId } = req.params;

      // Verify gathering exists and user has access
      const gatherings = await Database.query(
        'SELECT id FROM gathering_types WHERE id = ? AND created_by = ?',
        [gatheringId, req.user.id]
      );

      if (gatherings.length === 0) {
        return res.status(404).json({ error: 'Gathering not found or access denied' });
      }

      // Delete gathering (cascade will handle related records)
      await Database.query(
        'DELETE FROM gathering_types WHERE id = ?',
        [gatheringId]
      );

      res.json({ message: 'Gathering deleted successfully' });
    } catch (error) {
      console.error('Delete gathering error:', error);
      res.status(500).json({ error: 'Failed to delete gathering' });
    }
  }
);

// Step 3: Upload CSV
router.post('/upload-csv/:gatheringId',
  verifyToken,
  requireRole(['admin', 'coordinator']),
  createSecurityRateLimit(15 * 60 * 1000, 5), // 5 uploads per 15 minutes
  upload.single('csvFile'),
  secureFileUpload(['text/csv'], 5 * 1024 * 1024), // 5MB limit
  auditLog('ONBOARDING_UPLOAD_CSV'),
  async (req, res) => {
    const { gatheringId } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required' });
    }

    try {
      // Verify gathering exists and user has access
      const gatherings = await Database.query(
        'SELECT id FROM gathering_types WHERE id = ? AND created_by = ?',
        [gatheringId, req.user.id]
      );

      if (gatherings.length === 0) {
        return res.status(404).json({ error: 'Gathering not found or access denied' });
      }

      const results = [];
      const filePath = req.file.path;

      // Parse CSV file
      const parsePromise = new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on('data', (data) => results.push(data))
          .on('end', () => resolve(results))
          .on('error', (err) => reject(err));
      });

      await parsePromise;

      // Clean up uploaded file
      fs.unlinkSync(filePath);

      if (results.length === 0) {
        return res.status(400).json({ error: 'CSV file is empty or invalid' });
      }

      // Process the CSV data
      const familyMap = new Map();
      const individuals = [];

      await Database.transaction(async (conn) => {
        for (const row of results) {
          // Sanitize input data from CSV
          const firstName = sanitizeString(row['FIRST NAME'] || row['First Name'] || row['first_name']);
          const lastName = sanitizeString(row['LAST NAME'] || row['Last Name'] || row['last_name']);
          const familyName = sanitizeString(row['FAMILY NAME'] || row['Family Name'] || row['family_name']);

          if (!firstName || !lastName || firstName.trim() === '' || lastName.trim() === '') {
            continue; // Skip invalid rows
          }

          let familyId = null;
          
          // Handle family creation/assignment
          if (familyName && familyName.trim()) {
            if (!familyMap.has(familyName)) {
              const familyResult = await conn.query(`
                INSERT INTO families (family_name, family_identifier, created_by)
                VALUES (?, ?, ?)
              `, [familyName, familyName, req.user.id]);
              familyMap.set(familyName, Number(familyResult.insertId));
            }
            familyId = familyMap.get(familyName);
          }

          // Create individual
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, created_by)
            VALUES (?, ?, ?, ?)
          `, [firstName.trim(), lastName.trim(), familyId, req.user.id]);

          // Add to gathering list
          await conn.query(`
            INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by)
            VALUES (?, ?, ?)
          `, [gatheringId, Number(individualResult.insertId), req.user.id]);

          individuals.push({
            id: Number(individualResult.insertId),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            familyName: familyName
          });
        }
      });

      // Save progress
      const uploadResult = {
        message: `Successfully imported ${individuals.length} individuals`,
        imported: individuals.length,
        families: familyMap.size,
        gatheringId: Number(gatheringId)
      };
      
      await saveOnboardingProgress(req.user.id, 3, { csv_upload: uploadResult }, [2]);

      res.json(uploadResult);

    } catch (error) {
      // Clean up file if error occurs
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      console.error('CSV upload error:', error);
      res.status(500).json({ error: 'Failed to process CSV file' });
    }
  }
);

// Step 3: Import Paste Data
router.post('/import-paste/:gatheringId',
  verifyToken,
  requireRole(['admin', 'coordinator']),
  createSecurityRateLimit(15 * 60 * 1000, 10), // 10 imports per 15 minutes
  [
    body('data').isString().notEmpty().withMessage('Data is required')
  ],
  auditLog('ONBOARDING_IMPORT_PASTE'),
  async (req, res) => {
    const { gatheringId } = req.params;
    const { data } = req.body;
    
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      // Verify gathering exists and user has access
      const gatherings = await Database.query(
        'SELECT id FROM gathering_types WHERE id = ? AND created_by = ?',
        [gatheringId, req.user.id]
      );

      if (gatherings.length === 0) {
        return res.status(404).json({ error: 'Gathering not found or access denied' });
      }

      // Parse data from string - handle both CSV and TSV (spreadsheet paste)
      const lines = data.trim().split('\n');
      if (lines.length < 2) {
        return res.status(400).json({ error: 'Invalid data - must have headers and at least one row' });
      }

      // Detect delimiter by analyzing the first line
      const firstLine = lines[0];
      const commaCount = (firstLine.match(/,/g) || []).length;
      const tabCount = (firstLine.match(/\t/g) || []).length;
      
      let delimiter = ',';
      if (tabCount > commaCount) {
        delimiter = '\t';
      }

      // Parse headers
      const headers = lines[0].split(delimiter).map(h => h.trim().replace(/"/g, ''));
      const firstNameIndex = headers.findIndex(h => 
        h.toUpperCase() === 'FIRST NAME' || h.toUpperCase() === 'FIRSTNAME'
      );
      const lastNameIndex = headers.findIndex(h => 
        h.toUpperCase() === 'LAST NAME' || h.toUpperCase() === 'LASTNAME'
      );
      const familyNameIndex = headers.findIndex(h => 
        h.toUpperCase() === 'FAMILY NAME' || h.toUpperCase() === 'FAMILYNAME'
      );

      if (firstNameIndex === -1 || lastNameIndex === -1) {
        return res.status(400).json({ error: 'Data must contain FIRST NAME and LAST NAME columns' });
      }

      // Process the CSV data
      const familyMap = new Map();
      const individuals = [];

      await Database.transaction(async (conn) => {
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          // Parse row (handle quoted values and detected delimiter)
          const values = [];
          let current = '';
          let inQuotes = false;
          
          for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
              inQuotes = !inQuotes;
            } else if (char === delimiter && !inQuotes) {
              values.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          values.push(current.trim());

          if (values.length < Math.max(firstNameIndex, lastNameIndex) + 1) {
            continue; // Skip invalid rows
          }

          // Extract and sanitize data
          const firstName = sanitizeString(values[firstNameIndex] || '');
          const lastName = sanitizeString(values[lastNameIndex] || '');
          const familyName = familyNameIndex !== -1 ? sanitizeString(values[familyNameIndex] || '') : '';

          if (!firstName || !lastName || firstName.trim() === '' || lastName.trim() === '') {
            continue; // Skip invalid rows
          }

          let familyId = null;
          
          // Handle family creation/assignment
          if (familyName && familyName.trim()) {
            if (!familyMap.has(familyName)) {
              const familyResult = await conn.query(`
                INSERT INTO families (family_name, family_identifier, created_by)
                VALUES (?, ?, ?)
              `, [familyName, familyName, req.user.id]);
              familyMap.set(familyName, Number(familyResult.insertId));
            }
            familyId = familyMap.get(familyName);
          }

          // Create individual
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, created_by)
            VALUES (?, ?, ?, ?)
          `, [firstName.trim(), lastName.trim(), familyId, req.user.id]);

          // Add to gathering list
          await conn.query(`
            INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by)
            VALUES (?, ?, ?)
          `, [gatheringId, Number(individualResult.insertId), req.user.id]);

          individuals.push({
            id: Number(individualResult.insertId),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            familyName: familyName
          });
        }
      });

      // Save progress
      const uploadResult = {
        message: `Successfully imported ${individuals.length} individuals`,
        imported: individuals.length,
        families: familyMap.size,
        gatheringId: Number(gatheringId)
      };
      
      await saveOnboardingProgress(req.user.id, 3, { csv_upload: uploadResult }, [2]);

      res.json(uploadResult);

    } catch (error) {
      console.error('Paste import error:', error);
      res.status(500).json({ error: 'Failed to process pasted data. Please check the format and try again.' });
    }
  }
);

// Complete onboarding
router.post('/complete',
  verifyToken,
  requireRole(['admin']),
  auditLog('ONBOARDING_COMPLETE'),
  async (req, res) => {
    try {
      await Database.query(`
        UPDATE church_settings 
        SET onboarding_completed = true, updated_at = NOW()
        WHERE id = (SELECT id FROM church_settings LIMIT 1)
      `);

      // Mark onboarding as completed in progress
      await saveOnboardingProgress(req.user.id, 4, {}, [3, 4]);

      res.json({ message: 'Onboarding completed successfully' });
    } catch (error) {
      console.error('Complete onboarding error:', error);
      res.status(500).json({ error: 'Failed to complete onboarding' });
    }
  }
);

// Save onboarding progress (for navigation between steps)
router.post('/save-progress',
  verifyToken,
  requireRole(['admin']),
  [
    body('currentStep').isInt({ min: 1, max: 4 }).withMessage('Valid step number is required'),
    body('data').optional().isObject().withMessage('Data must be an object')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { currentStep, data = {} } = req.body;
      
      await saveOnboardingProgress(req.user.id, currentStep, data);

      res.json({ message: 'Progress saved successfully' });
    } catch (error) {
      console.error('Save progress error:', error);
      res.status(500).json({ error: 'Failed to save progress' });
    }
  }
);

// Get CSV template
router.get('/csv-template', (req, res) => {
  const templatePath = path.join(__dirname, '../../import_template.csv');
  
  if (fs.existsSync(templatePath)) {
    res.download(templatePath, 'attendance_import_template.csv');
  } else {
    // Fallback: generate template content
    const csvContent = '"FIRST NAME","LAST NAME","FAMILY NAME"\n"John","Smith","SMITH, John and Jane"\n"Jane","Smith","SMITH, John and Jane"\n"Michael","Johnson","JOHNSON, Michael"';
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance_import_template.csv"');
    res.send(csvContent);
  }
});

module.exports = router; 