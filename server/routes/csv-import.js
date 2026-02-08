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
          let familyName = sanitizeString(row['FAMILY NAME'] || row['Family Name'] || row['family_name']);
          if (familyName) {
            // Strip any remaining quotes from family name
            familyName = familyName.replace(/^["']+|["']+$/g, '').trim();
            
            const m = familyName.match(/^([A-Z\s]+),\s*(.*)$/);
            if (m) {
              const surname = m[1].trim().toUpperCase();
              const rest = m[2].trim();
              familyName = `${surname}, ${rest}`;
            } else {
              familyName = familyName.trim();
            }
          }

          if (!firstName || !lastName || firstName.trim() === '' || lastName.trim() === '') {
            skipped.push({ row: row, reason: 'Missing or invalid first or last name' });
            continue;
          }

          // Check for duplicate individuals
          const existingIndividual = await conn.query(`
            SELECT i.id, i.first_name, i.last_name, f.family_name
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id
            WHERE LOWER(i.first_name) = LOWER(?) AND LOWER(i.last_name) = LOWER(?) AND i.church_id = ?
          `, [firstName.trim(), lastName.trim(), req.user.church_id]);

          if (existingIndividual.length > 0) {
            console.log('Found duplicate:', {
              input: { firstName: firstName.trim(), lastName: lastName.trim(), familyName },
              existing: existingIndividual[0]
            });
            
            duplicates.push({
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              familyName: familyName,
              existing: {
                id: Number(existingIndividual[0].id),
                first_name: existingIndividual[0].first_name,
                last_name: existingIndividual[0].last_name,
                family_name: existingIndividual[0].family_name
              },
              reason: 'Person already exists in database'
            });
            continue;
          }

          // Check if already in gathering list
          const inGathering = await conn.query(`
            SELECT 1 FROM gathering_lists gl
            JOIN individuals i ON gl.individual_id = i.id
            WHERE gl.gathering_type_id = ? AND LOWER(i.first_name) = LOWER(?) AND LOWER(i.last_name) = LOWER(?) AND i.church_id = ?
          `, [gatheringId, firstName.trim(), lastName.trim(), req.user.church_id]);

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
                  'SELECT id FROM families WHERE LOWER(family_name) = LOWER(?) AND church_id = ?',
                  [familyName, req.user.church_id]
                );

              if (existingFamily.length > 0) {
                familyMap.set(familyName, Number(existingFamily[0].id));
              } else {
                const familyResult = await conn.query(`
                  INSERT INTO families (family_name, created_by, church_id)
                  VALUES (?, ?, ?)
                `, [familyName, req.user.id, req.user.church_id]);
                familyMap.set(familyName, Number(familyResult.insertId));
              }
            }
            familyId = Number(familyMap.get(familyName));
          }

          // Create individual
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, created_by, church_id)
            VALUES (?, ?, ?, ?, ?)
          `, [firstName.trim(), lastName.trim(), familyId, req.user.id, req.user.church_id]);

          // Add to gathering list
          await conn.query(`
            INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
            VALUES (?, ?, ?, ?)
          `, [gatheringId, individualResult.insertId, req.user.id, req.user.church_id]);

          individuals.push({
            id: Number(individualResult.insertId),
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

// Get TSV template
router.get('/template', verifyToken, async (req, res) => {
  try {
    // Get all gathering types for this church (ordered by creation, not alphabetically)
    const gatherings = await Database.query(`
      SELECT name FROM gathering_types
      WHERE church_id = ?
      ORDER BY id
    `, [req.user.church_id]);
    
    // Create gathering names list for examples
    const gatheringNames = gatherings.map(g => g.name);
    
    // Generate template content with actual gatherings
    let tsvContent = 'FIRST NAME\tLAST NAME\tFAMILY NAME\tGATHERINGS\n';
    
    if (gatheringNames.length > 0) {
      // Create example rows with actual gathering names
      const exampleGatherings1 = gatheringNames.slice(0, 2).join(', ');
      const exampleGatherings2 = gatheringNames[0] || 'Sunday Service';
      const exampleGatherings3 = gatheringNames.length > 1 ? gatheringNames[1] : gatheringNames[0] || 'Bible Study';
      
      tsvContent += `John\tSmith\tSmith, John and Jane\t${exampleGatherings1}\n`;
      tsvContent += `Jane\tSmith\tSmith, John and Jane\t${exampleGatherings2}\n`;
      tsvContent += `Michael\tJohnson\tJohnson, Michael\t${exampleGatherings3}`;
    } else {
      // Fallback if no gatherings exist
      tsvContent += 'John\tSmith\tSmith, John and Jane\tSunday Service, Bible Study\n';
      tsvContent += 'Jane\tSmith\tSmith, John and Jane\tSunday Service\n';
      tsvContent += 'Michael\tJohnson\tJohnson, Michael\tBible Study';
    }
    
    res.setHeader('Content-Type', 'text/tab-separated-values');
    res.setHeader('Content-Disposition', 'attachment; filename="people_import_template.tsv"');
    res.send(tsvContent);
    
  } catch (error) {
    console.error('Error generating template:', error);
    res.status(500).json({ error: 'Failed to generate template' });
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
      console.log('Received copy-paste data:', data);
      console.log('Gathering ID:', gatheringId);
      
      // Parse tabular data (handle various formats). We need to respect quotes
      // so that a family like "SMITH, John and Mary" remains a single field.
      const lines = data.trim().split('\n');
      const results = [];
      
      console.log('Parsed lines:', lines.length);
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        console.log(`Processing line ${i + 1}:`, line);
        
        // Helper: split a line by delimiter while respecting quotes
        const splitRespectingQuotes = (text, delimiter) => {
          const cols = [];
          let current = '';
          let inQuotes = false;
          for (let idx = 0; idx < text.length; idx++) {
            const ch = text[idx];
            if (ch === '"') {
              // Toggle quotes unless escaped by double quote
              if (inQuotes && text[idx + 1] === '"') {
                current += '"';
                idx++; // skip escaped quote
              } else {
                inQuotes = !inQuotes;
              }
            } else if (ch === delimiter && !inQuotes) {
              cols.push(current);
              current = '';
            } else {
              current += ch;
            }
          }
          cols.push(current);
          return cols;
        };

        // Detect delimiter (prefer tabs/semicolons if present); default comma
        let delimiter = ',';
        if (line.includes('\t')) delimiter = '\t';
        else if (line.includes(';')) delimiter = ';';

        const columns = splitRespectingQuotes(line, delimiter);
        
        console.log('Raw columns:', columns);
        
        // Clean up columns (remove wrapping quotes, trim whitespace)
        const cleanColumns = columns.map(col => {
          let v = col.trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
            v = v.slice(1, -1);
          }
          return v.trim();
        });
        
        console.log('Clean columns:', cleanColumns);
        
        // Skip header row if it looks like headers
        if (i === 0 && (cleanColumns[0].toLowerCase().includes('first') || 
                       cleanColumns[0].toLowerCase().includes('name'))) {
          console.log('Skipping header row');
          continue;
        }
        
        // Expect at least 2 columns (first name, last name)
        if (cleanColumns.length >= 2) {
          const firstName = cleanColumns[0];
          const lastName = cleanColumns[1];
          const familyName = cleanColumns[2] || '';
          const gatherings = cleanColumns[3] || '';
          
          // Ensure any remaining quotes are stripped
          const cleanFamilyName = familyName.replace(/^["']+|["']+$/g, '').trim();
          const cleanGatherings = gatherings.replace(/^["']+|["']+$/g, '').trim();
          
          console.log('Parsed row:', { firstName, lastName, familyName: cleanFamilyName, gatherings: cleanGatherings });
          
          if (firstName && lastName) {
            results.push({
              'FIRST NAME': firstName,
              'LAST NAME': lastName,
              'FAMILY NAME': cleanFamilyName,
              'GATHERINGS': cleanGatherings
            });
          } else {
            console.log('Skipping row - missing first or last name');
          }
        } else {
          console.log('Skipping row - insufficient columns');
        }
      }

      console.log('Final results:', results);

      if (results.length === 0) {
        return res.status(400).json({ error: 'No valid data found. Please check your format and try again.' });
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
          let familyName = sanitizeString(row['FAMILY NAME']);
          const gatherings = sanitizeString(row['GATHERINGS'] || '');
          
          if (familyName) {
            // Strip any remaining quotes from family name
            familyName = familyName.replace(/^["']+|["']+$/g, '').trim();
            
            const m = familyName.match(/^([A-Z\s]+),\s*(.*)$/);
            if (m) {
              const surname = m[1].trim().toUpperCase();
              const rest = m[2].trim();
              familyName = `${surname}, ${rest}`;
            } else {
              familyName = familyName.trim();
            }
          }

          if (!firstName || !lastName || firstName.trim() === '' || lastName.trim() === '') {
            skipped.push({ row: row, reason: 'Missing or invalid first or last name' });
            continue;
          }

          // Check for duplicate individuals
          const existingIndividual = await conn.query(`
            SELECT i.id, i.first_name, i.last_name, f.family_name
            FROM individuals i
            LEFT JOIN families f ON i.family_id = f.id
            WHERE LOWER(i.first_name) = LOWER(?) AND LOWER(i.last_name) = LOWER(?) AND i.church_id = ?
          `, [firstName.trim(), lastName.trim(), req.user.church_id]);

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
              WHERE gl.gathering_type_id = ? AND LOWER(i.first_name) = LOWER(?) AND LOWER(i.last_name) = LOWER(?) AND i.church_id = ?
            `, [gatheringId, firstName.trim(), lastName.trim(), req.user.church_id]);

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
                'SELECT id FROM families WHERE LOWER(family_name) = LOWER(?) AND church_id = ?',
                [familyName, req.user.church_id]
              );

              if (existingFamily.length > 0) {
                familyMap.set(familyName, Number(existingFamily[0].id));
              } else {
              const familyResult = await conn.query(`
                INSERT INTO families (family_name, created_by, church_id)
                VALUES (?, ?, ?)
              `, [familyName, req.user.id, req.user.church_id]);
                familyMap.set(familyName, Number(familyResult.insertId));
              }
            }
            familyId = Number(familyMap.get(familyName));
          }

          // Create individual
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, created_by, church_id)
            VALUES (?, ?, ?, ?, ?)
          `, [firstName.trim(), lastName.trim(), familyId, req.user.id, req.user.church_id]);

          // Add to gathering list if gatheringId provided (legacy support)
          if (gatheringId) {
            await conn.query(`
              INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
              VALUES (?, ?, ?, ?)
            `, [gatheringId, Number(individualResult.insertId), req.user.id, req.user.church_id]);
          }

          // Handle gatherings from TSV data
          if (gatherings && gatherings.trim()) {
            const gatheringNames = gatherings.split(',').map(g => g.trim()).filter(g => g);
            const gatheringIds = [];
            const unknownGatherings = [];
            
            for (const gatheringName of gatheringNames) {
              // Try exact match first
              let gathering = await conn.query(`
                SELECT id FROM gathering_types WHERE LOWER(name) = LOWER(?) AND church_id = ?
              `, [gatheringName, req.user.church_id]);
              
              // If no exact match, try partial match (case-insensitive)
              if (gathering.length === 0) {
                gathering = await conn.query(`
                  SELECT id FROM gathering_types WHERE LOWER(name) LIKE LOWER(?) AND church_id = ?
                `, [`%${gatheringName}%`, req.user.church_id]);
              }
              
              if (gathering.length > 0) {
                gatheringIds.push(gathering[0].id);
              } else {
                console.log(`Gathering not found: ${gatheringName}`);
                unknownGatherings.push(gatheringName);
              }
            }
            
            // Add to gathering lists
            for (const gatheringId of gatheringIds) {
              await conn.query(`
                INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
                VALUES (?, ?, ?, ?)
              `, [gatheringId, Number(individualResult.insertId), req.user.id, req.user.church_id]);
            }
            
            // Log unknown gatherings
            if (unknownGatherings.length > 0) {
              console.log(`Unknown gatherings for ${firstName} ${lastName}:`, unknownGatherings);
            }
          }

          individuals.push({
            id: Number(individualResult.insertId),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            familyName: familyName
          });
        }
      });

      console.log('Import completed successfully:', {
        imported: individuals.length,
        families: familyMap.size,
        duplicates: duplicates.length,
        skipped: skipped.length
      });

      // Create a more detailed message
      let message = `Import completed`;
      if (duplicates.length > 0) {
        message += `. ${duplicates.length} duplicate(s) found and skipped.`;
      }
      if (individuals.length > 0) {
        message += ` ${individuals.length} new person(s) imported.`;
      }

      res.json({
        message: message,
        imported: individuals.length,
        families: familyMap.size,
        duplicates: duplicates.length,
        skipped: skipped.length,
        assignedToService: !!gatheringId,
        details: {
          imported: individuals,
          duplicates: duplicates.map(d => ({
            firstName: d.firstName,
            lastName: d.lastName,
            familyName: d.familyName,
            reason: d.reason,
            existingFamily: d.existing?.family_name || 'No family'
          })),
          skipped: skipped
        }
      });

    } catch (error) {
      console.error('Copy-paste import error:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to process data: ' + error.message });
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
              'SELECT id FROM individuals WHERE id = ? AND is_active = true AND church_id = ?',
              [individualId, req.user.church_id]
            );

            if (individual.length === 0) {
              results.notFound++;
              continue;
            }

            // Check if already assigned to this gathering
            const existingAssignment = await conn.query(
              'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?',
              [gatheringId, individualId, req.user.church_id]
            );

            if (existingAssignment.length > 0) {
              results.alreadyAssigned++;
              continue;
            }

            // Assign to gathering
            await conn.query(`
              INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
              VALUES (?, ?, ?, ?)
            `, [gatheringId, individualId, req.user.id, req.user.church_id]);

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
        WHERE gathering_type_id = ? AND individual_id IN (${individualIds.map(() => '?').join(',')}) AND church_id = ?
      `, [gatheringId, ...individualIds, req.user.church_id]);

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

