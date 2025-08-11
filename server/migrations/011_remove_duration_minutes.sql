-- Migration 011: Remove duration_minutes column from gathering_types table
-- Since we're no longer using duration in the UI, we can remove this column entirely

ALTER TABLE gathering_types DROP COLUMN duration_minutes; 