-- Migration 018: Repair family type alignment and snake_case, idempotent
-- This migration safely completes/repairs the goals of 016 and 017 even if they partially ran.

USE church_attendance;

-- =========================
-- PART A: Align family type
-- =========================

-- A1) If familyType exists and familyType_new does not, create temp column
SET @has_familyType := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'familyType'
);
SET @has_familyType_new := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'familyType_new'
);
SET @sql := IF(@has_familyType > 0 AND @has_familyType_new = 0,
  'ALTER TABLE families ADD COLUMN familyType_new ENUM(\'regular\', \'local_visitor\', \'traveller_visitor\') DEFAULT \'regular\'',
  'SELECT 1');
PREPARE m018_a1 FROM @sql; EXECUTE m018_a1; DEALLOCATE PREPARE m018_a1;

-- A2) If temp column exists, populate it based on individuals (only set where old was visitor)
SET @has_familyType_new := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'familyType_new'
);
SET @sql := IF(@has_familyType_new > 0,
  'UPDATE families f SET familyType_new = (\n    SELECT CASE \n      WHEN COUNT(DISTINCT i.people_type) = 1 AND MAX(i.people_type) = \'local_visitor\' THEN \'local_visitor\'\n      WHEN COUNT(DISTINCT i.people_type) = 1 AND MAX(i.people_type) = \'traveller_visitor\' THEN \'traveller_visitor\'\n      WHEN COUNT(DISTINCT i.people_type) > 1 AND SUM(CASE WHEN i.people_type IN (\'local_visitor\', \'traveller_visitor\') THEN 1 ELSE 0 END) > 0 THEN \n        CASE WHEN SUM(CASE WHEN i.people_type = \'local_visitor\' THEN 1 ELSE 0 END) >= SUM(CASE WHEN i.people_type = \'traveller_visitor\' THEN 1 ELSE 0 END) THEN \'local_visitor\' ELSE \'traveller_visitor\' END\n      ELSE \'regular\'\n    END FROM individuals i WHERE i.family_id = f.id\n  ) WHERE f.familyType = \'visitor\'',
  'SELECT 1');
PREPARE m018_a2 FROM @sql; EXECUTE m018_a2; DEALLOCATE PREPARE m018_a2;

-- A3) Default any remaining NULLs to regular (only if temp exists)
SET @sql := IF(@has_familyType_new > 0,
  'UPDATE families f SET familyType_new = \'regular\' WHERE familyType_new IS NULL',
  'SELECT 1');
PREPARE m018_a3 FROM @sql; EXECUTE m018_a3; DEALLOCATE PREPARE m018_a3;

-- A4) If both familyType and familyType_new exist, drop old and rename new to familyType
SET @has_familyType := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'familyType'
);
SET @has_familyType_new := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'familyType_new'
);
SET @sql := IF(@has_familyType > 0 AND @has_familyType_new > 0,
  'ALTER TABLE families DROP COLUMN familyType',
  'SELECT 1');
PREPARE m018_a4 FROM @sql; EXECUTE m018_a4; DEALLOCATE PREPARE m018_a4;

SET @has_familyType := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'familyType'
);
SET @has_familyType_new := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'familyType_new'
);
SET @sql := IF(@has_familyType = 0 AND @has_familyType_new > 0,
  'ALTER TABLE families CHANGE COLUMN familyType_new familyType ENUM(\'regular\', \'local_visitor\', \'traveller_visitor\') DEFAULT \'regular\'',
  'SELECT 1');
PREPARE m018_a5 FROM @sql; EXECUTE m018_a5; DEALLOCATE PREPARE m018_a5;

-- A5) Ensure index on familyType (camel) exists if column exists
SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'families' AND index_name = 'idx_family_type'
);
SET @has_familyType := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'familyType'
);
SET @sql := IF(@has_idx = 0 AND @has_familyType > 0,
  'CREATE INDEX idx_family_type ON families (familyType)',
  'SELECT 1');
PREPARE m018_a6 FROM @sql; EXECUTE m018_a6; DEALLOCATE PREPARE m018_a6;

-- =====================================
-- PART B: Snake_case and remove identifier
-- =====================================

-- B1) Add family_notes if not exists
SET @has_notes := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'family_notes'
);
SET @sql := IF(@has_notes = 0,
  'ALTER TABLE families ADD COLUMN family_notes TEXT AFTER family_name',
  'SELECT 1');
PREPARE m018_b1 FROM @sql; EXECUTE m018_b1; DEALLOCATE PREPARE m018_b1;

-- B2) Migrate notes from family_identifier when present
SET @has_identifier := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'family_identifier'
);
SET @sql := IF(@has_identifier > 0,
  'UPDATE families SET family_notes = CASE \n    WHEN family_notes IS NOT NULL AND family_notes <> \'\' THEN family_notes\n    WHEN family_identifier LIKE \'%:%\' THEN SUBSTRING_INDEX(family_identifier, \'\:\', -1)\n    ELSE family_notes\n  END',
  'SELECT 1');
PREPARE m018_b2 FROM @sql; EXECUTE m018_b2; DEALLOCATE PREPARE m018_b2;

-- B3) Rename familyType -> family_type if needed
SET @has_familyType := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'familyType'
);
SET @has_family_type := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'family_type'
);
SET @sql := IF(@has_familyType > 0 AND @has_family_type = 0,
  'ALTER TABLE families CHANGE COLUMN familyType family_type ENUM(\'regular\', \'local_visitor\', \'traveller_visitor\') DEFAULT \'regular\'',
  'SELECT 1');
PREPARE m018_b3 FROM @sql; EXECUTE m018_b3; DEALLOCATE PREPARE m018_b3;

-- B4) Rename lastAttended -> last_attended if needed
SET @has_lastAttended := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'lastAttended'
);
SET @has_last_attended := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'last_attended'
);
SET @sql := IF(@has_lastAttended > 0 AND @has_last_attended = 0,
  'ALTER TABLE families CHANGE COLUMN lastAttended last_attended DATE',
  'SELECT 1');
PREPARE m018_b4 FROM @sql; EXECUTE m018_b4; DEALLOCATE PREPARE m018_b4;

-- B5) Drop family_identifier if exists
SET @sql := IF(@has_identifier > 0,
  'ALTER TABLE families DROP COLUMN family_identifier',
  'SELECT 1');
PREPARE m018_b5 FROM @sql; EXECUTE m018_b5; DEALLOCATE PREPARE m018_b5;

-- B6) Ensure indexes on family_type and last_attended
SET @has_idx_family_type := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'families' AND index_name = 'idx_family_type'
);
SET @has_family_type := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'family_type'
);
SET @sql := IF(@has_idx_family_type = 0 AND @has_family_type > 0,
  'CREATE INDEX idx_family_type ON families (family_type)',
  'SELECT 1');
PREPARE m018_b6 FROM @sql; EXECUTE m018_b6; DEALLOCATE PREPARE m018_b6;

SET @has_idx_last_attended := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'families' AND index_name = 'idx_last_attended'
);
SET @has_last_attended := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'families' AND column_name = 'last_attended'
);
SET @sql := IF(@has_idx_last_attended = 0 AND @has_last_attended > 0,
  'CREATE INDEX idx_last_attended ON families (last_attended)',
  'SELECT 1');
PREPARE m018_b7 FROM @sql; EXECUTE m018_b7; DEALLOCATE PREPARE m018_b7;

-- End migration 018