// Mass update people type (regular vs visitor)
router.put('/mass-update-type',
  requireRole(['admin', 'coordinator']),
  auditLog('MASS_UPDATE_PEOPLE_TYPE'),
  async (req, res) => {
    const { individualIds, isVisitor } = req.body;
    
    if (!individualIds || !Array.isArray(individualIds) || individualIds.length === 0) {
      return res.status(400).json({ error: 'Individual IDs array is required' });
    }

    if (typeof isVisitor !== 'boolean') {
      return res.status(400).json({ error: 'isVisitor boolean flag is required' });
    }

    try {
      const results = {
        updated: 0,
        notFound: 0,
        errors: []
      };

      await Database.transaction(async (conn) => {
        for (const individualId of individualIds) {
          try {
            // Check if individual exists
            const individual = await conn.query(
              'SELECT id FROM individuals WHERE id = ? AND is_active = true AND church_id = ?',
              [individualId, req.user.church_id]
            );

            if (individual.length === 0) {
              results.notFound++;
              continue;
            }

            // Update the individual's people type (legacy API defaults visitors to local_visitor)
            const peopleType = isVisitor ? 'local_visitor' : 'regular';
            await conn.query(
              'UPDATE individuals SET people_type = ?, updated_at = NOW() WHERE id = ? AND church_id = ?',
              [peopleType, individualId, req.user.church_id]
            );

            results.updated++;
          } catch (error) {
            console.error(`Error updating individual ${individualId}:`, error);
            results.errors.push({ individualId, error: error.message });
          }
        }
      });

      res.json({
        message: `Mass update completed`,
        updated: results.updated,
        notFound: results.notFound,
        errors: results.errors.length
      });

    } catch (error) {
      console.error('Mass update people type error:', error);
      res.status(500).json({ error: 'Failed to update people type' });
    }
  }
);

