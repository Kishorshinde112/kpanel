const crypto = require('crypto');

// ── In-Memory Active Session Store ──────────────────────────
// Maps token -> { createdAt: number, expiresAt: number }
const SESSIONS = new Map();

// Test-only overrides (reset during testing)
let testPasswordOverride = null;
let testSecretOverride = null;

/**
 * Gets the current K_PANEL_PASSWORD configuration.
 * Returns null if not configured or empty.
 */
function getPassword() {
  if (testPasswordOverride !== null) return testPasswordOverride;
  const pw = process.env.K_PANEL_PASSWORD;
  return (pw && pw.length > 0) ? pw : null;
}

/**
 * Checks if the server has an administrative password configured.
 */
function isPasswordConfigured() {
  const pw = getPassword();
  return Boolean(pw && pw.length > 0);
}

/**
 * Gets the current SESSION_SECRET.
 * If not set in environment, generates a random 32-byte secret per process.
 */
let ephemeralSecret = null;
function getSessionSecret() {
  if (testSecretOverride !== null) return testSecretOverride;
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length > 0) {
    return process.env.SESSION_SECRET;
  }
  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomBytes(32).toString('hex');
    if (process.env.NODE_ENV === 'production') {
      console.warn('[SECURITY WARNING] SESSION_SECRET is not configured in environment. Using ephemeral in-memory secret; active sessions will not survive server restarts.');
    }
  }
  return ephemeralSecret;
}

/**
 * Constant-time comparison between entered password and configured password.
 * Uses SHA-256 digests to ensure buffers are always equal length (32 bytes),
 * preventing RangeError exceptions and timing attacks.
 */
function safeComparePasswords(enteredPassword, expectedPassword) {
  if (!expectedPassword || typeof expectedPassword !== 'string' || expectedPassword.length === 0) {
    return false;
  }
  if (!enteredPassword || typeof enteredPassword !== 'string' || enteredPassword.length === 0) {
    return false;
  }
  try {
    const hashA = crypto.createHash('sha256').update(enteredPassword).digest();
    const hashB = crypto.createHash('sha256').update(expectedPassword).digest();
    return crypto.timingSafeEqual(hashA, hashB);
  } catch {
    return false;
  }
}

/**
 * Creates a signed token string: <token>.<hmacSignature>
 */
function signToken(token, secret = getSessionSecret()) {
  const sig = crypto.createHmac('sha256', secret).update(token).digest('hex');
  return `${token}.${sig}`;
}

/**
 * Verifies a signed session token.
 * Validates HMAC signature, checks length equality before timingSafeEqual,
 * checks presence in active session store, and validates expiration.
 */
function verifyToken(signed, secret = getSessionSecret()) {
  if (!signed || typeof signed !== 'string') return false;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return false;

  const token = signed.slice(0, idx);
  const actualSigHex = signed.slice(idx + 1);

  if (!token || !actualSigHex) return false;

  let expectedSigHex;
  try {
    expectedSigHex = crypto.createHmac('sha256', secret).update(token).digest('hex');
  } catch {
    return false;
  }

  const expectedBuf = Buffer.from(expectedSigHex, 'utf8');
  const actualBuf = Buffer.from(actualSigHex, 'utf8');

  // CRITICAL: Guard against RangeError in crypto.timingSafeEqual when lengths differ
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  try {
    if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return false;
    }
  } catch {
    return false;
  }

  // Check if session exists in memory store
  const session = SESSIONS.get(token);
  if (!session) {
    return false;
  }

  // Check expiration (24 hours default)
  if (session.expiresAt && Date.now() > session.expiresAt) {
    SESSIONS.delete(token);
    return false;
  }

  return true;
}

/**
 * Parses raw Cookie header string into key-value map.
 * Safely handles malformed percent-encoding.
 */
function parseCookies(req) {
  const raw = req?.headers?.cookie || '';
  if (!raw || typeof raw !== 'string') return {};
  const cookies = {};
  const pairs = raw.split(';');
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i].trim();
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

/**
 * Extracts signed session token from either:
 * 1. 'kp_session' cookie
 * 2. 'Authorization: Bearer <token>' header
 */
