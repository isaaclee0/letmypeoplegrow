// Version utility to get the current app version
// __APP_VERSION__ is injected by vite.config.ts from the root VERSION file at build/dev time.
// VITE_APP_VERSION env var can override it (e.g. from Docker Compose).

declare const __APP_VERSION__: string;

export const getAppVersion = (): string => {
  // 1. Env var override (set by Docker Compose or CI)
  if (import.meta.env.VITE_APP_VERSION) {
    return import.meta.env.VITE_APP_VERSION;
  }

  // 2. Injected at build time from VERSION file via vite.config.ts
  if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) {
    return __APP_VERSION__;
  }

  return '0.0.0';
};

// Format version for display
export const getFormattedVersion = (): string => {
  const version = getAppVersion();
  return version.startsWith('v') ? version : `v${version}`;
};