// Mass update people type with granular types (regular, local_visitor, traveller_visitor)
router.put('/mass-update-people-type',
  requireRole(['admin', 'coordinator']),
  auditLog('MASS_UPDATE_PEOPLE_TYPE_GRANULAR'),
  async (req, res) => {
    const { individualIds, peopleType } = req.body;
    
    if (!individualIds || !Array.isArray(individualIds) || individualIds.length === 0) {
      return res.status(400).json({ error: 'Individual IDs array is required' });
    }

    if (!peopleType || !['regular', 'local_visitor', 'traveller_visitor'].includes(peopleType)) {
      return res.status(400).json({ error: 'Valid peopleType is required (regular, local_visitor, traveller_visitor)' });
    }

    try {
      const results = {
        updated: 0,
        notFound: 0,
        errors: []
      };

      await Database.transaction(async (conn) => {
        for (const individualId of individualIds) {
          try {
            // Check if individual exists
            const individual = await conn.query(
              'SELECT id, family_id FROM individuals WHERE id = ? AND is_active = true AND church_id = ?',
              [individualId, req.user.church_id]
            );

            if (individual.length === 0) {
              results.notFound++;
              continue;
            }

            // Update the individual's people type
            await conn.query(
              'UPDATE individuals SET people_type = ?, updated_at = NOW() WHERE id = ?',
              [peopleType, individualId]
            );

            // Also update the family type if this person has a family
            const familyId = individual[0].family_id;
            if (familyId) {
              // Check if all family members now have the same people_type
              const familyMembers = await conn.query(
                'SELECT DISTINCT people_type FROM individuals WHERE family_id = ? AND is_active = true AND church_id = ?',
                [familyId, req.user.church_id]
              );

              // If all family members have the same type, update the family type to match
              if (familyMembers.length === 1 && familyMembers[0].people_type) {
                await conn.query(
                  'UPDATE families SET family_type = ?, updated_at = NOW() WHERE id = ? AND church_id = ?',
                  [familyMembers[0].people_type, familyId, req.user.church_id]
                );
              }
            }

            results.updated++;
          } catch (error) {
            console.error(`Error updating individual ${individualId}:`, error);
            results.errors.push({ individualId, error: error.message });
          }
        }
      });

      res.json({
        message: `Mass update completed`,
        updated: results.updated,
        notFound: results.notFound,
        errors: results.errors.length
      });

    } catch (error) {
      console.error('Mass update people type error:', error);
      res.status(500).json({ error: 'Failed to update people type' });
    }
  }
);

