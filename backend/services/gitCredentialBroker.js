const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

class CredentialBrokerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CredentialBrokerError';
    this.code = code;
  }
}

/**
 * Starts a short-lived local Unix-domain socket credential broker for a single Git operation.
 * Keeps the installation token in memory and serves it only to the authorized askpass helper.
 *
 * @param {Object} options
 * @param {string} options.token - GitHub App installation access token
 * @param {string} options.operationId - Unique operation UUID
 * @param {string} [options.expectedHost='github.com'] - Hostname authorized to receive credentials
 * @param {number} [options.timeoutMs=60000] - Broker maximum lifetime
 * @param {number} [options.maxRequests=2] - Maximum credential prompts allowed (username + password)
 * @returns {Promise<Object>} { socketPath, nonce, close }
 */
function startCredentialBroker(options = {}) {
  return new Promise((resolve, reject) => {
    if (!options.token || typeof options.token !== 'string') {
      return reject(new CredentialBrokerError('Installation token is required for credential broker.', 'CREDENTIAL_BROKER_ERROR'));
    }

    let tokenHolder = options.token;
    const operationId = options.operationId || crypto.randomUUID();
    const expectedHost = (options.expectedHost || 'github.com').toLowerCase();
    const timeoutMs = options.timeoutMs || 60000;
    const maxRequests = options.maxRequests || 2;

    // Cryptographic 256-bit single-use operation nonce
    const nonce = crypto.randomBytes(32).toString('hex');
    const nonceBuffer = Buffer.from(nonce, 'utf8');

    // Create an isolated, restricted directory in os.tmpdir() with mode 0o700
    const brokerDir = fs.mkdtempSync(path.join(os.tmpdir(), `kpanel-broker-${operationId.slice(0, 8)}-`));
    try {
      fs.chmodSync(brokerDir, 0o700);
    } catch {}

    const socketPath = path.join(brokerDir, 'askpass.sock');

    let requestCount = 0;
    let usernameIssued = false;
    let passwordIssued = false;
    let isClosed = false;
    const activeConnections = new Set();

    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      tokenHolder = null; // Wipe token from memory reference

      clearTimeout(lifetimeTimer);

      for (const socket of activeConnections) {
        try { socket.destroy(); } catch {}
      }
      activeConnections.clear();

      try {
        server.close();
      } catch {}

      try {
        if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
      } catch {}

      try {
        if (fs.existsSync(brokerDir)) {
          fs.rmSync(brokerDir, { recursive: true, force: true });
        }
      } catch {}
    };

    const lifetimeTimer = setTimeout(() => {
      cleanup();
    }, timeoutMs);

    const server = net.createServer({ pauseOnConnect: false }, (socket) => {
      activeConnections.add(socket);

      let buffer = '';

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) {
          handleRequest(socket, buffer.trim());
          buffer = '';
        }
      });

      socket.on('close', () => {
        activeConnections.delete(socket);
      });

      socket.on('error', () => {
        activeConnections.delete(socket);
      });
    });

    function handleRequest(socket, rawData) {
      requestCount++;

      // Enforce maximum request count bounds
      if (requestCount > maxRequests) {
        socket.write(JSON.stringify({ error: 'MAX_REQUESTS_EXCEEDED' }) + '\n');
        socket.end();
        return;
      }

      let req;
      try {
        req = JSON.parse(rawData);
      } catch {
        socket.write(JSON.stringify({ error: 'MALFORMED_REQUEST' }) + '\n');
        socket.end();
        return;
      }

      // Nonce verification with timing-safe comparison
      if (!req.nonce || typeof req.nonce !== 'string') {
        socket.write(JSON.stringify({ error: 'ACCESS_DENIED' }) + '\n');
        socket.end();
        return;
      }

      const receivedNonceBuf = Buffer.from(req.nonce, 'utf8');
      if (receivedNonceBuf.length !== nonceBuffer.length || !crypto.timingSafeEqual(receivedNonceBuf, nonceBuffer)) {
        socket.write(JSON.stringify({ error: 'ACCESS_DENIED' }) + '\n');
        socket.end();
        return;
      }

      const prompt = String(req.prompt || '');

      // Verify the prompt targets the authorized host
      if (!prompt.toLowerCase().includes(expectedHost)) {
        socket.write(JSON.stringify({ error: 'UNAUTHORIZED_HOST' }) + '\n');
        socket.end();
        return;
      }

      // Handle standard Git credential prompts with single-use sequence and token zeroization
      if (/username/i.test(prompt)) {
        if (usernameIssued) {
          socket.write(JSON.stringify({ error: 'DUPLICATE_CHALLENGE' }) + '\n');
          socket.end();
          return;
        }
        usernameIssued = true;
        socket.write(JSON.stringify({ value: 'x-access-token' }) + '\n');
        socket.end();
        return;
      }

      if (/password/i.test(prompt)) {
        if (passwordIssued) {
          socket.write(JSON.stringify({ error: 'DUPLICATE_CHALLENGE' }) + '\n');
          socket.end();
          return;
        }
        passwordIssued = true;
        if (tokenHolder) {
          socket.write(JSON.stringify({ value: tokenHolder }) + '\n');
          tokenHolder = null; // Zeroize/wipe from memory immediately after delivery
        } else {
          socket.write(JSON.stringify({ error: 'TOKEN_UNAVAILABLE' }) + '\n');
        }
        socket.end();
        return;
      }

      // Reject unknown prompts
      socket.write(JSON.stringify({ error: 'UNRECOGNIZED_PROMPT' }) + '\n');
      socket.end();
    }

    server.on('error', (err) => {
      cleanup();
      reject(new CredentialBrokerError(`Failed to start Unix domain socket broker: ${err.message}`, 'CREDENTIAL_BROKER_ERROR'));
    });

    server.listen(socketPath, () => {
      resolve({
        socketPath,
        nonce,
        close: cleanup
      });
    });
  });
}

module.exports = {
  startCredentialBroker,
  CredentialBrokerError
};
