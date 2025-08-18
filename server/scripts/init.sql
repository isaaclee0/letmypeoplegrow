-- Database initialization script for Docker
-- This will be run automatically when the MariaDB container starts

USE church_attendance;

-- Create migrations table first
CREATE TABLE IF NOT EXISTS migrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  version VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  execution_time_ms INT DEFAULT 0,
  status ENUM('pending', 'success', 'failed') DEFAULT 'pending',
  executed_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_version (version),
  INDEX idx_status (status)
) ENGINE=InnoDB;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  church_id VARCHAR(36) NOT NULL,
  email VARCHAR(255),
  mobile_number VARCHAR(20),
  primary_contact_method ENUM('email', 'sms') DEFAULT 'email',
  role ENUM('admin', 'coordinator', 'attendance_taker') NOT NULL DEFAULT 'attendance_taker',
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  is_active BOOLEAN DEFAULT true,
  is_invited BOOLEAN DEFAULT false,
  first_login_completed BOOLEAN DEFAULT false,
  default_gathering_id INT,
  email_notifications BOOLEAN DEFAULT true,
  sms_notifications BOOLEAN DEFAULT true,
  notification_frequency ENUM('instant', 'daily', 'weekly') DEFAULT 'instant',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL,
  UNIQUE KEY unique_email (email),
  UNIQUE KEY unique_mobile (mobile_number),
  INDEX idx_email (email),
  INDEX idx_mobile (mobile_number),
  INDEX idx_primary_contact (primary_contact_method),
  INDEX idx_role (role),
  INDEX idx_active (is_active),
  INDEX idx_default_gathering (default_gathering_id),
  INDEX idx_church_id (church_id),
  CONSTRAINT check_contact_info CHECK (
    (email IS NOT NULL AND email != '') OR 
    (mobile_number IS NOT NULL AND mobile_number != '')
  )
) ENGINE=InnoDB;

-- Create one-time codes table
CREATE TABLE IF NOT EXISTS otc_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contact_identifier VARCHAR(255) NOT NULL,
  contact_type ENUM('email', 'sms') NOT NULL,
  code VARCHAR(10) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_contact_code (contact_identifier, code),
  INDEX idx_contact_type (contact_type),
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB;

-- Create church settings table
CREATE TABLE IF NOT EXISTS church_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  church_name VARCHAR(255) NOT NULL,
  country_code VARCHAR(2) NOT NULL DEFAULT 'AU',
  timezone VARCHAR(50) DEFAULT 'Australia/Sydney',
  email_from_name VARCHAR(255) DEFAULT 'Let My People Grow',
  email_from_address VARCHAR(255) DEFAULT 'noreply@redeemercc.org.au',
  onboarding_completed BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Create gathering types table
CREATE TABLE IF NOT EXISTS gathering_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  day_of_week ENUM('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'),
  start_time TIME,
  frequency ENUM('weekly', 'biweekly', 'monthly') DEFAULT 'weekly',
  group_by_family BOOLEAN DEFAULT true,
  is_active BOOLEAN DEFAULT true,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_name (name),
  INDEX idx_active (is_active),
  INDEX idx_day_of_week (day_of_week)
) ENGINE=InnoDB;

-- Create user gathering assignments table
CREATE TABLE IF NOT EXISTS user_gathering_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  gathering_type_id INT NOT NULL,
  assigned_by INT,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY unique_user_gathering (user_id, gathering_type_id),
  INDEX idx_user (user_id),
  INDEX idx_gathering (gathering_type_id),
  INDEX idx_church_id (church_id)
) ENGINE=InnoDB;

-- Create families table
CREATE TABLE IF NOT EXISTS families (
  id INT AUTO_INCREMENT PRIMARY KEY,
  family_name VARCHAR(255) NOT NULL,
  family_identifier VARCHAR(255),
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_family_name (family_name),
  INDEX idx_identifier (family_identifier)
) ENGINE=InnoDB;

