-- Add default badge icon settings for children and adults

-- Add default child badge icon column
ALTER TABLE church_settings
ADD COLUMN default_child_badge_icon VARCHAR(50) DEFAULT 'person' AFTER default_badge_text;

-- Add default adult badge columns (all optional, default to NULL for no badge)
ALTER TABLE church_settings
ADD COLUMN default_adult_badge_text VARCHAR(50) NULL AFTER default_child_badge_icon;

ALTER TABLE church_settings
ADD COLUMN default_adult_badge_color VARCHAR(7) NULL AFTER default_adult_badge_text;

ALTER TABLE church_settings
ADD COLUMN default_adult_badge_icon VARCHAR(50) NULL AFTER default_adult_badge_color;
