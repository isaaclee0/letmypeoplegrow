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
 * - "Development Church" -> "devch1"
 * - "Redeemer Christian Church" -> "redcc1"
 */
const generateSimpleChurchId = async (churchName) => {
  try {
    // Convert church name to simple format (lowercase, no spaces, no special chars)
    let baseId = churchName.toLowerCase()
      .replace(/[^a-z0-9]/g, '') // Remove all non-alphanumeric characters
      .substring(0, 20); // Limit to 20 characters
    
    // If baseId is empty after cleaning, use a default
    if (!baseId) {
      baseId = 'church';
    }
    
    // Check if this base_id already exists and find the next available number
    let counter = 1;
    let finalId = baseId;
    
    while (true) {
      const existing = await Database.query(
        'SELECT 1 FROM church_settings WHERE church_id = ?',
        [finalId]
      );
      
      if (existing.length === 0) {
        break; // This ID is available
      }
      
      counter++;
      finalId = `${baseId}${counter}`;
      
      // Prevent infinite loop (max 999 churches with same base name)
      if (counter > 999) {
        throw new Error('Too many churches with similar names');
      }
    }
    
    return finalId;
  } catch (error) {
    console.error('Error generating church ID:', error);
    throw error;
  }
};

/**
 * Get church ID for existing church or generate new one
 * Uses secure generation in production, simple in development
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
    if (process.env.NODE_ENV === 'production') {
      return await generateSecureChurchId(churchName);
    } else {
      return await generateSimpleChurchId(churchName);
    }
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
  
  // Check for simple format (base + optional number)
  const simplePattern = /^[a-z0-9]{1,20}\d*$/;
  if (simplePattern.test(churchId)) {
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
