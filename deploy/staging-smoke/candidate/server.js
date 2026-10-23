/**
 * Disposable Candidate Application Server (Stateless HTTP)
 *
 * Designed for isolated staging smoke-testing on Oracle ARM64 VPS.
 * Invariants:
 * - Pure Node.js built-in HTTP module (zero third-party dependencies).
 * - Zero filesystem write dependencies (operates under ReadonlyRootfs).
 * - Zero database connections or persistent state.
 * - Zero production API or external network calls.
 * - Zero sensitive credentials or backend secrets.
 * - Configurable internal port (defaults to 8080, never hardcoded 3000 in shared models).
 * - Explicit /healthz endpoint for container HEALTHCHECK.
 */

const http = require('http');

const PORT = parseInt(process.env.PORT || '8080', 10);
const APP_NAME = process.env.APP_NAME || 'kpanel-smoke-candidate';
const APP_VERSION = process.env.APP_VERSION || '1.0.0';

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // Liveness & Readiness health probe
  if (url === '/healthz' || url === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store'
    });
    res.end(JSON.stringify({
      status: 'healthy',
      service: APP_NAME,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsageBytes: process.memoryUsage().rss
    }));
    return;
  }

  // Root endpoint: stateless identity response
  if (url === '/' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    res.end(JSON.stringify({
      status: 'ok',
      service: APP_NAME,
      role: 'candidate',
      environment: 'staging-smoke',
      version: APP_VERSION,
      arch: process.arch,
      nodeVersion: process.version,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 404 for unmapped endpoints
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Not Found',
    path: url,
    timestamp: new Date().toISOString()
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[kpanel-smoke-candidate] Listening on port ${PORT} (PID: ${process.pid}, UID: ${process.getuid ? process.getuid() : 'N/A'}, arch: ${process.arch})`);
});

// Graceful termination handling
function handleShutdown(signal) {
  console.log(`[kpanel-smoke-candidate] Received ${signal}. Shutting down cleanly...`);
  server.close(() => {
    console.log('[kpanel-smoke-candidate] HTTP server closed.');
    process.exit(0);
  });
  // Force exit after 3 seconds if connections hang
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
