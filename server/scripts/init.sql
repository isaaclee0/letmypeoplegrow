-- Database initialization script for Docker
-- This will be run automatically when the MariaDB container starts

USE church_attendance;

-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
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
  UNIQUE KEY unique_email (email),
  UNIQUE KEY unique_mobile (mobile_number),
  INDEX idx_email (email),
  INDEX idx_mobile (mobile_number),
  INDEX idx_primary_contact (primary_contact_method),
  INDEX idx_role (role),
  INDEX idx_active (is_active),
  INDEX idx_default_gathering (default_gathering_id),
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
  duration_minutes INT DEFAULT 90,
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
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY unique_user_gathering (user_id, gathering_type_id),
  INDEX idx_user (user_id),
  INDEX idx_gathering (gathering_type_id)
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
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_name (first_name, last_name),
  INDEX idx_family (family_id),
  INDEX idx_regular (is_regular_attendee),
  INDEX idx_active (is_active)
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY unique_session (gathering_type_id, session_date),
  INDEX idx_gathering_date (gathering_type_id, session_date),
  INDEX idx_date (session_date)
) ENGINE=InnoDB;

-- Create attendance records table
CREATE TABLE IF NOT EXISTS attendance_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  individual_id INT,
  visitor_name VARCHAR(255),
  visitor_type ENUM('potential_regular', 'temporary_other') DEFAULT 'temporary_other',
  visitor_family_group VARCHAR(255),
  notes TEXT,
  present BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
  INDEX idx_session (session_id),
  INDEX idx_individual (individual_id),
  INDEX idx_present (present),
  CONSTRAINT check_attendee CHECK (
    (individual_id IS NOT NULL) OR 
    (visitor_name IS NOT NULL AND visitor_name != '')
  )
) ENGINE=InnoDB;

-- Create visitors table
CREATE TABLE IF NOT EXISTS visitors (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  visitor_type ENUM('potential_regular', 'temporary_other') DEFAULT 'temporary_other',
  visitor_family_group VARCHAR(255),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_name (name),
  INDEX idx_type (visitor_type)
) ENGINE=InnoDB;

-- Create user invitations table
CREATE TABLE IF NOT EXISTS user_invitations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255),
  mobile_number VARCHAR(20),
  primary_contact_method ENUM('email', 'sms') NOT NULL,
  role ENUM('coordinator', 'attendance_taker') NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  invitation_token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  accepted BOOLEAN DEFAULT false,
  accepted_at TIMESTAMP NULL,
  invited_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_token (invitation_token),
  INDEX idx_email (email),
  INDEX idx_mobile (mobile_number),
  INDEX idx_expires (expires_at),
  INDEX idx_accepted (accepted)
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
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id INT,
  old_values JSON,
  new_values JSON,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_user (user_id),
  INDEX idx_action (action),
  INDEX idx_entity (entity_type, entity_id),
  INDEX idx_created (created_at)
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

-- Create default admin user
INSERT IGNORE INTO users (email, role, first_name, last_name, is_active, first_login_completed) 
VALUES ('admin@church.local', 'admin', 'System', 'Administrator', true, true);

-- No default gathering types - users will create their own during onboarding 