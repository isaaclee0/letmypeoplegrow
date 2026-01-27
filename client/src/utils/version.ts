// Version utility to get the current app version
// The version is set via VITE_APP_VERSION environment variable during build
// This is read from the VERSION file in the project root

// Fallback version - update this when bumping VERSION file
const FALLBACK_VERSION = '1.4.5';

export const getAppVersion = (): string => {
  // Get version from Vite environment variable (set during build from VERSION file)
  if (import.meta.env.VITE_APP_VERSION) {
    return import.meta.env.VITE_APP_VERSION;
  }
  
  // Fallback to hardcoded version (for development without proper env setup)
  // Note: require() doesn't work in Vite, so we use a hardcoded fallback
  return FALLBACK_VERSION;
};

// Format version for display
export const getFormattedVersion = (): string => {
  const version = getAppVersion();
  return version.startsWith('v') ? version : `v${version}`;
}; 