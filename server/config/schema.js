const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS churches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL UNIQUE,
  church_name TEXT NOT NULL,
  is_approved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_lookup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  email TEXT,
  mobile_number TEXT,
  church_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_lookup_email ON user_lookup(email);
CREATE INDEX IF NOT EXISTS idx_user_lookup_mobile ON user_lookup(mobile_number);
CREATE INDEX IF NOT EXISTS idx_user_lookup_church ON user_lookup(church_id);
`;

const CHURCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  executed_at TEXT DEFAULT (datetime('now')),
  execution_time_ms INTEGER DEFAULT 0,
  status TEXT DEFAULT 'success' CHECK(status IN ('pending', 'success', 'failed')),
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_migrations_version ON migrations(version);
CREATE INDEX IF NOT EXISTS idx_migrations_status ON migrations(status);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  email TEXT,
  mobile_number TEXT,
  primary_contact_method TEXT DEFAULT 'email' CHECK(primary_contact_method IN ('email', 'sms')),
  role TEXT NOT NULL DEFAULT 'attendance_taker' CHECK(role IN ('admin', 'coordinator', 'attendance_taker')),
  first_name TEXT,
  last_name TEXT,
  is_active INTEGER DEFAULT 1,
  is_invited INTEGER DEFAULT 0,
  first_login_completed INTEGER DEFAULT 0,
  default_gathering_id INTEGER,
  email_notifications INTEGER DEFAULT 1,
  sms_notifications INTEGER DEFAULT 1,
  notification_frequency TEXT DEFAULT 'instant' CHECK(notification_frequency IN ('instant', 'daily', 'weekly')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_login_at TEXT,
  UNIQUE(email),
  UNIQUE(mobile_number)
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile_number);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_church ON users(church_id);

CREATE TABLE IF NOT EXISTS otc_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_identifier TEXT NOT NULL,
  contact_type TEXT NOT NULL CHECK(contact_type IN ('email', 'sms')),
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  church_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otc_contact_code ON otc_codes(contact_identifier, code);
CREATE INDEX IF NOT EXISTS idx_otc_expires ON otc_codes(expires_at);

CREATE TABLE IF NOT EXISTS church_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT,
  church_name TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'AU',
  timezone TEXT DEFAULT 'Australia/Sydney',
  default_gathering_duration INTEGER DEFAULT 90,
  email_from_name TEXT DEFAULT 'Let My People Grow',
  email_from_address TEXT DEFAULT 'noreply@letmypeoplegrow.com.au',
  brevo_api_key TEXT,
  onboarding_completed INTEGER DEFAULT 0,
  has_sample_data INTEGER DEFAULT 0,
  default_badge_text TEXT,
  default_child_badge_text TEXT,
  default_child_badge_color TEXT,
  default_child_badge_icon TEXT,
  child_flair_color TEXT,
  default_adult_badge_text TEXT,
  default_adult_badge_color TEXT,
  default_adult_badge_icon TEXT,
  location_name TEXT,
  location_lat REAL,
  location_lng REAL,
  weekly_review_email_enabled INTEGER DEFAULT 1,
  weekly_review_email_day TEXT DEFAULT NULL,
  weekly_review_email_include_insight INTEGER DEFAULT 1,
  weekly_review_email_last_sent TEXT,
  caregiver_absence_threshold INTEGER DEFAULT 3,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gathering_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  day_of_week TEXT CHECK(day_of_week IN ('Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday')),
  start_time TEXT,
  end_time TEXT,
  duration_minutes INTEGER DEFAULT 90,
  frequency TEXT DEFAULT 'weekly' CHECK(frequency IN ('weekly', 'biweekly', 'monthly')),
  attendance_type TEXT DEFAULT 'standard' CHECK(attendance_type IN ('standard', 'headcount')),
  custom_schedule TEXT,
  kiosk_enabled INTEGER DEFAULT 0,
  leader_checkin_enabled INTEGER DEFAULT 0,
  kiosk_message TEXT,
  kiosk_end_time TEXT,
  group_by_family INTEGER DEFAULT 1,
  individual_mode INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_by INTEGER,
  church_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_gatherings_name ON gathering_types(name);
CREATE INDEX IF NOT EXISTS idx_gatherings_active ON gathering_types(is_active);
CREATE INDEX IF NOT EXISTS idx_gatherings_day ON gathering_types(day_of_week);
CREATE INDEX IF NOT EXISTS idx_gatherings_type ON gathering_types(attendance_type);
CREATE INDEX IF NOT EXISTS idx_gatherings_church ON gathering_types(church_id);

CREATE TABLE IF NOT EXISTS user_gathering_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  gathering_type_id INTEGER NOT NULL,
  assigned_by INTEGER,
  assigned_at TEXT DEFAULT (datetime('now')),
  church_id TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(user_id, gathering_type_id)
);
CREATE INDEX IF NOT EXISTS idx_uga_user ON user_gathering_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_uga_gathering ON user_gathering_assignments(gathering_type_id);
CREATE INDEX IF NOT EXISTS idx_uga_church ON user_gathering_assignments(church_id);

CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_name TEXT NOT NULL,
  family_notes TEXT,
  family_identifier TEXT,
  family_type TEXT DEFAULT 'regular',
  last_attended TEXT,
  created_by INTEGER,
  church_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_families_name ON families(family_name);
CREATE INDEX IF NOT EXISTS idx_families_church ON families(church_id);

CREATE TABLE IF NOT EXISTS individuals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  people_type TEXT DEFAULT 'regular' CHECK(people_type IN ('regular', 'local_visitor', 'traveller_visitor')),
  last_attendance_date TEXT,
  family_id INTEGER,
  is_child INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  is_visitor INTEGER DEFAULT 0,
  created_by INTEGER,
  church_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  badge_text TEXT,
  badge_color TEXT,
  badge_icon TEXT,
  FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_individuals_name ON individuals(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_individuals_family ON individuals(family_id);
CREATE INDEX IF NOT EXISTS idx_individuals_active ON individuals(is_active);
CREATE INDEX IF NOT EXISTS idx_individuals_church ON individuals(church_id);

CREATE TABLE IF NOT EXISTS gathering_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gathering_type_id INTEGER NOT NULL,
  individual_id INTEGER NOT NULL,
  added_by INTEGER,
  church_id TEXT,
  added_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
  FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(gathering_type_id, individual_id)
);
CREATE INDEX IF NOT EXISTS idx_gl_gathering ON gathering_lists(gathering_type_id);
CREATE INDEX IF NOT EXISTS idx_gl_individual ON gathering_lists(individual_id);

CREATE TABLE IF NOT EXISTS attendance_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gathering_type_id INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  notes TEXT,
  headcount_mode TEXT DEFAULT 'separate',
  roster_snapshotted INTEGER DEFAULT 0,
  excluded_from_stats INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  church_id TEXT NOT NULL,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(gathering_type_id, session_date, church_id)
);
CREATE INDEX IF NOT EXISTS idx_as_gathering_date ON attendance_sessions(gathering_type_id, session_date);
CREATE INDEX IF NOT EXISTS idx_as_date ON attendance_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_as_church ON attendance_sessions(church_id);

CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  individual_id INTEGER NOT NULL,
  present INTEGER DEFAULT 0,
  people_type_at_time TEXT CHECK(people_type_at_time IN ('regular', 'local_visitor', 'traveller_visitor')),
  updated_at TEXT DEFAULT (datetime('now')),
  church_id TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
  UNIQUE(session_id, individual_id)
);
CREATE INDEX IF NOT EXISTS idx_ar_session ON attendance_records(session_id);
CREATE INDEX IF NOT EXISTS idx_ar_individual ON attendance_records(individual_id);
CREATE INDEX IF NOT EXISTS idx_ar_present ON attendance_records(present);
CREATE INDEX IF NOT EXISTS idx_ar_church ON attendance_records(church_id);

CREATE TABLE IF NOT EXISTS headcount_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  headcount INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  church_id TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(session_id, updated_by)
);
CREATE INDEX IF NOT EXISTS idx_hr_church ON headcount_records(church_id);
CREATE INDEX IF NOT EXISTS idx_hr_session ON headcount_records(session_id);

CREATE TABLE IF NOT EXISTS user_invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  mobile_number TEXT,
  primary_contact_method TEXT DEFAULT 'email' CHECK(primary_contact_method IN ('email', 'sms')),
  role TEXT NOT NULL CHECK(role IN ('admin', 'coordinator', 'attendance_taker')),
  first_name TEXT,
  last_name TEXT,
  invited_by INTEGER,
  invitation_token TEXT NOT NULL UNIQUE,
  gathering_assignments TEXT,
  expires_at TEXT,
  accepted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  church_id TEXT NOT NULL,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_token ON user_invitations(invitation_token);
CREATE INDEX IF NOT EXISTS idx_inv_email ON user_invitations(email);
CREATE INDEX IF NOT EXISTS idx_inv_church ON user_invitations(church_id);

CREATE TABLE IF NOT EXISTS notification_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_by INTEGER NOT NULL,
  gathering_type_id INTEGER,
  rule_name TEXT NOT NULL,
  target_group TEXT NOT NULL CHECK(target_group IN ('regular_attendees', 'potential_regular_visitors')),
  trigger_event TEXT NOT NULL CHECK(trigger_event IN ('attends', 'misses')),
  threshold_count INTEGER NOT NULL,
  timeframe_periods INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER DEFAULT 1,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  church_id TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  rule_id INTEGER,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  notification_type TEXT NOT NULL CHECK(notification_type IN ('attendance_pattern', 'visitor_pattern', 'system')),
  is_read INTEGER DEFAULT 0,
  email_sent INTEGER DEFAULT 0,
  reference_type TEXT CHECK(reference_type IN ('individual', 'visitor', 'family')),
  reference_id INTEGER,
  church_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (rule_id) REFERENCES notification_rules(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(is_read);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  table_name TEXT,
  record_id INTEGER,
  old_values TEXT,
  new_values TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  church_id TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_church ON audit_log(church_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS ai_chat_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  church_id TEXT NOT NULL,
  title TEXT DEFAULT 'New Chat',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aicc_user_church ON ai_chat_conversations(user_id, church_id);
CREATE INDEX IF NOT EXISTS idx_aicc_church ON ai_chat_conversations(church_id);

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES ai_chat_conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_aicm_conversation ON ai_chat_messages(conversation_id);

CREATE TABLE IF NOT EXISTS kiosk_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gathering_type_id INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  individual_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('checkin', 'checkout')),
  signer_name TEXT,
  user_id INTEGER,
  church_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_kiosk_gathering_date ON kiosk_checkins(gathering_type_id, session_date);
CREATE INDEX IF NOT EXISTS idx_kiosk_individual ON kiosk_checkins(individual_id);
CREATE INDEX IF NOT EXISTS idx_kiosk_church ON kiosk_checkins(church_id);

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  current_step INTEGER DEFAULT 1,
  church_info TEXT,
  gatherings TEXT,
  csv_upload TEXT,
  completed_steps TEXT,
  church_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_onboard_user ON onboarding_progress(user_id);

CREATE TABLE IF NOT EXISTS visitor_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL UNIQUE,
  local_visitor_service_limit INTEGER DEFAULT 4,
  traveller_visitor_service_limit INTEGER DEFAULT 2,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  preference_key TEXT NOT NULL,
  preference_value TEXT,
  church_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, preference_key)
);
CREATE INDEX IF NOT EXISTS idx_uprefs_user ON user_preferences(user_id);
CREATE TABLE IF NOT EXISTS absence_dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  individual_id INTEGER NOT NULL,
  gathering_type_id INTEGER NOT NULL,
  dismissed_at_streak INTEGER NOT NULL,
  dismissed_by INTEGER,
  church_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (individual_id) REFERENCES individuals(id) ON DELETE CASCADE,
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE,
  FOREIGN KEY (dismissed_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(individual_id, gathering_type_id)
);
CREATE INDEX IF NOT EXISTS idx_absence_dismissals_individual ON absence_dismissals(individual_id, gathering_type_id);
CREATE INDEX IF NOT EXISTS idx_absence_dismissals_church ON absence_dismissals(church_id);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  mobile_number TEXT,
  primary_contact_method TEXT CHECK(primary_contact_method IN ('email', 'sms')) DEFAULT 'email',
  notes TEXT,
  is_active INTEGER DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_church ON contacts(church_id);
CREATE INDEX IF NOT EXISTS idx_contacts_active ON contacts(is_active);

CREATE TABLE IF NOT EXISTS family_caregivers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  caregiver_type TEXT NOT NULL CHECK(caregiver_type IN ('user', 'contact')),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  CHECK(
    (caregiver_type = 'user' AND user_id IS NOT NULL AND contact_id IS NULL) OR
    (caregiver_type = 'contact' AND contact_id IS NOT NULL AND user_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fc_user ON family_caregivers(family_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fc_contact ON family_caregivers(family_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fc_family ON family_caregivers(family_id);
CREATE INDEX IF NOT EXISTS idx_fc_church ON family_caregivers(church_id);

CREATE TABLE IF NOT EXISTS contact_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  family_id INTEGER REFERENCES families(id),
  individual_id INTEGER REFERENCES individuals(id),
  rule_id INTEGER REFERENCES notification_rules(id),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  email_sent INTEGER DEFAULT 0,
  sms_sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cn_contact ON contact_notifications(contact_id);
CREATE INDEX IF NOT EXISTS idx_cn_church ON contact_notifications(church_id);
`;

