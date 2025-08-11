-- Migration 020: Add church_id to all tables for proper data isolation
-- This migration ensures every table has church_id to prevent cross-church data contamination

USE church_attendance;

-- ============================================================================
-- PART 1: ADD CHURCH_ID TO MISSING TABLES
-- ============================================================================

-- 1) Add church_id to attendance_records
ALTER TABLE attendance_records ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;
CREATE INDEX idx_attendance_records_church_id ON attendance_records (church_id);

-- 2) Add church_id to gathering_lists
ALTER TABLE gathering_lists ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;
CREATE INDEX idx_gathering_lists_church_id ON gathering_lists (church_id);

-- 3) Add church_id to notifications
ALTER TABLE notifications ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;
CREATE INDEX idx_notifications_church_id ON notifications (church_id);

-- 4) Add church_id to notification_rules
ALTER TABLE notification_rules ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;
CREATE INDEX idx_notification_rules_church_id ON notification_rules (church_id);

-- 5) Add church_id to onboarding_progress
ALTER TABLE onboarding_progress ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;
CREATE INDEX idx_onboarding_progress_church_id ON onboarding_progress (church_id);

-- 6) Add church_id to otc_codes
ALTER TABLE otc_codes ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;
CREATE INDEX idx_otc_codes_church_id ON otc_codes (church_id);

-- 7) Add church_id to user_gathering_assignments
ALTER TABLE user_gathering_assignments ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;
CREATE INDEX idx_user_gathering_assignments_church_id ON user_gathering_assignments (church_id);

-- 8) Add church_id to user_invitations
ALTER TABLE user_invitations ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT (UUID()) AFTER id;
CREATE INDEX idx_user_invitations_church_id ON user_invitations (church_id);

-- ============================================================================
-- PART 2: MIGRATE EXISTING DATA TO CORRECT CHURCH_ID
-- ============================================================================

-- Update attendance_records with church_id from related families
UPDATE attendance_records ar
JOIN families f ON ar.family_id = f.id
SET ar.church_id = f.church_id
WHERE ar.church_id = UUID();

-- Update gathering_lists with church_id from related gathering_types
UPDATE gathering_lists gl
JOIN gathering_types gt ON gl.gathering_type_id = gt.id
SET gl.church_id = gt.church_id
WHERE gl.church_id = UUID();

-- Update notifications with church_id from related users
UPDATE notifications n
JOIN users u ON n.user_id = u.id
SET n.church_id = u.church_id
WHERE n.church_id = UUID();

-- Update notification_rules with church_id from related users
UPDATE notification_rules nr
JOIN users u ON nr.created_by = u.id
SET nr.church_id = u.church_id
WHERE nr.church_id = UUID();

-- Update onboarding_progress with church_id from related users
UPDATE onboarding_progress op
JOIN users u ON op.user_id = u.id
SET op.church_id = u.church_id
WHERE op.church_id = UUID();

-- Update otc_codes with church_id from related users
UPDATE otc_codes otc
JOIN users u ON otc.user_id = u.id
SET otc.church_id = u.church_id
WHERE otc.church_id = UUID();

-- Update user_gathering_assignments with church_id from related users
UPDATE user_gathering_assignments uga
JOIN users u ON uga.user_id = u.id
SET uga.church_id = u.church_id
WHERE uga.church_id = UUID();

-- Update user_invitations with church_id from related users
UPDATE user_invitations ui
JOIN users u ON ui.created_by = u.id
SET ui.church_id = u.church_id
WHERE ui.church_id = UUID();

-- ============================================================================
-- PART 3: REMOVE DEFAULT UUID() AND MAKE CHURCH_ID REQUIRED
-- ============================================================================

-- Remove default UUID() from all newly added church_id columns
ALTER TABLE attendance_records ALTER COLUMN church_id DROP DEFAULT;
ALTER TABLE gathering_lists ALTER COLUMN church_id DROP DEFAULT;
ALTER TABLE notifications ALTER COLUMN church_id DROP DEFAULT;
ALTER TABLE notification_rules ALTER COLUMN church_id DROP DEFAULT;
ALTER TABLE onboarding_progress ALTER COLUMN church_id DROP DEFAULT;
ALTER TABLE otc_codes ALTER COLUMN church_id DROP DEFAULT;
ALTER TABLE user_gathering_assignments ALTER COLUMN church_id DROP DEFAULT;
ALTER TABLE user_invitations ALTER COLUMN church_id DROP DEFAULT;

-- ============================================================================
-- PART 4: VERIFICATION
-- ============================================================================

-- Verify all tables now have church_id
-- SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
-- WHERE TABLE_SCHEMA = 'church_attendance' AND COLUMN_NAME = 'church_id' 
-- ORDER BY TABLE_NAME;

-- End migration 020
