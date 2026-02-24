-- Add user_id column to kiosk_checkins to track which authenticated user performed the action
ALTER TABLE kiosk_checkins
ADD COLUMN user_id INT DEFAULT NULL AFTER signer_name,
ADD INDEX idx_user_id (user_id);
