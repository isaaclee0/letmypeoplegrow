/**
 * Utility functions for converting between snake_case and camelCase
 * This ensures consistent naming conventions between database (snake_case) and frontend (camelCase)
 */

/**
 * Convert snake_case string to camelCase
 * @param {string} str - The snake_case string to convert
 * @returns {string} - The camelCase string
 */
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
}

/**
 * Convert camelCase string to snake_case
 * @param {string} str - The camelCase string to convert
 * @returns {string} - The snake_case string
 */
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}

/**
 * Convert object keys from snake_case to camelCase
 * @param {Object|Array} obj - The object or array to convert
 * @returns {Object|Array} - The converted object/array
 */
function convertKeysToCamelCase(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => convertKeysToCamelCase(item));
  }

  if (typeof obj === 'object') {
    const converted = {};
    for (const [key, value] of Object.entries(obj)) {
      const camelKey = snakeToCamel(key);
      converted[camelKey] = convertKeysToCamelCase(value);
    }
    return converted;
  }

  return obj;
}

/**
 * Convert object keys from camelCase to snake_case
 * @param {Object|Array} obj - The object or array to convert
 * @returns {Object|Array} - The converted object/array
 */
function convertKeysToSnakeCase(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => convertKeysToSnakeCase(item));
  }

  if (typeof obj === 'object') {
    const converted = {};
    for (const [key, value] of Object.entries(obj)) {
      const snakeKey = camelToSnake(key);
      converted[snakeKey] = convertKeysToSnakeCase(value);
    }
    return converted;
  }

  return obj;
}

/**
 * Middleware to automatically convert response data to camelCase
 * Use this in routes to ensure consistent API responses
 */
function camelCaseResponse(req, res, next) {
  const originalJson = res.json;
  
  res.json = function(data) {
    const convertedData = convertKeysToCamelCase(data);
    originalJson.call(this, convertedData);
  };
  
  next();
}

/**
 * Convert BigInt values to regular numbers to avoid JSON serialization issues
 * @param {Object|Array} obj - The object or array to convert
 * @returns {Object|Array} - The converted object/array with BigInts as Numbers
 */
function convertBigIntToNumber(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => convertBigIntToNumber(item));
  }

  if (typeof obj === 'object') {
    const converted = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'bigint') {
        converted[key] = Number(value);
      } else {
        converted[key] = convertBigIntToNumber(value);
      }
    }
    return converted;
  }

  return obj;
}

/**
 * Complete response processor that handles both BigInt conversion and camelCase conversion
 * @param {Object|Array} data - The data to process
 * @returns {Object|Array} - The processed data
 */
function processApiResponse(data) {
  const bigIntConverted = convertBigIntToNumber(data);
  return convertKeysToCamelCase(bigIntConverted);
}

module.exports = {
  snakeToCamel,
  camelToSnake,
  convertKeysToCamelCase,
  convertKeysToSnakeCase,
  camelCaseResponse,
  convertBigIntToNumber,
  processApiResponse
}; 