function extractToken(req) {
  if (!req) return null;
  const cookies = parseCookies(req);
  if (cookies['kp_session']) {
    return cookies['kp_session'];
  }
  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (authHeader && typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

/**
 * Checks whether the request is transmitted over HTTPS (directly or via reverse proxy).
 */
function isSecureConnection(req) {
  if (!req) return false;
  if (req.secure) return true;
  const forwardedProto = req.headers?.['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}

/**
 * Formats Set-Cookie header for session creation.
 */
function getCookieHeader(signedToken, isSecure) {
  const parts = [
    `kp_session=${encodeURIComponent(signedToken)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=86400'
  ];
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Formats Set-Cookie header for session destruction.
 */
function getClearCookieHeader(isSecure) {
  const parts = [
    'kp_session=',
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0'
  ];
  if (isSecure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Creates a new authenticated session in memory.
 */
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
  SESSIONS.set(token, {
    createdAt: now,
    expiresAt: now + maxAgeMs
  });
  const signed = signToken(token);
  return { token, signed, maxAgeMs };
}

/**
 * Invalidates and deletes a session from memory.
 */
function destroySession(signed) {
  if (!signed || typeof signed !== 'string') return false;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return false;
  const token = signed.slice(0, idx);
  return SESSIONS.delete(token);
}

/**
 * Clears all active sessions (used during automated tests).
 */
function clearAllSessions() {
  SESSIONS.clear();
}

/**
 * Testing helpers to inject temporary credentials without touching production env.
 */
function setTestPassword(pw) {
  testPasswordOverride = pw;
}
function setTestSessionSecret(secret) {
  testSecretOverride = secret;
}

/**
 * Main Authentication Middleware
 * Enforces authentication on all non-public /api/* routes.
 *
 * Public exceptions:
 * - GET /api/health
 * - POST /api/auth/login
 * - GET /api/auth/status
 *
 * Unknown API routes must not bypass authentication.
 * Fails closed if K_PANEL_PASSWORD is not configured.
 */
function authMiddleware(req, res, next) {
  const rawPath = req.path || req.url?.split('?')[0] || '';
  const normPath = rawPath.endsWith('/') && rawPath.length > 1 ? rawPath.slice(0, -1) : rawPath;
  const method = req.method?.toUpperCase();

  // Public exceptions initially
  const isPublic = (
    (method === 'GET' && (normPath === '/api/health' || normPath === '/health')) ||
    (method === 'POST' && (normPath === '/api/auth/login' || normPath === '/auth/login')) ||
    (method === 'GET' && (normPath === '/api/auth/status' || normPath === '/auth/status'))
  );

  if (isPublic) {
    return next();
  }

  // If password is not configured on the server, fail closed
  if (!isPasswordConfigured()) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Server authentication is not configured. Access denied.'
    });
  }

  // Extract and verify session token
  const signed = extractToken(req);
  if (!signed || !verifyToken(signed)) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required to access this resource'
    });
  }

  // Valid session - proceed
  next();
}

/**
 * Route handler: POST /api/auth/login
 */
function loginHandler(req, res, logFn) {
  const log = typeof logFn === 'function' ? logFn : () => {};
  const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';

  if (!isPasswordConfigured()) {
    log(`Login attempt rejected: K_PANEL_PASSWORD not configured on host from ${clientIp}`);
    return res.status(401).json({ error: 'Server authentication not configured' });
  }

  const { password } = req.body || {};
  const configuredPassword = getPassword();

  if (!password || !safeComparePasswords(password, configuredPassword)) {
    log(`Failed login attempt from ${clientIp}`);
    return res.status(401).json({ error: 'Invalid password' });
  }

  const { signed } = createSession();
  const secure = isSecureConnection(req);

  res.setHeader('Set-Cookie', getCookieHeader(signed, secure));
  log(`Successful login from ${clientIp}`);
  res.json({ success: true });
}

/**
 * Route handler: POST /api/auth/logout
 */
function logoutHandler(req, res) {
  const signed = extractToken(req);
  if (signed) {
    destroySession(signed);
  }
  const secure = isSecureConnection(req);
  res.setHeader('Set-Cookie', getClearCookieHeader(secure));
  res.json({ success: true });
}

/**
 * Route handler: GET /api/auth/status
 */
function statusHandler(req, res) {
  if (!isPasswordConfigured()) {
    return res.json({ authenticated: false, configured: false });
  }
  const signed = extractToken(req);
  const authenticated = Boolean(signed && verifyToken(signed));
  res.json({ authenticated, configured: true });
}

module.exports = {
  authMiddleware,
  loginHandler,
  logoutHandler,
  statusHandler,
  isPasswordConfigured,
  getPassword,
  getSessionSecret,
  safeComparePasswords,
  signToken,
  verifyToken,
  parseCookies,
  extractToken,
  isSecureConnection,
  getCookieHeader,
  getClearCookieHeader,
  createSession,
  destroySession,
  clearAllSessions,
  setTestPassword,
  setTestSessionSecret,
  SESSIONS
};