const UPDATED_AT_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS users_updated_at AFTER UPDATE ON users
BEGIN UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS church_settings_updated_at AFTER UPDATE ON church_settings
BEGIN UPDATE church_settings SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS gathering_types_updated_at AFTER UPDATE ON gathering_types
BEGIN UPDATE gathering_types SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS families_updated_at AFTER UPDATE ON families
BEGIN UPDATE families SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS individuals_updated_at AFTER UPDATE ON individuals
BEGIN UPDATE individuals SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS attendance_sessions_updated_at AFTER UPDATE ON attendance_sessions
BEGIN UPDATE attendance_sessions SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS attendance_records_updated_at AFTER UPDATE ON attendance_records
BEGIN UPDATE attendance_records SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS headcount_records_updated_at AFTER UPDATE ON headcount_records
BEGIN UPDATE headcount_records SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS notification_rules_updated_at AFTER UPDATE ON notification_rules
BEGIN UPDATE notification_rules SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS onboarding_progress_updated_at AFTER UPDATE ON onboarding_progress
BEGIN UPDATE onboarding_progress SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS visitor_config_updated_at AFTER UPDATE ON visitor_config
BEGIN UPDATE visitor_config SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS user_preferences_updated_at AFTER UPDATE ON user_preferences
BEGIN UPDATE user_preferences SET updated_at = datetime('now') WHERE id = NEW.id; END;

CREATE TRIGGER IF NOT EXISTS contacts_updated_at AFTER UPDATE ON contacts
BEGIN UPDATE contacts SET updated_at = datetime('now') WHERE id = NEW.id; END;
`;

module.exports = { REGISTRY_SCHEMA, CHURCH_SCHEMA, UPDATED_AT_TRIGGERS };
