-- Migration 017: Snake_case columns and remove family_identifier
-- - Rename families.familyType  -> family_type
-- - Rename families.lastAttended -> last_attended
-- - Add families.family_notes (TEXT) to preserve visitor notes
-- - Migrate notes from family_identifier (if in format "<type>:<notes>")
-- - Drop families.family_identifier and related indexes

-- Make operations idempotent where possible

-- 1) Add family_notes if not exists
SET @notes_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'families'
    AND column_name = 'family_notes'
);

SET @sql := IF(@notes_exists = 0,
  'ALTER TABLE families ADD COLUMN family_notes TEXT AFTER family_name',
  'SELECT "family_notes exists"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) Rename familyType -> family_type (keep ENUM as defined by prior migration 016)
SET @family_type_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'families'
    AND column_name = 'family_type'
);

SET @sql := IF(@family_type_exists = 0 AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'families'
      AND column_name = 'familyType'
  ),
  'ALTER TABLE families CHANGE COLUMN familyType family_type ENUM(\'regular\', \'local_visitor\', \'traveller_visitor\') DEFAULT \'regular\'',
  'SELECT "family_type already renamed or familyType missing"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) Rename lastAttended -> last_attended
SET @last_attended_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'families'
    AND column_name = 'last_attended'
);

SET @sql := IF(@last_attended_exists = 0 AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'families'
      AND column_name = 'lastAttended'
  ),
  'ALTER TABLE families CHANGE COLUMN lastAttended last_attended DATE',
  'SELECT "last_attended already renamed or lastAttended missing"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4) Migrate notes from family_identifier into family_notes
-- Only when family_identifier exists and has a colon-delimited note
SET @identifier_exists = (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'families'
    AND column_name = 'family_identifier'
);

-- If family_identifier exists, migrate notes
SET @sql := IF(@identifier_exists > 0,
  'UPDATE families SET family_notes =
     CASE
       WHEN family_notes IS NOT NULL AND family_notes != \'\' THEN family_notes
       WHEN family_identifier LIKE \'%:%\' THEN SUBSTRING_INDEX(family_identifier, \'\:\', -1)
       ELSE family_notes
     END',
  'SELECT "family_identifier does not exist, skipping notes migration"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5) Drop indexes related to family_identifier and lastAttended, recreate for last_attended/family_type
-- Drop idx_identifier if exists
SET @drop_idx_identifier := IF(EXISTS (
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'families' AND index_name = 'idx_identifier'
), 'DROP INDEX idx_identifier ON families', 'SELECT "idx_identifier not found"');
PREPARE stmt FROM @drop_idx_identifier; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Drop old lastAttended index name variants if present
SET @drop_old_last_attended := IF(EXISTS (
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'families' AND index_name IN ('idx_families_last_attended','idx_last_attended')
), 'DROP INDEX idx_families_last_attended ON families', 'SELECT "old last_attended index not found or already handled"');
-- Try both possible names safely
SET @drop_idx1 := 'DROP INDEX idx_families_last_attended ON families';
SET @drop_idx2 := 'DROP INDEX idx_last_attended ON families';
-- Execute guarded drops
SET @has_idx1 = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'families' AND index_name = 'idx_families_last_attended');
SET @has_idx2 = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'families' AND index_name = 'idx_last_attended');
SET @sql := IF(@has_idx1 > 0, @drop_idx1, 'SELECT "idx_families_last_attended not found"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @sql := IF(@has_idx2 > 0, @drop_idx2, 'SELECT "idx_last_attended not found"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Create new indexes (idempotent style)
SET @create_idx_family_type := IF(NOT EXISTS (
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'families' AND index_name = 'idx_family_type'
), 'CREATE INDEX idx_family_type ON families (family_type)', 'SELECT "idx_family_type exists"');
PREPARE stmt FROM @create_idx_family_type; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @create_idx_last_attended := IF(NOT EXISTS (
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'families' AND index_name = 'idx_last_attended'
), 'CREATE INDEX idx_last_attended ON families (last_attended)', 'SELECT "idx_last_attended exists"');
PREPARE stmt FROM @create_idx_last_attended; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6) Finally, drop family_identifier column if it exists
SET @sql := IF(@identifier_exists > 0,
  'ALTER TABLE families DROP COLUMN family_identifier',
  'SELECT "family_identifier already dropped"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- End of migration 017