-- Create individuals table
CREATE TABLE IF NOT EXISTS individuals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  family_id INT,
  date_of_birth DATE,
  is_regular_attendee BOOLEAN DEFAULT true,
  is_visitor BOOLEAN DEFAULT false,
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_name (last_name, first_name),
  INDEX idx_family (family_id),
  INDEX idx_active (is_active),
  INDEX idx_regular (is_regular_attendee),
  INDEX idx_is_visitor (is_visitor)
) ENGINE=InnoDB;

-- Create gathering lists table
CREATE TABLE IF NOT EXISTS gathering_lists (
  id INT AUTO_INCREMENT PRIMARY KEY,
  gathering_type_id INT NOT NULL,
  individual_id INT NOT NULL,
  added_by INT,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY unique_gathering_individual (gathering_type_id, individual_id),
  INDEX idx_gathering (gathering_type_id),
  INDEX idx_individual (individual_id)
) ENGINE=InnoDB;

-- Create attendance sessions table
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  gathering_type_id INT NOT NULL,
  session_date DATE NOT NULL,
  created_by INT NOT NULL,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_session_with_church (gathering_type_id, session_date, church_id),
  INDEX idx_gathering_date (gathering_type_id, session_date),
  INDEX idx_date (session_date),
  INDEX idx_church_id (church_id)
) ENGINE=InnoDB;

-- Create attendance records table
CREATE TABLE IF NOT EXISTS attendance_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  individual_id INT NOT NULL,
  present BOOLEAN DEFAULT false,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
  UNIQUE KEY unique_session_individual (session_id, individual_id),
  INDEX idx_session (session_id),
  INDEX idx_individual (individual_id),
  INDEX idx_present (present),
  INDEX idx_church_id (church_id)
) ENGINE=InnoDB;

-- Create user invitations table
CREATE TABLE IF NOT EXISTS user_invitations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255),
  mobile_number VARCHAR(20),
  primary_contact_method ENUM('email', 'sms') DEFAULT 'email',
  role ENUM('admin', 'coordinator', 'attendance_taker') NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  invited_by INT NOT NULL,
  invitation_token VARCHAR(255) NOT NULL,
  gathering_assignments JSON,
  expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  accepted BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY unique_token (invitation_token),
  INDEX idx_token (invitation_token),
  INDEX idx_email (email),
  INDEX idx_mobile (mobile_number),
  INDEX idx_expires (expires_at),
  INDEX idx_church_id (church_id)
) ENGINE=InnoDB;

-- Create notification rules table
CREATE TABLE IF NOT EXISTS notification_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  rule_type ENUM('attendance_threshold', 'absence_alert', 'custom') NOT NULL,
  conditions JSON,
  actions JSON,
  is_active BOOLEAN DEFAULT true,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_name (name),
  INDEX idx_type (rule_type),
  INDEX idx_active (is_active)
) ENGINE=InnoDB;

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type ENUM('info', 'warning', 'error', 'success') DEFAULT 'info',
  is_read BOOLEAN DEFAULT false,
  read_at TIMESTAMP NULL,
  data JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user (user_id),
  INDEX idx_read (is_read),
  INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- Create audit log table
CREATE TABLE IF NOT EXISTS audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  action VARCHAR(255) NOT NULL,
  entity_type VARCHAR(50),
  entity_id INT,
  table_name VARCHAR(100),
  record_id INT,
  old_values JSON,
  new_values JSON,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  church_id VARCHAR(36) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_user (user_id),
  INDEX idx_action (action),
  INDEX idx_entity (entity_type, entity_id),
  INDEX idx_table_record (table_name, record_id),
  INDEX idx_created (created_at),
  INDEX idx_church_id (church_id)
) ENGINE=InnoDB;

-- Create onboarding progress table
CREATE TABLE IF NOT EXISTS onboarding_progress (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  current_step INT DEFAULT 1,
  church_info JSON,
  gatherings JSON,
  csv_upload JSON,
  completed_steps JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_user_progress (user_id),
  INDEX idx_user (user_id),
  INDEX idx_step (current_step)
) ENGINE=InnoDB;

-- ========================================
-- DEVELOPMENT DATA INITIALIZATION
-- ========================================

