# Data Angel - AI-Powered Import System

**Status**: Planning / Not Yet Implemented
**Feature Type**: Premium Feature
**Last Updated**: 2026-02-10

## Overview

Data Angel is a premium onboarding feature that uses AI to transform messy, unstructured member data into properly formatted families. Instead of requiring users to manually format their data to match a template, Data Angel intelligently groups people into families, identifies main contacts, and presents an intuitive review interface.

## Problem Statement

### Current Import Experience (Free Tier)

1. Download CSV template
2. Open your existing data (Elvanto export, old spreadsheet, etc.)
3. Manually format columns to match template
4. Figure out family relationships
5. Identify main contacts for each family
6. Format family names correctly ("Smith Family", "Jones & Lee")
7. Upload or copy-paste formatted data

**Pain Points:**
- Time-consuming (30-60 minutes for 100 people)
- Error-prone (typos, wrong relationships)
- Requires Excel/spreadsheet skills
- Intimidating for non-technical users
- Blocks onboarding momentum

### Premium Experience (Data Angel)

1. Upload your messy CSV (any format)
2. AI groups people into families automatically
3. Review suggested families in card-based UI
4. Click names to set Main Contact 1 and Main Contact 2
5. Remove people from families if needed
6. Confirm and import

**Benefits:**
- Fast (5-10 minutes for 100 people)
- AI does the heavy lifting
- Visual, intuitive interface
- No spreadsheet skills required
- Smooth premium onboarding

## User Flow

### Step 1: Upload Messy Data

```
┌─────────────────────────────────────────────────┐
│  Data Angel - AI-Powered Import                 │
│                                                  │
│  Upload your member list in any format.         │
│  Don't worry about formatting - I'll handle it! │
│                                                  │
│  ┌────────────────────────────────────────────┐ │
│  │  [Drop CSV file here]                      │ │
│  │  or click to browse                        │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  Supported formats:                              │
│  • Elvanto export                                │
│  • Planning Center export                        │
│  • Excel/Google Sheets                           │
│  • Any CSV with names and contact info           │
│                                                  │
│  [Upload and Process] →                          │
└─────────────────────────────────────────────────┘
```

### Step 2: AI Processing

```
┌─────────────────────────────────────────────────┐
│  ✨ Data Angel is organizing your members...     │
│                                                  │
│  ╔═══════════════════════════════════════╗      │
│  ║ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░ 45% ║      │
│  ╚═══════════════════════════════════════╝      │
│                                                  │
│  ✓ Parsed 127 people                             │
│  ✓ Identified 42 families                        │
│  ⏳ Matching family members...                   │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Step 3: Review Family Cards

```
┌──────────────────────────────────────────────────────────────┐
│  Review Your Families (42 families, 127 people)              │
│                                                              │
│  Click names to set Main Contact 1 (first click) and        │
│  Main Contact 2 (second click). Click [bin] to remove.      │
│                                                              │
│  [✓ Confirm All Families] [← Back] [Skip Review →]          │
└──────────────────────────────────────────────────────────────┘

┌─────────────────────┐  ┌─────────────────────┐  ┌──────────────────┐
│ Smith Family        │  │ Johnson Family      │  │ Martinez & Lee   │
│ ───────────────     │  │ ───────────────     │  │ ────────────     │
│                     │  │                     │  │                  │
│ 👤 John Smith   [MC1]│  │ 👤 Mary Johnson [MC1]│  │ 👤 Carlos M  [MC1]│
│    john@email.com   │  │    mary@email.com   │  │    carlos@...    │
│    0412 345 678     │  │    0423 456 789     │  │    0434 567 890  │
│                     │  │                     │  │                  │
│ 👤 Sarah Smith  [MC2]│  │ 👤 Bob Johnson  [MC2]│  │ 👤 Lisa Lee   [MC2]│
│    sarah@email.com  │  │    bob@email.com    │  │    lisa@email.com│
│    0413 456 789     │  │    0424 567 890     │  │    0435 678 901  │
│                     │  │                     │  │                  │
│ 👶 Emma Smith       │  │ 👶 Tom Johnson      │  │ 👶 Sofia M       │
│    Age 8            │  │    Age 6            │  │    Age 4         │
│ 🗑️                  │  │ 🗑️                  │  │ 🗑️               │
│                     │  │                     │  │                  │
│ 👶 Luke Smith       │  │ 💡 Needs Review     │  │ [✓ Looks Good]   │
│    Age 5            │  │                     │  │                  │
│ 🗑️                  │  │ [Review Family]     │  └──────────────────┘
│                     │  │                     │
│ [✓ Looks Good]      │  └─────────────────────┘
└─────────────────────┘

