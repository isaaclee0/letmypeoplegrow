-- Migration 004: Fix attendance duplicates
-- This migration adds a unique constraint to prevent duplicate attendance records
-- and cleans up existing duplicates

-- First, clean up existing duplicates by keeping only the most recent record for each session/individual
DELETE ar1 FROM attendance_records ar1
INNER JOIN attendance_records ar2 
WHERE ar1.id < ar2.id 
  AND ar1.session_id = ar2.session_id 
  AND ar1.individual_id = ar2.individual_id
  AND ar1.individual_id IS NOT NULL;

-- Add unique constraint to prevent future duplicates
ALTER TABLE attendance_records 
ADD UNIQUE KEY unique_session_individual (session_id, individual_id); 