-- Add badge_icon column to individuals table
-- This allows users to select different icons for badges

ALTER TABLE individuals
ADD COLUMN badge_icon VARCHAR(50) NULL AFTER badge_color;

-- Default icon for existing children with badges could be 'leaf'
-- But we'll leave it NULL and let the frontend handle defaults
