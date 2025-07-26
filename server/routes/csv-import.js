const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { body, validationResult } = require('express-validator');

const Database = require('../config/database');
const { verifyToken, requireRole, auditLog, requireGatheringAccess } = require('../middleware/auth');
const { secureFileUpload, createSecurityRateLimit, sanitizeString } = require('../middleware/security');

const router = express.Router();

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

// All routes require authentication
router.use(verifyToken);

// Upload CSV to gathering with duplicate checking
router.post('/upload/:gatheringId',
  requireRole(['admin', 'coordinator']),
  requireGatheringAccess,
  createSecurityRateLimit(15 * 60 * 1000, 5), // 5 uploads per 15 minutes
  upload.single('csvFile'),
  secureFileUpload(['text/csv'], 5 * 1024 * 1024), // 5MB limit
  auditLog('CSV_UPLOAD'),
  async (req, res) => {
    const { gatheringId } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ error: 'CSV file is required' });
    }

    try {
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

      // Process the CSV data with duplicate checking
      const familyMap = new Map();
      const individuals = [];
      const duplicates = [];
      const skipped = [];

      await Database.transaction(async (conn) => {
        for (const row of results) {
          // Sanitize input data from CSV
          const firstName = sanitizeString(row['FIRST NAME'] || row['First Name'] || row['first_name']);
          const lastName = sanitizeString(row['LAST NAME'] || row['Last Name'] || row['last_name']);
          const familyName = sanitizeString(row['FAMILY NAME'] || row['Family Name'] || row['family_name']);

          if (!firstName || !lastName || firstName.trim() === '' || lastName.trim() === '') {
            skipped.push({ row: row, reason: 'Missing or invalid first or last name' });
            continue;
          }

          // Check for duplicate individuals
          const existingIndividual = await conn.query(`
            SELECT i.id, i.first_name, i.last_name, f.family_name
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id
            WHERE LOWER(i.first_name) = LOWER(?) AND LOWER(i.last_name) = LOWER(?)
          `, [firstName.trim(), lastName.trim()]);

          if (existingIndividual.length > 0) {
            duplicates.push({
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              familyName: familyName,
              existing: existingIndividual[0]
            });
            continue;
          }

          // Check if already in gathering list
          const inGathering = await conn.query(`
            SELECT 1 FROM gathering_lists gl
            JOIN individuals i ON gl.individual_id = i.id
            WHERE gl.gathering_type_id = ? AND LOWER(i.first_name) = LOWER(?) AND LOWER(i.last_name) = LOWER(?)
          `, [gatheringId, firstName.trim(), lastName.trim()]);

          if (inGathering.length > 0) {
            duplicates.push({
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              familyName: familyName,
              reason: 'Already in this gathering'
            });
            continue;
          }

          let familyId = null;
          
          // Handle family creation/assignment
          if (familyName && familyName.trim()) {
            if (!familyMap.has(familyName)) {
              // Check if family already exists
              const existingFamily = await conn.query(
                'SELECT id FROM families WHERE LOWER(family_name) = LOWER(?)',
                [familyName]
              );

              if (existingFamily.length > 0) {
                familyMap.set(familyName, existingFamily[0].id);
              } else {
                const familyResult = await conn.query(`
                  INSERT INTO families (family_name, family_identifier, created_by)
                  VALUES (?, ?, ?)
                `, [familyName, familyName, req.user.id]);
                familyMap.set(familyName, familyResult.insertId);
              }
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
          `, [gatheringId, individualResult.insertId, req.user.id]);

          individuals.push({
            id: individualResult.insertId,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            familyName: familyName
          });
        }
      });

      res.json({
        message: `Import completed`,
        imported: individuals.length,
        families: familyMap.size,
        duplicates: duplicates.length,
        skipped: skipped.length,
        details: {
          imported: individuals,
          duplicates: duplicates,
          skipped: skipped
        }
      });

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

// Get CSV template
router.get('/template', (req, res) => {
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

// Copy & Paste import with optional service assignment
router.post('/copy-paste/:gatheringId?',
  requireRole(['admin', 'coordinator']),
  createSecurityRateLimit(15 * 60 * 1000, 10), // 10 imports per 15 minutes
  auditLog('COPY_PASTE_IMPORT'),
  async (req, res) => {
    const { gatheringId } = req.params;
    const { data, assignToService } = req.body;
    
    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'Data is required' });
    }

    try {
      // Parse tabular data (handle various formats)
      const lines = data.trim().split('\n');
      const results = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Handle different delimiters (comma, tab, semicolon)
        let columns;
        if (line.includes('\t')) {
          columns = line.split('\t');
        } else if (line.includes(';')) {
          columns = line.split(';');
        } else {
          columns = line.split(',');
        }
        
        // Clean up columns (remove quotes, trim whitespace)
        const cleanColumns = columns.map(col => 
          col.replace(/^["']|["']$/g, '').trim()
        );
        
        // Skip header row if it looks like headers
        if (i === 0 && (cleanColumns[0].toLowerCase().includes('first') || 
                       cleanColumns[0].toLowerCase().includes('name'))) {
          continue;
        }
        
        // Expect at least 2 columns (first name, last name)
        if (cleanColumns.length >= 2) {
          const firstName = cleanColumns[0];
          const lastName = cleanColumns[1];
          const familyName = cleanColumns[2] || '';
          
          if (firstName && lastName) {
            results.push({
              'FIRST NAME': firstName,
              'LAST NAME': lastName,
              'FAMILY NAME': familyName
            });
          }
        }
      }

      if (results.length === 0) {
        return res.status(400).json({ error: 'No valid data found' });
      }

      // Process the data similar to CSV import
      const familyMap = new Map();
      const individuals = [];
      const duplicates = [];
      const skipped = [];

      await Database.transaction(async (conn) => {
        for (const row of results) {
          // Sanitize input data
          const firstName = sanitizeString(row['FIRST NAME']);
          const lastName = sanitizeString(row['LAST NAME']);
          const familyName = sanitizeString(row['FAMILY NAME']);

          if (!firstName || !lastName || firstName.trim() === '' || lastName.trim() === '') {
            skipped.push({ row: row, reason: 'Missing or invalid first or last name' });
            continue;
          }

          // Check for duplicate individuals
          const existingIndividual = await conn.query(`
            SELECT i.id, i.first_name, i.last_name, f.family_name
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id
            WHERE LOWER(i.first_name) = LOWER(?) AND LOWER(i.last_name) = LOWER(?)
          `, [firstName.trim(), lastName.trim()]);

          if (existingIndividual.length > 0) {
            duplicates.push({
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              familyName: familyName,
              existing: existingIndividual[0]
            });
            continue;
          }

          // Check if already in gathering list (if gatheringId provided)
          if (gatheringId) {
            const inGathering = await conn.query(`
              SELECT 1 FROM gathering_lists gl
              JOIN individuals i ON gl.individual_id = i.id
              WHERE gl.gathering_type_id = ? AND LOWER(i.first_name) = LOWER(?) AND LOWER(i.last_name) = LOWER(?)
            `, [gatheringId, firstName.trim(), lastName.trim()]);

            if (inGathering.length > 0) {
              duplicates.push({
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                familyName: familyName,
                reason: 'Already in this gathering'
              });
              continue;
            }
          }

          let familyId = null;
          
          // Handle family creation/assignment
          if (familyName && familyName.trim()) {
            if (!familyMap.has(familyName)) {
              // Check if family already exists
              const existingFamily = await conn.query(
                'SELECT id FROM families WHERE LOWER(family_name) = LOWER(?)',
                [familyName]
              );

              if (existingFamily.length > 0) {
                familyMap.set(familyName, existingFamily[0].id);
              } else {
                const familyResult = await conn.query(`
                  INSERT INTO families (family_name, family_identifier, created_by)
                  VALUES (?, ?, ?)
                `, [familyName, familyName, req.user.id]);
                familyMap.set(familyName, familyResult.insertId);
              }
            }
            familyId = familyMap.get(familyName);
          }

          // Create individual
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, created_by)
            VALUES (?, ?, ?, ?)
          `, [firstName.trim(), lastName.trim(), familyId, req.user.id]);

          // Add to gathering list if gatheringId provided
          if (gatheringId) {
            await conn.query(`
              INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by)
              VALUES (?, ?, ?)
            `, [gatheringId, individualResult.insertId, req.user.id]);
          }

          individuals.push({
            id: individualResult.insertId,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            familyName: familyName
          });
        }
      });

      res.json({
        message: `Import completed`,
        imported: individuals.length,
        families: familyMap.size,
        duplicates: duplicates.length,
        skipped: skipped.length,
        assignedToService: !!gatheringId,
        details: {
          imported: individuals,
          duplicates: duplicates,
          skipped: skipped
        }
      });

    } catch (error) {
      console.error('Copy-paste import error:', error);
      res.status(500).json({ error: 'Failed to process data' });
    }
  }
);

