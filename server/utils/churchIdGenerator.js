const Database = require('../config/database');
const crypto = require('crypto');

/**
 * Generate a secure church ID based on the church name
 * This creates a hash-based ID that's not easily guessable
 * Examples:
 * - "Development Church" -> "dev_abc123def456"
 * - "Redeemer Christian Church" -> "red_xyz789ghi012"
 */
const generateSecureChurchId = async (churchName) => {
  try {
    // Create a base identifier from church name (first 3 letters)
    const baseId = churchName.toLowerCase()
      .replace(/[^a-z0-9]/g, '') // Remove all non-alphanumeric characters
      .substring(0, 3); // Use only first 3 characters
    
    // Generate a random suffix for security
    const randomSuffix = crypto.randomBytes(6).toString('hex'); // 12 character hex string
    
    const secureId = `${baseId}_${randomSuffix}`;
    
    // Check if this ID already exists
    const existing = await Database.query(
      'SELECT 1 FROM church_settings WHERE church_id = ?',
      [secureId]
    );
    
    if (existing.length > 0) {
      // If collision, generate a new one (very unlikely but possible)
      return generateSecureChurchId(churchName);
    }
    
    return secureId;
  } catch (error) {
    console.error('Error generating secure church ID:', error);
    throw error;
  }
};

/**
 * Generate a simple church ID based on the church name (legacy method)
 * This is less secure but more readable - use only for development/testing
 * Examples:
 * - "Development Church" -> "dev_abc123"
 * - "Enjoy Church" -> "enj_def456"
 * - "Redeemer Christian Church" -> "red_xyz789"
 */
const generateSimpleChurchId = async (churchName) => {
  try {
    // Create a base identifier from church name (first 3 letters)
    const baseId = churchName.toLowerCase()
      .replace(/[^a-z0-9]/g, '') // Remove all non-alphanumeric characters
      .substring(0, 3); // Use only first 3 characters
    
    // If baseId is empty after cleaning, use a default
    const finalBaseId = baseId || 'chr';
    
    // Generate a shorter random suffix for development (6 chars instead of 12)
    const randomSuffix = crypto.randomBytes(3).toString('hex'); // 6 character hex string
    
    const developmentId = `${finalBaseId}_${randomSuffix}`;
    
    // Check if this ID already exists
    const existing = await Database.query(
      'SELECT 1 FROM church_settings WHERE church_id = ?',
      [developmentId]
    );
    
    if (existing.length > 0) {
      // If collision, generate a new one (very unlikely but possible)
      return generateSimpleChurchId(churchName);
    }
    
    return developmentId;
  } catch (error) {
    console.error('Error generating simple church ID:', error);
    throw error;
  }
};

/**
 * Get church ID for existing church or generate new one
 * Uses secure generation in production, simple in development
 * Also creates the church_settings record to store the church name
 */
const getOrCreateChurchId = async (churchName) => {
  try {
    // First, check if a church with this name already exists
    const existing = await Database.query(
      'SELECT church_id FROM church_settings WHERE church_name = ?',
      [churchName]
    );
    
    if (existing.length > 0) {
      return existing[0].church_id;
    }
    
    // Generate new church ID based on environment
    let newChurchId;
    if (process.env.NODE_ENV === 'production') {
      newChurchId = await generateSecureChurchId(churchName);
    } else {
      newChurchId = await generateSimpleChurchId(churchName);
    }
    
    // Create the church_settings record with the church name
    // This ensures the church name is saved when the church_id is first created
    try {
      await Database.query(`
        INSERT INTO church_settings (church_id, church_name, country_code, timezone, onboarding_completed)
        VALUES (?, ?, 'AU', 'Australia/Sydney', false)
      `, [newChurchId, churchName]);
      console.log(`✅ Created church_settings for "${churchName}" with ID: ${newChurchId}`);
    } catch (insertError) {
      // If insert fails (e.g., duplicate), log but don't throw - the ID is still valid
      console.warn(`⚠️ Could not create church_settings for ${newChurchId}:`, insertError.message);
    }
    
    return newChurchId;
  } catch (error) {
    console.error('Error getting or creating church ID:', error);
    throw error;
  }
};

/**
 * Validate church ID format
 * Returns true if the ID follows the expected format
 */
const isValidChurchId = (churchId) => {
  if (!churchId || typeof churchId !== 'string') {
    return false;
  }
  
  // Check for secure format (base_random)
  const securePattern = /^[a-z0-9]{3}_[a-f0-9]{12}$/;
  if (securePattern.test(churchId)) {
    return true;
  }
  
  // Check for simple format (3 chars + underscore + 6 hex chars, like dev_abc123)
  const simplePattern = /^[a-z0-9]{3}_[a-f0-9]{6}$/;
  if (simplePattern.test(churchId)) {
    return true;
  }
  
  // Also accept legacy simple format (base + optional number) for backwards compatibility
  const legacyPattern = /^[a-z0-9]{1,20}\d*$/;
  if (legacyPattern.test(churchId)) {
    return true;
  }
  
  return false;
};

/**
 * Sanitize church ID for logging (remove sensitive parts)
 */
const sanitizeChurchIdForLogging = (churchId) => {
  if (!churchId) return 'null';
  
  // For secure IDs, show only the base part
  if (churchId.includes('_')) {
    const parts = churchId.split('_');
    return `${parts[0]}_**${churchId.slice(-4)}`; // Show first part and last 4 chars
  }
  
  // For simple IDs, show as is (they're not sensitive)
  return churchId;
};

module.exports = {
  generateSecureChurchId,
  generateSimpleChurchId,
  getOrCreateChurchId,
  isValidChurchId,
  sanitizeChurchIdForLogging
};
