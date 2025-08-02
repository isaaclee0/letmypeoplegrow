-- Migration 008: Remove API keys tables
-- This migration removes the API key management tables since we're using simple data access control instead

-- Drop API access logs table first (due to foreign key constraint)
DROP TABLE IF EXISTS api_access_logs;

-- Drop API keys table
DROP TABLE IF EXISTS api_keys; 