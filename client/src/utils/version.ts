// Version utility to get the current app version
// The version is set via REACT_APP_VERSION environment variable during build
// This is read from the VERSION file in the project root

export const getAppVersion = (): string => {
  // Get version from environment variable (set during build from VERSION file)
  if (process.env.REACT_APP_VERSION) {
    return process.env.REACT_APP_VERSION;
  }
  
  // Fallback to package.json version (available in development)
  try {
    const packageJson = require('../../package.json');
    return packageJson.version;
  } catch (error) {
    // If version can't be determined, return 'unknown' instead of hardcoding
    return 'unknown';
  }
};

// Format version for display
export const getFormattedVersion = (): string => {
  const version = getAppVersion();
  return version.startsWith('v') ? version : `v${version}`;
}; 