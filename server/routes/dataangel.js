const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const { verifyToken } = require('../middleware/auth');
const Database = require('../config/database');
const logger = require('../config/logger');

const router = express.Router();
router.use(verifyToken);

// Configure multer for file upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

// Helper: Parse CSV from buffer
async function parseCSV(buffer) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const stream = Readable.from(buffer.toString());

    stream
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

// Helper: Detect field mappings
function detectFieldMappings(sampleRow) {
  const fields = Object.keys(sampleRow);
  const mappings = {};

  // First name patterns
  mappings.firstName = fields.find(f =>
    /^(first|given|firstname|first[\s_]?name)$/i.test(f)
  );

  // Last name patterns
  mappings.lastName = fields.find(f =>
    /^(last|family|surname|lastname|last[\s_]?name)$/i.test(f)
  );

  // Email patterns
  mappings.email = fields.find(f =>
    /^(email|e[\s-]?mail|email[\s_]?address)$/i.test(f)
  );

  // Mobile patterns
  mappings.mobile = fields.find(f =>
    /^(mobile|cell|mobile[\s_]?number)$/i.test(f)
  );

  // Phone patterns
  mappings.phone = fields.find(f =>
    /^(phone|tel|phone[\s_]?number)$/i.test(f)
  );

  logger.info('Detected field mappings:', mappings);
  return mappings;
}

// Helper: Extract field value
function extractField(row, fieldName) {
  if (!fieldName) return null;
  const value = row[fieldName];
  return value && value.trim() !== '' ? value.trim() : null;
}

// Helper: Normalize CSV data
function normalizeCSVData(rows) {
  if (rows.length === 0) return [];

  const fieldMappings = detectFieldMappings(rows[0]);

  return rows.map((row, index) => ({
    id: `person_${index}_${Date.now()}`,
    firstName: extractField(row, fieldMappings.firstName),
    lastName: extractField(row, fieldMappings.lastName),
    email: extractField(row, fieldMappings.email),
    mobile: extractField(row, fieldMappings.mobile) || extractField(row, fieldMappings.phone),
    originalData: row
  })).filter(person => person.firstName || person.lastName); // Skip empty rows
}

// Helper: Group people by last name
function groupByLastName(people) {
  const groups = {};

  for (const person of people) {
    const key = (person.lastName || 'Unknown').toLowerCase();
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(person);
  }

  return groups;
}

// Helper: Remove duplicates within a group
function removeDuplicates(members) {
  const seen = new Map();

  for (const member of members) {
    const key = `${member.firstName}|${member.lastName}|${member.email}|${member.mobile}`;

    if (!seen.has(key)) {
      seen.set(key, member);
    } else {
      // Keep the one with more data
      const existing = seen.get(key);
      const existingFields = [existing.email, existing.mobile].filter(Boolean).length;
      const newFields = [member.email, member.mobile].filter(Boolean).length;

      if (newFields > existingFields) {
        seen.set(key, member);
      }
    }
  }

  return Array.from(seen.values());
}

// Helper: Identify main contacts
function identifyMainContacts(members) {
  // Find adults (people with contact info)
  const withContact = members.filter(m => m.email || m.mobile);
  const withoutContact = members.filter(m => !m.email && !m.mobile);

  // Set first person with contact as MC1
  if (withContact.length >= 1) {
    withContact[0].isMainContact1 = true;
    withContact[0].isMainContact2 = false;
  }

  // Set second person with contact as MC2
  if (withContact.length >= 2) {
    withContact[1].isMainContact1 = false;
    withContact[1].isMainContact2 = true;
  }

  // Others are not main contacts
  withContact.slice(2).forEach(m => {
    m.isMainContact1 = false;
    m.isMainContact2 = false;
  });

  withoutContact.forEach(m => {
    m.isMainContact1 = false;
    m.isMainContact2 = false;
  });

  return [...withContact, ...withoutContact];
}

// Helper: Calculate confidence
function calculateConfidence(members) {
  // High confidence: 1-4 members, at least one has contact info
  // Medium confidence: 5-6 members or no contact info
  // Low confidence: 7+ members (likely extended family)

  const withContact = members.filter(m => m.email || m.mobile).length;

  if (members.length >= 7) return 'low';
  if (members.length >= 5) return 'medium';
  if (withContact === 0) return 'medium';
  return 'high';
}