Confidence Levels:
🟢 High confidence (35 families) - AI is very sure about grouping
🟡 Medium confidence (5 families) - Please review these carefully
🔴 Low confidence (2 families) - Needs your input

[Filter: All | 🔴 Needs Review | ✓ Confirmed]
```

### Step 4: Edit Family Modal (if needed)

```
┌─────────────────────────────────────────────────┐
│  Edit Family: Smith Family                      │
│  ─────────────────────────────────────────────  │
│                                                  │
│  Family Name:                                    │
│  [Smith Family                              ]    │
│                                                  │
│  Members (click to set main contacts):           │
│                                                  │
│  ☑ John Smith [MC1]     john@email.com           │
│     0412 345 678                                 │
│     [🗑️ Remove from family]                      │
│                                                  │
│  ☑ Sarah Smith [MC2]    sarah@email.com          │
│     0413 456 789                                 │
│     [🗑️ Remove from family]                      │
│                                                  │
│  ☐ Emma Smith (Age 8)                            │
│     [🗑️ Remove from family]                      │
│                                                  │
│  ☐ Luke Smith (Age 5)                            │
│     [🗑️ Remove from family]                      │
│                                                  │
│  [Add Person to Family]                          │
│                                                  │
│  [Cancel] [Save Changes]                         │
└─────────────────────────────────────────────────┘
```

### Step 5: Confirm and Import

```
┌─────────────────────────────────────────────────┐
│  Import Summary                                  │
│                                                  │
│  ✓ 42 families ready to import                   │
│  ✓ 127 people ready to import                    │
│  ✓ All families reviewed                         │
│                                                  │
│  What happens next:                              │
│  • Families and people will be added to your     │
│    church database                               │
│  • Email/SMS invitations will NOT be sent        │
│    (you can do this later from People page)      │
│  • Duplicate detection will run automatically    │
│                                                  │
│  [← Back to Review] [Import All Members →]       │
└─────────────────────────────────────────────────┘
```

## Technical Architecture

### Frontend Components

#### New Page: DataAngelImportPage.tsx

```typescript
// client/src/pages/DataAngelImportPage.tsx

interface DataAngelFamily {
  id: string; // temporary UUID for UI
  suggestedFamilyName: string;
  originalFamilyName?: string;
  members: DataAngelMember[];
  confidence: 'high' | 'medium' | 'low';
  aiReasoning?: string; // why AI grouped these people
  isReviewed: boolean;
  isConfirmed: boolean;
}

interface DataAngelMember {
  id: string; // temporary UUID
  firstName: string;
  lastName: string;
  email?: string;
  mobile?: string;
  dateOfBirth?: string;
  age?: number;
  isMainContact1: boolean;
  isMainContact2: boolean;
  suggestedRole?: 'adult' | 'child' | 'unknown';
  originalData: Record<string, any>; // raw CSV row
}

const DataAngelImportPage = () => {
  const [step, setStep] = useState<'upload' | 'processing' | 'review' | 'confirm'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [families, setFamilies] = useState<DataAngelFamily[]>([]);
  const [processingStatus, setProcessingStatus] = useState('');
  const [filter, setFilter] = useState<'all' | 'needs-review' | 'confirmed'>('all');

  // Handle file upload
  const handleFileUpload = async (file: File) => {
    setFile(file);
    setStep('processing');

    const formData = new FormData();
    formData.append('file', file);

    const response = await dataAngelAPI.process(formData, (status) => {
      setProcessingStatus(status);
    });

    setFamilies(response.families);
    setStep('review');
  };

  // Toggle main contact status
  const toggleMainContact = (familyId: string, memberId: string) => {
    setFamilies(families.map(family => {
      if (family.id !== familyId) return family;

      return {
        ...family,
        members: family.members.map(member => {
          if (member.id !== memberId) return member;

          // Toggle cycle: none → MC1 → MC2 → none
          if (!member.isMainContact1 && !member.isMainContact2) {
            return { ...member, isMainContact1: true };
          } else if (member.isMainContact1) {
            return { ...member, isMainContact1: false, isMainContact2: true };
          } else {
            return { ...member, isMainContact2: false };
          }
        })
      };
    }));
  };

  // Remove member from family
  const removeMember = (familyId: string, memberId: string) => {
    setFamilies(families.map(family => {
      if (family.id !== familyId) return family;
      return {
        ...family,
        members: family.members.filter(m => m.id !== memberId)
      };
    }).filter(family => family.members.length > 0)); // Remove empty families
  };

  // Confirm family
  const confirmFamily = (familyId: string) => {
    setFamilies(families.map(family => {
      if (family.id !== familyId) return family;
      return { ...family, isConfirmed: true, isReviewed: true };
    }));
  };

  // Confirm all families
  const confirmAllFamilies = () => {
    setFamilies(families.map(family => ({
      ...family,
      isConfirmed: true,
      isReviewed: true
    })));
    setStep('confirm');
  };

  // Import all families
  const importFamilies = async () => {
    await dataAngelAPI.import(families);
    navigate('/people');
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {step === 'upload' && <UploadStep onUpload={handleFileUpload} />}
      {step === 'processing' && <ProcessingStep status={processingStatus} />}
      {step === 'review' && (
        <ReviewStep
          families={families}
          filter={filter}
          onFilterChange={setFilter}
          onToggleMainContact={toggleMainContact}
          onRemoveMember={removeMember}
          onConfirmFamily={confirmFamily}
          onConfirmAll={confirmAllFamilies}
        />
      )}
      {step === 'confirm' && (
        <ConfirmStep
          families={families}
          onBack={() => setStep('review')}
          onImport={importFamilies}
        />
      )}
    </div>
  );
};
```

#### FamilyCard Component

```typescript
// client/src/components/dataangel/FamilyCard.tsx

