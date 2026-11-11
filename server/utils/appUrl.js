const DEFAULT_APP_URL = 'https://letmypeoplegrow.app';
const PUBLIC_HOSTS = new Set(['letmypeoplegrow.app', 'app.letmypeoplegrow.com.au']);

function parseOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function firstHeader(value) {
  return typeof value === 'string' ? value.split(',')[0].trim() : '';
}

// Scheduled messages use the configured frontend or our public default. Links
// created during a request retain either supported public domain, including the
// legacy address. Never copy an arbitrary request host into an invitation link.
function getAppUrl(req, env = process.env) {
  const configured = parseOrigin(env.CLIENT_URL) || parseOrigin(env.FRONTEND_URL);
  const fallback = configured?.origin || DEFAULT_APP_URL;
  if (!req) return fallback;

  const headers = req.headers || {};
  const protocol = firstHeader(headers['x-forwarded-proto']) || req.protocol || 'http';
  const origins = [headers.origin];
  for (const value of [headers['x-forwarded-host'], headers.host]) {
    const host = firstHeader(value);
    if (host && !/[\s\\/@?#]/.test(host)) origins.push(`${protocol}://${host}`);
  }

  for (const value of origins) {
    const url = parseOrigin(value);
    if (!url) continue;
    if (PUBLIC_HOSTS.has(url.hostname) && !url.port) return `https://${url.hostname}`;
    if (configured && url.origin === configured.origin) return configured.origin;
    if (env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return url.origin;
    }
  }
  return fallback;
}

module.exports = { getAppUrl };