// Helper: Generate family name
function generateFamilyName(members) {
  const mc1 = members.find(m => m.isMainContact1);
  const mc2 = members.find(m => m.isMainContact2);

  if (mc1 && mc2) {
    if (mc1.lastName === mc2.lastName) {
      return `${mc1.lastName} Family`;
    } else {
      return `${mc1.lastName} & ${mc2.lastName}`;
    }
  } else if (mc1) {
    return `${mc1.lastName} Family`;
  } else {
    // Fallback to most common last name
    const lastName = members[0]?.lastName || 'Unknown';
    return `${lastName} Family`;
  }
}

// Main route: Process CSV
router.post('/process', upload.single('file'), async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const userId = req.user.id;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    logger.info('Processing Data Angel CSV', {
      churchId,
      userId,
      filename: req.file.originalname,
      size: req.file.size
    });

    // Step 1: Parse CSV
    const rows = await parseCSV(req.file.buffer);
    logger.info(`Parsed ${rows.length} rows from CSV`);

    // Step 2: Normalize data
    const normalizedPeople = normalizeCSVData(rows);
    logger.info(`Normalized to ${normalizedPeople.length} people`);

    // Step 3: Group by last name
    const lastNameGroups = groupByLastName(normalizedPeople);

    // Step 4: Process each group
    const families = [];
    for (const [lastName, members] of Object.entries(lastNameGroups)) {
      // Remove duplicates
      const uniqueMembers = removeDuplicates(members);

      // Identify main contacts
      const membersWithContacts = identifyMainContacts(uniqueMembers);

      // Calculate confidence
      const confidence = calculateConfidence(membersWithContacts);

      // Generate family name
      const familyName = generateFamilyName(membersWithContacts);

      families.push({
        id: `family_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        suggestedFamilyName: familyName,
        members: membersWithContacts,
        confidence,
        isReviewed: false,
        isConfirmed: false
      });
    }

    // Sort by confidence (low first, so they appear at top for review)
    families.sort((a, b) => {
      const order = { low: 0, medium: 1, high: 2 };
      return order[a.confidence] - order[b.confidence];
    });

    const stats = {
      totalPeople: normalizedPeople.length,
      totalFamilies: families.length,
      highConfidence: families.filter(f => f.confidence === 'high').length,
      mediumConfidence: families.filter(f => f.confidence === 'medium').length,
      lowConfidence: families.filter(f => f.confidence === 'low').length
    };

    logger.info('Data Angel processing complete', stats);

    res.json({
      success: true,
      families,
      stats
    });

  } catch (error) {
    logger.error('Data Angel process error:', error);
    res.status(500).json({
      error: 'Failed to process CSV',
      details: error.message
    });
  }
});

// Import processed families
router.post('/import', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const userId = req.user.id;
    const { families } = req.body;

    if (!Array.isArray(families) || families.length === 0) {
      return res.status(400).json({ error: 'Invalid families data' });
    }

    logger.info('Starting Data Angel import', {
      churchId,
      userId,
      familiesCount: families.length
    });

    await Database.query('START TRANSACTION');

    const importedFamilies = [];
    const importedIndividuals = [];

    for (const family of families) {
      // Create family
      const familyResult = await Database.query(
        `INSERT INTO families (church_id, family_name, created_by, created_at)
         VALUES (?, ?, ?, NOW())`,
        [churchId, family.suggestedFamilyName, userId]
      );

      const familyId = familyResult.insertId;
      importedFamilies.push({
        id: familyId,
        name: family.suggestedFamilyName
      });

      // Create individuals
      for (const member of family.members) {
        const individualResult = await Database.query(
          `INSERT INTO individuals
           (church_id, family_id, first_name, last_name, email, mobile,
            people_type, is_main_contact_1, is_main_contact_2, is_active,
            created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'regular', ?, ?, true, ?, NOW())`,
          [
            churchId,
            familyId,
            member.firstName,
            member.lastName,
            member.email || null,
            member.mobile || null,
            member.isMainContact1,
            member.isMainContact2,
            userId
          ]
        );

        importedIndividuals.push({
          id: individualResult.insertId,
          name: `${member.firstName} ${member.lastName}`
        });
      }
    }

    await Database.query('COMMIT');

    logger.info('Data Angel import completed', {
      churchId,
      userId,
      familiesCount: importedFamilies.length,
      individualsCount: importedIndividuals.length
    });

    res.json({
      success: true,
      imported: {
        families: importedFamilies,
        individuals: importedIndividuals
      }
    });

  } catch (error) {
    await Database.query('ROLLBACK');
    logger.error('Data Angel import error:', error);
    res.status(500).json({
      error: 'Failed to import families',
      details: error.message
    });
  }
});

module.exports = router;