interface FamilyCardProps {
  family: DataAngelFamily;
  onToggleMainContact: (memberId: string) => void;
  onRemoveMember: (memberId: string) => void;
  onConfirm: () => void;
  onEdit: () => void;
}

const FamilyCard: React.FC<FamilyCardProps> = ({
  family,
  onToggleMainContact,
  onRemoveMember,
  onConfirm,
  onEdit
}) => {
  const getConfidenceColor = (confidence: string) => {
    switch (confidence) {
      case 'high': return 'bg-green-50 border-green-200';
      case 'medium': return 'bg-yellow-50 border-yellow-200';
      case 'low': return 'bg-red-50 border-red-200';
      default: return 'bg-gray-50 border-gray-200';
    }
  };

  const getConfidenceBadge = (confidence: string) => {
    switch (confidence) {
      case 'high': return '🟢 High confidence';
      case 'medium': return '🟡 Please review';
      case 'low': return '🔴 Needs your input';
      default: return '';
    }
  };

  return (
    <div className={`rounded-lg border-2 p-4 ${getConfidenceColor(family.confidence)} ${
      family.isConfirmed ? 'opacity-75' : ''
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">{family.suggestedFamilyName}</h3>
        <button
          onClick={onEdit}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          Edit
        </button>
      </div>

      {/* Confidence badge */}
      {!family.isConfirmed && (
        <div className="text-xs text-gray-600 mb-3">
          {getConfidenceBadge(family.confidence)}
        </div>
      )}

      {/* Members */}
      <div className="space-y-3">
        {family.members.map(member => (
          <MemberItem
            key={member.id}
            member={member}
            onToggleMainContact={() => onToggleMainContact(member.id)}
            onRemove={() => onRemoveMember(member.id)}
          />
        ))}
      </div>

      {/* AI reasoning (if available) */}
      {family.aiReasoning && !family.isConfirmed && (
        <div className="mt-3 pt-3 border-t border-gray-200 text-xs text-gray-500">
          💡 {family.aiReasoning}
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 pt-3 border-t border-gray-200">
        {family.isConfirmed ? (
          <div className="flex items-center text-green-600 text-sm">
            <CheckCircleIcon className="h-5 w-5 mr-2" />
            Confirmed
          </div>
        ) : (
          <button
            onClick={onConfirm}
            className="w-full bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
          >
            ✓ Looks Good
          </button>
        )}
      </div>
    </div>
  );
};
```

#### MemberItem Component

```typescript
// client/src/components/dataangel/MemberItem.tsx

interface MemberItemProps {
  member: DataAngelMember;
  onToggleMainContact: () => void;
  onRemove: () => void;
}

const MemberItem: React.FC<MemberItemProps> = ({
  member,
  onToggleMainContact,
  onRemove
}) => {
  const getMainContactBadge = () => {
    if (member.isMainContact1) return <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded">MC1</span>;
    if (member.isMainContact2) return <span className="text-xs bg-purple-600 text-white px-2 py-0.5 rounded">MC2</span>;
    return null;
  };

  const getRoleIcon = () => {
    switch (member.suggestedRole) {
      case 'adult': return '👤';
      case 'child': return '👶';
      default: return '👤';
    }
  };

  return (
    <div className="flex items-start space-x-3 p-2 rounded hover:bg-white/50 cursor-pointer group">
      <div className="flex-1" onClick={onToggleMainContact}>
        <div className="flex items-center space-x-2">
          <span>{getRoleIcon()}</span>
          <span className="font-medium">
            {member.firstName} {member.lastName}
          </span>
          {getMainContactBadge()}
        </div>
        {member.email && (
          <div className="text-xs text-gray-600 ml-6">{member.email}</div>
        )}
        {member.mobile && (
          <div className="text-xs text-gray-600 ml-6">{member.mobile}</div>
        )}
        {member.age && (
          <div className="text-xs text-gray-500 ml-6">Age {member.age}</div>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-700 transition-opacity"
        title="Remove from family"
      >
        <TrashIcon className="h-5 w-5" />
      </button>
    </div>
  );
};
```

### Backend Implementation

#### API Endpoint: Process CSV

```javascript
// server/routes/dataangel.js

const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
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

// Process uploaded CSV with AI
router.post('/process', upload.single('file'), async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const userId = req.user.id;

    // Check if church has Data Angel feature enabled (premium check)
    const hasDataAngel = await checkDataAngelAccess(churchId);
    if (!hasDataAngel) {
      return res.status(403).json({
        error: 'Data Angel is a premium feature. Please upgrade to access it.'
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse CSV
    const rows = await parseCSV(req.file.buffer);
    logger.info(`Parsed ${rows.length} rows from CSV`, { churchId, userId });

    // Step 1: Normalize data
    const normalizedPeople = await normalizeCSVData(rows);

    // Step 2: Apply rule-based grouping
    const ruleBasedGroups = groupByRules(normalizedPeople);

    // Step 3: Apply AI-based grouping (for uncertain cases)
    const aiEnhancedGroups = await enhanceGroupingsWithAI(ruleBasedGroups, churchId);

    // Step 4: Identify main contacts
    const familiesWithMainContacts = identifyMainContacts(aiEnhancedGroups);

    // Step 5: Generate family names
    const families = generateFamilyNames(familiesWithMainContacts);

    res.json({
      success: true,
      families,
      stats: {
        totalPeople: normalizedPeople.length,
        totalFamilies: families.length,
        highConfidence: families.filter(f => f.confidence === 'high').length,
        mediumConfidence: families.filter(f => f.confidence === 'medium').length,
        lowConfidence: families.filter(f => f.confidence === 'low').length
      }
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

    // Validate families structure
    if (!Array.isArray(families) || families.length === 0) {
      return res.status(400).json({ error: 'Invalid families data' });
    }

    // Start transaction
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
      importedFamilies.push({ id: familyId, name: family.suggestedFamilyName });

      // Create individuals
      for (const member of family.members) {
        const individualResult = await Database.query(
          `INSERT INTO individuals
           (church_id, family_id, first_name, last_name, email, mobile, date_of_birth,
            people_type, is_main_contact_1, is_main_contact_2, is_active, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'regular', ?, ?, true, ?, NOW())`,
          [
            churchId,
            familyId,
            member.firstName,
            member.lastName,
            member.email || null,
            member.mobile || null,
            member.dateOfBirth || null,
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

// Helper functions

async function parseCSV(buffer) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const stream = require('stream');
    const bufferStream = new stream.PassThrough();
    bufferStream.end(buffer);

    bufferStream
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

async function normalizeCSVData(rows) {
  // Detect column mapping and normalize field names
  const fieldMappings = detectFieldMappings(rows[0]);

  return rows.map((row, index) => {
    const normalized = {
      id: `person_${index}`,
      firstName: extractField(row, fieldMappings.firstName),
      lastName: extractField(row, fieldMappings.lastName),
      email: extractField(row, fieldMappings.email),
      mobile: extractField(row, fieldMappings.mobile),
      dateOfBirth: extractField(row, fieldMappings.dateOfBirth),
      age: calculateAge(extractField(row, fieldMappings.dateOfBirth)),
      originalData: row
    };

    return normalized;
  });
}

function detectFieldMappings(sampleRow) {
  // Smart column detection based on common patterns
  const fields = Object.keys(sampleRow);
  const mappings = {};

  // First name patterns
  mappings.firstName = fields.find(f =>
    /^(first|given|firstname|givenname|fname)[\s_]?name?$/i.test(f)
  ) || fields.find(f => /first|given/i.test(f));

  // Last name patterns
  mappings.lastName = fields.find(f =>
    /^(last|family|surname|lastname|familyname|lname)[\s_]?name?$/i.test(f)
  ) || fields.find(f => /last|family|surname/i.test(f));

  // Email patterns
  mappings.email = fields.find(f =>
    /^e?mail([\s_]?address)?$/i.test(f)
  );

  // Mobile patterns
  mappings.mobile = fields.find(f =>
    /^(mobile|cell|phone|tel|contact)[\s_]?(number|phone)?$/i.test(f)
  );

  // Date of birth patterns
  mappings.dateOfBirth = fields.find(f =>
    /^(dob|birth[\s_]?date|date[\s_]?of[\s_]?birth|birthday)$/i.test(f)
  );

  return mappings;
}

function extractField(row, fieldName) {
  if (!fieldName) return null;
  const value = row[fieldName];
  return value && value.trim() !== '' ? value.trim() : null;
}

function calculateAge(dob) {
  if (!dob) return null;
  const birthDate = new Date(dob);
  if (isNaN(birthDate.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

function groupByRules(people) {
  // Rule-based grouping logic
  // Group by last name initially
  const lastNameGroups = {};

  for (const person of people) {
    const key = person.lastName?.toLowerCase() || 'unknown';
    if (!lastNameGroups[key]) {
      lastNameGroups[key] = [];
    }
    lastNameGroups[key].push(person);
  }

  // Convert to array of groups
  const groups = Object.entries(lastNameGroups).map(([lastName, members]) => ({
    id: `family_${Date.now()}_${Math.random()}`,
    members,
    originalLastName: lastName,
    confidence: calculateConfidence(members),
    groupingMethod: 'last_name'
  }));

  return groups;
}

function calculateConfidence(members) {
  // Calculate confidence based on group characteristics
  // High confidence: 2-5 members with mix of adults and children
  // Medium confidence: Single person or 6+ members
  // Low confidence: Uncertain groupings

  if (members.length === 1) return 'medium';
  if (members.length > 6) return 'medium';

  const adults = members.filter(m => !m.age || m.age >= 18).length;
  const children = members.length - adults;

  if (adults >= 1 && adults <= 2 && children >= 0) {
    return 'high';
  }

  return 'medium';
}

async function enhanceGroupingsWithAI(groups, churchId) {
  // Use AI to enhance uncertain groupings
  // Only process groups with medium/low confidence

  const uncertainGroups = groups.filter(g => g.confidence !== 'high');

  if (uncertainGroups.length === 0) {
    return groups;
  }

  // Get AI config
  const config = await getAiConfig(churchId);
  if (!config || !config.api_key) {
    // Skip AI enhancement if not configured
    return groups;
  }

  // Process uncertain groups with AI
  for (const group of uncertainGroups) {
    try {
      const aiAnalysis = await analyzeGroupWithAI(group, config);
      group.confidence = aiAnalysis.confidence;
      group.aiReasoning = aiAnalysis.reasoning;
      group.suggestedSplits = aiAnalysis.suggestedSplits; // If AI suggests splitting
    } catch (error) {
      logger.warn('AI analysis failed for group, keeping rule-based result', { error });
    }
  }

  return groups;
}

async function analyzeGroupWithAI(group, aiConfig) {
  // Build AI prompt
  const membersList = group.members.map(m =>
    `- ${m.firstName} ${m.lastName}${m.age ? ` (age ${m.age})` : ''}${m.email ? ` - ${m.email}` : ''}`
  ).join('\n');

  const prompt = `Analyze if these people belong to the same family:

${membersList}

Consider:
- Ages (adults vs children)
- Name patterns
- Likely relationships

Respond with JSON:
{
  "confidence": "high|medium|low",
  "reasoning": "Brief explanation",
  "shouldSplit": false,
  "suggestedSplits": []
}`;

  const systemPrompt = `You are a family relationship analyzer for a church management system.
Your job is to determine if a group of people likely belong to the same family based on their names, ages, and contact information.`;

  let response;
  if (aiConfig.provider === 'openai') {
    response = await callOpenAI(aiConfig.api_key, systemPrompt, prompt, 'gpt-4o-mini');
  } else {
    response = await callAnthropic(aiConfig.api_key, systemPrompt, prompt, 'claude-haiku-4-5-20251001');
  }

  // Parse AI response
  try {
    const analysis = JSON.parse(response);
    return {
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
      suggestedSplits: analysis.suggestedSplits || []
    };
  } catch (e) {
    return {
      confidence: 'medium',
      reasoning: 'Could not parse AI response',
      suggestedSplits: []
    };
  }
}

function identifyMainContacts(groups) {
  // Identify likely main contacts based on age, order, etc.

  return groups.map(group => {
    const adults = group.members
      .filter(m => !m.age || m.age >= 18)
      .sort((a, b) => {
        // Sort: has email > has mobile > alphabetical
        const aScore = (a.email ? 2 : 0) + (a.mobile ? 1 : 0);
        const bScore = (b.email ? 2 : 0) + (b.mobile ? 1 : 0);
        if (aScore !== bScore) return bScore - aScore;
        return (a.firstName || '').localeCompare(b.firstName || '');
      });

    // Set first adult as MC1, second as MC2
    if (adults.length >= 1) {
      adults[0].isMainContact1 = true;
      adults[0].isMainContact2 = false;
      adults[0].suggestedRole = 'adult';
    }
    if (adults.length >= 2) {
      adults[1].isMainContact1 = false;
      adults[1].isMainContact2 = true;
      adults[1].suggestedRole = 'adult';
    }

    // Set children
    group.members.forEach(m => {
      if (m.age && m.age < 18) {
        m.suggestedRole = 'child';
        m.isMainContact1 = false;
        m.isMainContact2 = false;
      }
      if (!m.suggestedRole) {
        m.suggestedRole = 'unknown';
      }
    });

    return group;
  });
}

function generateFamilyNames(groups) {
  return groups.map(group => {
    const mainContact1 = group.members.find(m => m.isMainContact1);
    const mainContact2 = group.members.find(m => m.isMainContact2);

    let familyName;

    if (mainContact1 && mainContact2) {
      // Check if same last name
      if (mainContact1.lastName === mainContact2.lastName) {
        familyName = `${mainContact1.lastName} Family`;
      } else {
        familyName = `${mainContact1.lastName} & ${mainContact2.lastName}`;
      }
    } else if (mainContact1) {
      familyName = `${mainContact1.lastName} Family`;
    } else {
      // Fallback to most common last name
      const lastNames = {};
      group.members.forEach(m => {
        const ln = m.lastName || 'Unknown';
        lastNames[ln] = (lastNames[ln] || 0) + 1;
      });
      const mostCommon = Object.entries(lastNames).sort((a, b) => b[1] - a[1])[0];
      familyName = `${mostCommon[0]} Family`;
    }

    return {
      id: group.id,
      suggestedFamilyName: familyName,
      originalFamilyName: group.originalLastName,
      members: group.members,
      confidence: group.confidence,
      aiReasoning: group.aiReasoning,
      isReviewed: false,
      isConfirmed: false
    };
  });
}

async function checkDataAngelAccess(churchId) {
  // Check if church has Data Angel feature
  // This could check:
  // - Subscription tier
  // - Feature flags
  // - One-time purchase
  // For now, return true (everyone has access during beta)
  return true;
}

async function getAiConfig(churchId) {
  // Reuse from ai.js
  try {
    const rows = await Database.query(`
      SELECT preference_value
      FROM user_preferences
      WHERE preference_key = 'ai_config' AND church_id = ?
      LIMIT 1
    `, [churchId]);

    if (rows.length === 0) return null;

    const val = rows[0].preference_value;
    return typeof val === 'string' ? JSON.parse(val) : val;
  } catch (error) {
    return null;
  }
}

// Reuse callOpenAI and callAnthropic from ai.js
// (or extract to shared service)

module.exports = router;
```

## Premium Feature Implementation

### Subscription Tiers

**Free Tier:**
- Manual CSV import with template
- No AI assistance
- Must format data themselves

**Basic Tier ($9/mo):**
- Template-based import
- Basic duplicate detection

**Pro Tier ($29/mo):**
- ✨ **Data Angel** - AI-powered import
- Unlimited family grouping
- Priority processing

**Enterprise Tier (Custom):**
- Data Angel
- Bulk imports (1000+ people)
- Custom field mapping
- Dedicated onboarding support

### Feature Gate

```typescript
// client/src/pages/PeoplePage.tsx - Import button

const ImportButton = () => {
  const hasDataAngel = subscription?.tier === 'pro' || subscription?.tier === 'enterprise';

  return (
    <Menu>
      <MenuButton>Import Members</MenuButton>
      <MenuItems>
        <MenuItem onClick={() => navigate('/import/template')}>
          <DocumentIcon /> Import from Template
        </MenuItem>
        {hasDataAngel ? (
          <MenuItem onClick={() => navigate('/import/data-angel')}>
            <SparklesIcon className="text-purple-500" /> Data Angel (AI Import)
          </MenuItem>
        ) : (
          <MenuItem onClick={() => navigate('/upgrade')} className="text-purple-600">
            <LockClosedIcon /> Data Angel - Pro Feature
            <span className="text-xs">Upgrade to unlock</span>
          </MenuItem>
        )}
      </MenuItems>
    </Menu>
  );
};
```

## AI Prompt Design

### Family Grouping Prompt

```
You are analyzing a group of people who share the same last name to determine if they belong to the same family.

People:
- John Smith (age 42) - john@email.com
- Sarah Smith (age 40) - sarah@email.com
- Emma Smith (age 8)
- Luke Smith (age 5)

Your task:
1. Determine if these people likely belong to the same family
2. Consider age patterns (parents vs children)
3. Consider contact information (do adults have separate emails?)
4. Consider name patterns (middle names, suffixes, etc.)

Respond with ONLY valid JSON:
{
  "confidence": "high|medium|low",
  "reasoning": "Brief 1-2 sentence explanation of why you grouped them this way",
  "shouldSplit": false,
  "suggestedGroups": []
}

Examples:

High confidence: 2 adults (35-50) + 0-3 children (0-18) with same last name
Medium confidence: Single person, or large family (6+), or ambiguous ages
Low confidence: Multiple adults with very different ages, might be extended family

If shouldSplit is true, provide suggestedGroups as separate family arrays.
```

## Testing Strategy

### Test Cases

1. **Perfect data**: Pre-formatted CSV with family names, main contacts marked
   - Expected: High confidence on all families

2. **Messy data**: No family grouping, mixed last names, missing fields
   - Expected: Medium confidence, AI groups by last name

3. **Elvanto export**: Real-world export with specific field names
   - Expected: Correct field mapping, proper family grouping

4. **Single-parent families**: One adult, children
   - Expected: Correctly identify single MC1

5. **Blended families**: Different last names for children
   - Expected: AI suggests reviewing these families

6. **Extended families**: Multiple generations in one household
   - Expected: Medium/low confidence, user review required

7. **Large families**: 6+ children
   - Expected: Grouped correctly despite size

8. **Special characters**: Names with accents, apostrophes, hyphens
   - Expected: Handle gracefully

### User Acceptance Testing

- Upload 100-person CSV from Elvanto
- Review AI groupings
- Edit 5 families (change MC, remove member)
- Confirm and import
- Verify all data in People page
- Check for duplicates

## Performance Considerations

### Processing Time

- 100 people: ~30-60 seconds (includes AI calls)
- 500 people: ~2-5 minutes
- 1000 people: ~5-10 minutes

### Optimization Strategies

1. **Batch AI Calls**: Group multiple uncertain families into single AI request
2. **Caching**: Cache AI responses for identical groupings
3. **Parallel Processing**: Process families concurrently
4. **Progressive Loading**: Show results as they're processed
5. **Rule-First**: Use AI only for uncertain cases (saves API calls)

### Cost Analysis

**Per Import (100 people, 40 families, 5 AI calls):**
- AI cost: ~$0.005 (using Haiku for fast processing)
- Processing time: 45 seconds
- User time saved: 30-45 minutes vs manual formatting

**Cost per church per month (est. 2 imports):**
- $0.01 in AI costs
- Included in Pro tier ($29/mo)
- Extremely high ROI for users

## Future Enhancements

### Phase 2 Features

1. **Smart Duplicate Detection**
   - Use AI to identify duplicates across imports
   - Fuzzy matching on names, emails, phone numbers
   - Suggest merges during review

2. **Historical Learning**
   - Learn from user corrections
   - Improve grouping accuracy over time
   - Church-specific patterns

3. **Custom Field Mapping**
   - Remember field mappings per church
   - Support custom fields
   - Map to gathering lists automatically

4. **Photo Import**
   - Extract faces from group photos
   - Match to imported names
   - Bulk photo upload during import

5. **Multi-Step Import**
   - Import basic info first
   - Add details later (photos, addresses, notes)
   - Progressive enhancement

6. **Import Templates**
   - Save custom templates
   - Share templates with other churches
   - Template marketplace

### Advanced Features

1. **Real-time Collaboration**
   - Multiple admins review families simultaneously
   - Live updates via WebSocket

2. **Import History**
   - Track all imports
   - Rollback capability
   - Audit log

3. **Scheduled Imports**
   - Auto-sync from Elvanto/PCO
   - Weekly/monthly updates
   - Change detection only

4. **Import Analytics**
   - Show growth over time
   - Track import sources
   - Data quality scores

## Marketing & Positioning

### Value Proposition

**For Small Churches (50-150 people):**
> "Set up your entire church database in 10 minutes, not 2 hours. Data Angel uses AI to organize your member list so you can focus on ministry, not spreadsheets."

**For Growing Churches (150-500 people):**
> "Migrating from another system? Data Angel handles the messy data conversion so you can onboard in minutes, not days."

**For Large Churches (500+ people):**
> "Bulk imports that just work. Upload thousands of members and let AI handle the complex family relationships."

### Upgrade Prompts

When free user tries to import:
```
┌──────────────────────────────────────────────────┐
│  🎯 Spend less time on data, more time on people │
│                                                  │
│  Data Angel can import this in 10 minutes:      │
│  ✓ Automatically group families                  │
│  ✓ Identify main contacts                        │
│  ✓ Handle messy data formats                     │
│  ✓ Save 30-45 minutes per import                 │
│                                                  │
│  [Try Data Angel - Upgrade to Pro] →             │
│                                                  │
│  Or [continue with manual template import]       │
└──────────────────────────────────────────────────┘
```

### Testimonials (Future)

> "Data Angel saved me 3 hours when we switched from our old system. I just uploaded our spreadsheet and it figured everything out!"
> — Pastor John, First Baptist Church

> "We had 400 people in an old Excel file with inconsistent formatting. Data Angel organized them into families in 15 minutes. Amazing!"
> — Sarah, Church Administrator

## Success Metrics

### Product Metrics

- Import completion rate
- Time to import (start to finish)
- AI confidence accuracy
- User edit rate (% of families edited)
- Support tickets related to imports
- Upgrade conversion rate (free → pro after seeing feature)

### Business Metrics

- Pro tier adoption
- Feature usage (% of Pro users using Data Angel)
- Customer satisfaction (NPS score post-import)
- Churn reduction (users who import are stickier)

## Documentation & Support

### User Guide

1. **Getting Started Video** (3 min)
   - Show complete import flow
   - Highlight key features
   - Address common questions

2. **Step-by-Step Tutorial**
   - Screenshot guide
   - Common issues and fixes
   - Tips for best results

3. **FAQ**
   - What formats are supported?
   - How accurate is the AI?
   - Can I edit after importing?
   - What if something goes wrong?
   - Can I re-import if I made a mistake?

### Support Resources

- In-app tooltips and hints
- Live chat during import process (Pro tier)
- Sample CSV files for testing
- Video tutorial library
- Community forum

## Implementation Checklist

### Phase 1: MVP (4-6 weeks)

- [ ] Design UI/UX mockups
- [ ] Create DataAngelImportPage component
- [ ] Build CSV parser with field detection
- [ ] Implement rule-based grouping logic
- [ ] Add AI enhancement for uncertain groups
- [ ] Build family review card interface
- [ ] Implement main contact toggle
- [ ] Add remove member functionality
- [ ] Build import confirmation flow
- [ ] Create backend API endpoints
- [ ] Add feature gate (Pro tier check)
- [ ] Write unit tests
- [ ] User testing with 5 churches
- [ ] Documentation

### Phase 2: Enhancement (2-3 weeks)

- [ ] Add progress indicators
- [ ] Implement batch processing for large imports
- [ ] Add undo/redo functionality
- [ ] Build import history page
- [ ] Add duplicate detection during import
- [ ] Create upgrade prompts for free users
- [ ] A/B test messaging and pricing
- [ ] Performance optimization
- [ ] Error handling improvements

### Phase 3: Polish (1-2 weeks)

- [ ] Analytics dashboard for imports
- [ ] Support chat integration
- [ ] Video tutorials
- [ ] Marketing page for feature
- [ ] Success stories / testimonials
- [ ] Email drip campaign (educate about feature)

## Conclusion

Data Angel transforms member onboarding from a tedious, error-prone manual process into a delightful, AI-powered experience. By combining rule-based logic with AI intelligence and wrapping it in an intuitive review interface, we remove the biggest barrier to church adoption: getting their data into the system.

This premium feature justifies Pro tier pricing, reduces churn, and creates a competitive moat that's hard to replicate without significant AI investment.

**Next Steps**: Review this plan, validate with beta users, and begin Phase 1 development.
