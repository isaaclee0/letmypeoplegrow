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

module.exports = router; 