// Update existing people's gathering assignments from TSV
router.post('/update-existing',
  requireRole(['admin', 'coordinator']),
  createSecurityRateLimit(15 * 60 * 1000, 10), // 10 updates per 15 minutes
  auditLog('UPDATE_EXISTING_PEOPLE'),
  async (req, res) => {
    const { data } = req.body;
    
    if (!data || typeof data !== 'string') {
      return res.status(400).json({ error: 'Data is required' });
    }

    try {
      console.log('Received update TSV data:', data);
      
      // Parse TSV data
      const lines = data.trim().split('\n');
      const results = [];
      
      console.log('Parsed lines:', lines.length);
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        console.log(`Processing line ${i + 1}:`, line);
        
        // Helper: split a line by delimiter while respecting quotes
        const splitRespectingQuotes = (text, delimiter) => {
          const cols = [];
          let current = '';
          let inQuotes = false;
          for (let idx = 0; idx < text.length; idx++) {
            const ch = text[idx];
            if (ch === '"') {
              // Toggle quotes unless escaped by double quote
              if (inQuotes && text[idx + 1] === '"') {
                current += '"';
                idx++; // skip escaped quote
              } else {
                inQuotes = !inQuotes;
              }
            } else if (ch === delimiter && !inQuotes) {
              cols.push(current);
              current = '';
            } else {
              current += ch;
            }
          }
          cols.push(current);
          return cols;
        };

        // Split by tabs while respecting quotes
        const columns = splitRespectingQuotes(line, '\t');
        
        console.log('Raw columns:', columns);
        
        // Clean up columns (remove wrapping quotes, trim whitespace)
        const cleanColumns = columns.map(col => {
          let v = col.trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) {
            v = v.slice(1, -1);
          }
          return v.trim();
        });
        
        console.log('Clean columns:', cleanColumns);
        
        // Skip header row if it looks like headers
        if (i === 0 && (cleanColumns[0].toLowerCase().includes('first') || 
                       cleanColumns[0].toLowerCase().includes('name'))) {
          console.log('Skipping header row');
          continue;
        }
        
        // Expect: First Name, Last Name, Family Name, Gatherings
        if (cleanColumns.length < 4) {
          console.log(`Line ${i + 1} has insufficient columns:`, cleanColumns);
          continue;
        }
        
        const firstName = cleanColumns[0];
        const lastName = cleanColumns[1];
        const familyName = cleanColumns[2];
        const gatherings = cleanColumns[3];
        
        if (!firstName || !lastName) {
          console.log(`Line ${i + 1} missing first or last name:`, { firstName, lastName });
          continue;
        }
        
        // Find the existing individual
        const existingIndividual = await Database.query(`
          SELECT i.id, i.first_name, i.last_name, f.family_name
          FROM individuals i
          LEFT JOIN families f ON i.family_id = f.id
          WHERE LOWER(i.first_name) = LOWER(?) AND LOWER(i.last_name) = LOWER(?) AND i.church_id = ?
        `, [firstName, lastName, req.user.church_id]);
        
        if (existingIndividual.length === 0) {
          console.log(`Individual not found: ${firstName} ${lastName}`);
          results.push({
            firstName,
            lastName,
            familyName,
            gatherings,
            status: 'not_found',
            reason: 'Person not found in database'
          });
          continue;
        }
        
        const individual = existingIndividual[0];
        
        // Parse gatherings (comma-separated, handle quoted values)
        const gatheringNames = [];
        let current = '';
        let inQuotes = false;
        
        for (let j = 0; j < gatherings.length; j++) {
          const char = gatherings[j];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            const name = current.trim();
            if (name) gatheringNames.push(name);
            current = '';
          } else {
            current += char;
          }
        }
        
        // Add the last gathering name
        const lastGatheringName = current.trim();
        if (lastGatheringName) gatheringNames.push(lastGatheringName);
        
        if (gatheringNames.length === 0) {
          console.log(`No gatherings specified for: ${firstName} ${lastName}`);
          results.push({
            firstName,
            lastName,
            familyName,
            gatherings,
            status: 'skipped',
            reason: 'No gatherings specified'
          });
          continue;
        }
        
        // Find gathering IDs by name (order-independent matching)
        const gatheringIds = [];
        const unknownGatherings = [];
        
        for (const gatheringName of gatheringNames) {
          // Try exact match first
          let gathering = await Database.query(`
            SELECT id FROM gathering_types WHERE LOWER(name) = LOWER(?) AND church_id = ?
          `, [gatheringName, req.user.church_id]);
          
          // If no exact match, try partial match (case-insensitive)
          if (gathering.length === 0) {
            gathering = await Database.query(`
              SELECT id FROM gathering_types WHERE LOWER(name) LIKE LOWER(?) AND church_id = ?
            `, [`%${gatheringName}%`, req.user.church_id]);
          }
          
          if (gathering.length > 0) {
            gatheringIds.push(gathering[0].id);
          } else {
            console.log(`Gathering not found: ${gatheringName}`);
            unknownGatherings.push(gatheringName);
          }
        }
        
        if (gatheringIds.length === 0) {
          console.log(`No valid gatherings found for: ${firstName} ${lastName}`);
          results.push({
            firstName,
            lastName,
            familyName,
            gatherings,
            status: 'skipped',
            reason: 'No valid gatherings found',
            unknownGatherings: unknownGatherings
          });
          continue;
        }
        
        // Update gathering assignments
        await Database.transaction(async (conn) => {
          // Remove existing assignments
          await conn.query(`
            DELETE FROM gathering_lists 
            WHERE individual_id = ? AND church_id = ?
          `, [individual.id, req.user.church_id]);
          
          // Add new assignments
          for (const gatheringId of gatheringIds) {
            await conn.query(`
              INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
              VALUES (?, ?, ?, ?)
            `, [gatheringId, individual.id, req.user.id, req.user.church_id]);
          }
        });
        
        results.push({
          firstName,
          lastName,
          familyName,
          gatherings,
          status: 'updated',
          gatheringsAssigned: gatheringIds.length,
          unknownGatherings: unknownGatherings.length > 0 ? unknownGatherings : undefined
        });
      }
      
      const summary = {
        updated: results.filter(r => r.status === 'updated').length,
        notFound: results.filter(r => r.status === 'not_found').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        total: results.length
      };
      
      res.json({
        message: `Update completed: ${summary.updated} updated, ${summary.notFound} not found, ${summary.skipped} skipped`,
        ...summary,
        details: results
      });
      
    } catch (error) {
      console.error('Error updating existing people:', error);
      res.status(500).json({ error: 'Failed to update existing people' });
    }
  }
);

module.exports = router; 