-- Create development users with different roles
INSERT IGNORE INTO users (id, church_id, email, role, first_name, last_name, is_active, first_login_completed) VALUES
(1, 'dev_church_001', 'admin@church.local', 'admin', 'Development', 'Admin', true, true),
(2, 'dev_church_001', 'dev@church.local', 'admin', 'Development', 'User', true, true),
(3, 'dev_church_001', 'coord@church.local', 'coordinator', 'Development', 'Coordinator', true, true),
(4, 'dev_church_001', 'at@church.local', 'attendance_taker', 'Development', 'Attendance Taker', true, true);

-- Create church settings
INSERT IGNORE INTO church_settings (id, church_name, country_code, timezone, email_from_name, email_from_address, onboarding_completed) VALUES
(1, 'Development Church', 'AU', 'Australia/Sydney', 'Development Church', 'dev@church.local', true);

-- Create gathering types
INSERT IGNORE INTO gathering_types (id, name, description, day_of_week, start_time, frequency, group_by_family, is_active, created_by) VALUES
  (1, 'Sunday Morning Service', 'Main worship service on Sunday mornings at 10:00 AM', 'Sunday', '10:00:00', 'weekly', true, true, 1),
  (2, 'Youth Group', 'Youth ministry meeting on Friday evenings', 'Friday', '19:00:00', 'weekly', false, true, 1);

-- Assign all users to all gathering types
INSERT IGNORE INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by, church_id) VALUES
(1, 1, 1, 'dev_church_001'), (1, 2, 1, 'dev_church_001'),  -- Admin
(2, 1, 1, 'dev_church_001'), (2, 2, 1, 'dev_church_001'),  -- Dev user
(3, 1, 1, 'dev_church_001'), (3, 2, 1, 'dev_church_001'),  -- Coordinator
(4, 1, 1, 'dev_church_001'), (4, 2, 1, 'dev_church_001');  -- Attendance Taker

-- Create development families
INSERT IGNORE INTO families (id, family_name, family_identifier, created_by) VALUES
(1, 'Smith Family', 'SMITH001', 1),
(2, 'Johnson Family', 'JOHNSON001', 1),
(3, 'Williams Family', 'WILLIAMS001', 1);

-- Create development individuals
INSERT IGNORE INTO individuals (id, first_name, last_name, family_id, date_of_birth, is_regular_attendee, is_active, created_by) VALUES
(1, 'John', 'Smith', 1, '1980-05-15', true, true, 1),
(2, 'Sarah', 'Smith', 1, '1982-08-22', true, true, 1),
(3, 'Emma', 'Smith', 1, '2010-03-10', true, true, 1),
(4, 'Michael', 'Johnson', 2, '1975-12-03', true, true, 1),
(5, 'Lisa', 'Johnson', 2, '1978-07-18', true, true, 1),
(6, 'David', 'Williams', 3, '1985-01-25', true, true, 1),
(7, 'Jennifer', 'Williams', 3, '1987-11-08', true, true, 1),
(8, 'Sophie', 'Williams', 3, '2012-09-14', true, true, 1);

-- Add all individuals to Sunday Morning Service gathering list
INSERT IGNORE INTO gathering_lists (gathering_type_id, individual_id, added_by) VALUES
(1, 1, 1), (1, 2, 1), (1, 3, 1),  -- Smith Family
(1, 4, 1), (1, 5, 1),              -- Johnson Family  
(1, 6, 1), (1, 7, 1), (1, 8, 1);  -- Williams Family

-- Mark all migrations as completed to prevent them from appearing as pending
-- These migrations are already included in the init.sql schema above
INSERT IGNORE INTO migrations (version, name, description, execution_time_ms, status, executed_at) VALUES
('001', 'fix_audit_log', 'Baseline migration - included in init.sql schema', 0, 'success', NOW()),
('002', 'add_contact_fields', 'Baseline migration - included in init.sql schema', 0, 'success', NOW()),
('003', 'enhance_visitors_table', 'Baseline migration - included in init.sql schema', 0, 'success', NOW()),
('004', 'fix_attendance_duplicates', 'Baseline migration - included in init.sql schema', 0, 'success', NOW()),
('005', 'add_attendance_updated_at', 'Baseline migration - included in init.sql schema', 0, 'success', NOW()); 