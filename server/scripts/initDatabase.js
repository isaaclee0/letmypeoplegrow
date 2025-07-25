const Database = require('../config/database');

const createTables = async () => {
  console.log('🗄️  Initializing database schema...');

  try {
    // Users table
    await Database.query(`
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
      ) ENGINE=InnoDB
    `);

    // One-time codes table for authentication
    await Database.query(`
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
      ) ENGINE=InnoDB
    `);

    // User invitations table
    await Database.query(`
      CREATE TABLE IF NOT EXISTS user_invitations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255),
        mobile_number VARCHAR(20),
        primary_contact_method ENUM('email', 'sms') DEFAULT 'email',
        role ENUM('admin', 'coordinator', 'attendance_taker') NOT NULL,
        first_name VARCHAR(100),
        last_name VARCHAR(100),
        invited_by INT NOT NULL,
        invitation_token VARCHAR(255) UNIQUE NOT NULL,
        gathering_assignments JSON,
        expires_at TIMESTAMP NOT NULL,
        accepted BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_email (email),
        INDEX idx_mobile (mobile_number),
        INDEX idx_token (invitation_token),
        INDEX idx_expires (expires_at),
        INDEX idx_accepted (accepted),
        CONSTRAINT check_invitation_contact CHECK (
          (email IS NOT NULL AND email != '') OR 
          (mobile_number IS NOT NULL AND mobile_number != '')
        )
      ) ENGINE=InnoDB
    `);

    // Gathering types table
    await Database.query(`
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
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB
    `);

    // Families table
    await Database.query(`
      CREATE TABLE IF NOT EXISTS families (
        id INT AUTO_INCREMENT PRIMARY KEY,
        family_name VARCHAR(255) NOT NULL,
        family_identifier VARCHAR(100),
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_family_name (family_name),
        INDEX idx_identifier (family_identifier)
      ) ENGINE=InnoDB
    `);

    // Individuals table (regular attendees)
    await Database.query(`
      CREATE TABLE IF NOT EXISTS individuals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        family_id INT,
        is_active BOOLEAN DEFAULT true,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_name (last_name, first_name),
        INDEX idx_family (family_id),
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB
    `);

    // Gathering lists (which individuals belong to which gathering types)
    await Database.query(`
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
        INDEX idx_gathering_type (gathering_type_id),
        INDEX idx_individual (individual_id)
      ) ENGINE=InnoDB
    `);

    // Attendance sessions (specific dates/times when attendance was taken)
    await Database.query(`
      CREATE TABLE IF NOT EXISTS attendance_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        gathering_type_id INT NOT NULL,
        session_date DATE NOT NULL,
        recorded_by INT NOT NULL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
        FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE RESTRICT,
        UNIQUE KEY unique_session (gathering_type_id, session_date),
        INDEX idx_gathering_date (gathering_type_id, session_date),
        INDEX idx_date (session_date)
      ) ENGINE=InnoDB
    `);

    // Attendance records for regular individuals
    await Database.query(`
      CREATE TABLE IF NOT EXISTS attendance_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        individual_id INT NOT NULL,
        present BOOLEAN NOT NULL DEFAULT false,
        FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
        UNIQUE KEY unique_session_individual (session_id, individual_id),
        INDEX idx_session (session_id),
        INDEX idx_individual (individual_id),
        INDEX idx_present (present)
      ) ENGINE=InnoDB
    `);

    // Visitors table
    await Database.query(`
      CREATE TABLE IF NOT EXISTS visitors (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        visitor_type ENUM('potential_regular', 'temporary_other') NOT NULL,
        visitor_family_group VARCHAR(255),
        notes TEXT,
        FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
        INDEX idx_session (session_id),
        INDEX idx_type (visitor_type),
        INDEX idx_name (name),
        INDEX idx_family_group (visitor_family_group)
      ) ENGINE=InnoDB
    `);

    // User gathering assignments (which users can manage which gathering types)
    await Database.query(`
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
      ) ENGINE=InnoDB
    `);

    // Notification rules
    await Database.query(`
      CREATE TABLE IF NOT EXISTS notification_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        created_by INT NOT NULL,
        gathering_type_id INT,
        rule_name VARCHAR(255) NOT NULL,
        target_group ENUM('regular_attendees', 'potential_regular_visitors') NOT NULL,
        trigger_event ENUM('attends', 'misses') NOT NULL,
        threshold_count INT NOT NULL,
        timeframe_periods INT NOT NULL DEFAULT 1,
        is_active BOOLEAN DEFAULT true,
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
        INDEX idx_creator (created_by),
        INDEX idx_gathering (gathering_type_id),
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB
    `);

    // Notifications
    await Database.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        rule_id INT,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        notification_type ENUM('attendance_pattern', 'visitor_pattern', 'system') NOT NULL,
        is_read BOOLEAN DEFAULT false,
        email_sent BOOLEAN DEFAULT false,
        reference_type ENUM('individual', 'visitor', 'family') NULL,
        reference_id INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (rule_id) REFERENCES notification_rules(id) ON DELETE SET NULL,
        INDEX idx_user (user_id),
        INDEX idx_type (notification_type),
        INDEX idx_read (is_read),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB
    `);

    // Audit log for tracking important actions
    await Database.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        action VARCHAR(255) NOT NULL,
        table_name VARCHAR(100),
        record_id INT,
        old_values JSON,
        new_values JSON,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_user (user_id),
        INDEX idx_action (action),
        INDEX idx_created (created_at)
      ) ENGINE=InnoDB
    `);

    // Church settings and configuration
    await Database.query(`
      CREATE TABLE IF NOT EXISTS church_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        church_name VARCHAR(255) NOT NULL,
        country_code VARCHAR(2) DEFAULT 'AU',
        timezone VARCHAR(100) DEFAULT 'Australia/Sydney',
        default_gathering_duration INT DEFAULT 90,
        onboarding_completed BOOLEAN DEFAULT false,
        brevo_api_key VARCHAR(255),
        email_from_name VARCHAR(255) DEFAULT 'Let My People Grow',
        email_from_address VARCHAR(255) DEFAULT 'noreply@redeemercc.org.au',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    // Onboarding progress tracking
    await Database.query(`
      CREATE TABLE IF NOT EXISTS onboarding_progress (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        current_step VARCHAR(100) DEFAULT 'church_info',
        completed_steps JSON,
        church_info JSON,
        gatherings JSON,
        csv_upload JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_user (user_id),
        INDEX idx_current_step (current_step)
      ) ENGINE=InnoDB
    `);

    console.log('✅ Database schema created successfully!');

    // Create default admin user if it doesn't exist
    const existingAdmin = await Database.query(
      'SELECT id FROM users WHERE role = ? LIMIT 1',
      ['admin']
    );

    if (existingAdmin.length === 0) {
      await Database.query(`
        INSERT INTO users (email, role, first_name, last_name)
        VALUES (?, ?, ?, ?)
      `, ['admin@church.local', 'admin', 'System', 'Administrator']);
      console.log('✅ Default admin user created: admin@church.local');
    }

    console.log('🎉 Database initialization completed!');

  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
};

// Run initialization if called directly
if (require.main === module) {
  createTables().catch(console.error);
}

module.exports = { createTables }; 