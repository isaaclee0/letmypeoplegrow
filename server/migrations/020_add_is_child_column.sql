-- Migration 020: Add is_child column to individuals table
-- Allows optional distinction between adult and child members.
-- Default is false (adult). This is an optional feature.
--
-- This migration is SAFE and NON-DESTRUCTIVE:
-- - Only adds a new column (does not modify existing data)
-- - Uses a procedure with IF NOT EXISTS logic to prevent errors if already applied
-- - Existing records default to false (adult)

DELIMITER //

CREATE PROCEDURE add_is_child_column()
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 'individuals' AND COLUMN_NAME = 'is_child'
    ) THEN
        ALTER TABLE individuals ADD COLUMN is_child BOOLEAN DEFAULT false AFTER family_id;
    END IF;
END //

DELIMITER ;

CALL add_is_child_column();
DROP PROCEDURE IF EXISTS add_is_child_column;
