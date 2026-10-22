#!/usr/bin/env node
'use strict';

const net = require('net');

/**
 * Trusted GIT_ASKPASS credential helper for K-Panel.
 * Communicates exclusively with the local Unix domain socket credential broker.
 * Never logs credentials to stderr or disk.
 */

const prompt = process.argv[2] || '';
const socketPath = process.env.KPANEL_ASKPASS_SOCKET;
const nonce = process.env.KPANEL_ASKPASS_NONCE;

if (!socketPath || !nonce) {
  process.exit(1);
}

// Enforce strict execution timeout
const timeout = setTimeout(() => {
  process.exit(1);
}, 5000);

const client = net.createConnection({ path: socketPath }, () => {
  const payload = JSON.stringify({ nonce, prompt }) + '\n';
  client.write(payload);
});

let buffer = '';

client.on('data', (chunk) => {
  buffer += chunk.toString();
  if (buffer.includes('\n')) {
    clearTimeout(timeout);
    try {
      const response = JSON.parse(buffer.trim());
      if (response && typeof response.value === 'string') {
        process.stdout.write(response.value + '\n');
        client.destroy();
        process.exit(0);
      }
    } catch {}
    client.destroy();
    process.exit(1);
  }
});

client.on('end', () => {
  clearTimeout(timeout);
  try {
    const response = JSON.parse(buffer.trim());
    if (response && typeof response.value === 'string') {
      process.stdout.write(response.value + '\n');
      process.exit(0);
    }
  } catch {}
  process.exit(1);
});

client.on('error', () => {
  clearTimeout(timeout);
  process.exit(1);
});
