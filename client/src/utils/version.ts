// Version utility to get the current app version
// This reads from the package.json file at build time

// The version is injected by webpack during the build process
// We can access it through the process.env.REACT_APP_VERSION
export const getAppVersion = (): string => {
  // Try to get from environment variable first (set during build)
  if (process.env.REACT_APP_VERSION) {
    return process.env.REACT_APP_VERSION;
  }
  
  // Fallback to package.json version (available in development)
  try {
    // In development, we can import package.json
    const packageJson = require('../../package.json');
    return packageJson.version;
  } catch (error) {
    // Final fallback
    const fallbackVersion = '1.1.4';
    return fallbackVersion;
  }
};

// Format version for display
export const getFormattedVersion = (): string => {
  const version = getAppVersion();
  return version.startsWith('v') ? version : `v${version}`;
}; 