// Mass assign individuals to service
router.post('/mass-assign/:gatheringId',
  requireRole(['admin', 'coordinator']),
  requireGatheringAccess,
  auditLog('MASS_ASSIGN_TO_SERVICE'),
  async (req, res) => {
    const { gatheringId } = req.params;
    const { individualIds } = req.body;
    
    if (!individualIds || !Array.isArray(individualIds) || individualIds.length === 0) {
      return res.status(400).json({ error: 'Individual IDs array is required' });
    }

    try {
      const results = {
        assigned: 0,
        alreadyAssigned: 0,
        notFound: 0,
        errors: []
      };

      await Database.transaction(async (conn) => {
        for (const individualId of individualIds) {
          try {
            // Check if individual exists and is active
            const individual = await conn.query(
              'SELECT id FROM individuals WHERE id = ? AND is_active = true',
              [individualId]
            );

            if (individual.length === 0) {
              results.notFound++;
              continue;
            }

            // Check if already assigned to this gathering
            const existingAssignment = await conn.query(
              'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?',
              [gatheringId, individualId]
            );

            if (existingAssignment.length > 0) {
              results.alreadyAssigned++;
              continue;
            }

            // Assign to gathering
            await conn.query(`
              INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by)
              VALUES (?, ?, ?)
            `, [gatheringId, individualId, req.user.id]);

            results.assigned++;

          } catch (error) {
            results.errors.push({ individualId, error: error.message });
          }
        }
      });

      res.json({
        message: 'Mass assignment completed',
        ...results
      });

    } catch (error) {
      console.error('Mass assign error:', error);
      res.status(500).json({ error: 'Failed to assign individuals to service' });
    }
  }
);

// Mass remove individuals from service
router.delete('/mass-remove/:gatheringId',
  requireRole(['admin', 'coordinator']),
  requireGatheringAccess,
  auditLog('MASS_REMOVE_FROM_SERVICE'),
  async (req, res) => {
    const { gatheringId } = req.params;
    const { individualIds } = req.body;
    
    if (!individualIds || !Array.isArray(individualIds) || individualIds.length === 0) {
      return res.status(400).json({ error: 'Individual IDs array is required' });
    }

    try {
      const result = await Database.query(`
        DELETE FROM gathering_lists 
        WHERE gathering_type_id = ? AND individual_id IN (${individualIds.map(() => '?').join(',')})
      `, [gatheringId, ...individualIds]);

      res.json({
        message: 'Mass removal completed',
        removed: result.affectedRows
      });

    } catch (error) {
      console.error('Mass remove error:', error);
      res.status(500).json({ error: 'Failed to remove individuals from service' });
    }
  }
);

module.exports = router; 