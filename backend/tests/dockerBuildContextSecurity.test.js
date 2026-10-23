const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const BACKEND_DIR = path.resolve(__dirname, '..');
const DOCKERIGNORE_PATH = path.join(BACKEND_DIR, '.dockerignore');
const DOCKERFILE_PATH = path.join(BACKEND_DIR, 'Dockerfile');

/**
 * Converts a gitignore/dockerignore glob pattern to a JavaScript RegExp.
 */
function patternToRegex(pattern) {
  let p = pattern.trim();
  if (!p || p.startsWith('#')) return null;

  // Normalize directory slash
  const directoryOnly = p.endsWith('/');
  if (directoryOnly) p = p.slice(0, -1);

  // Escape special regex chars except * and ?
  let regexStr = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___GLOBSTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/___GLOBSTAR___/g, '.*');

  if (directoryOnly) {
    return new RegExp(`(^|/)${regexStr}(/|$)`);
  }
  return new RegExp(`(^|/)${regexStr}$`);
}

/**
 * Checks whether a given path is matched by the dockerignore rules.
 */
function isIgnored(filePath, patterns) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  for (const pat of patterns) {
    if (!pat || pat.startsWith('#')) continue;
    const re = patternToRegex(pat);
    if (re && (re.test(normalized) || re.test(path.basename(normalized)))) {
      return true;
    }
    // Also check if any parent directory is ignored
    const parts = normalized.split('/');
    let cumulative = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cumulative = cumulative ? `${cumulative}/${parts[i]}` : parts[i];
      if (re && (re.test(cumulative) || re.test(parts[i]))) {
        return true;
      }
    }
  }
  return false;
}

test('Phase U1: Docker Build-Context Security & Node Compatibility Suite', async (t) => {
  // ── 1. Backend .dockerignore existence and content ────────────────
  await t.test('1. backend/.dockerignore exists and is non-empty', () => {
    assert.ok(fs.existsSync(DOCKERIGNORE_PATH), 'backend/.dockerignore must exist');
    const content = fs.readFileSync(DOCKERIGNORE_PATH, 'utf8').trim();
    assert.ok(content.length > 50, 'backend/.dockerignore must have meaningful content');
  });

  // ── 2. Mandatory exclusion rules presence ──────────────────────────
  await t.test('2. backend/.dockerignore defines all mandatory security exclusions', () => {
    const content = fs.readFileSync(DOCKERIGNORE_PATH, 'utf8');

    // Secrets and env
    assert.ok(/\.env/i.test(content), '.dockerignore must exclude .env');
    assert.ok(/\.env\*/i.test(content) || /\*\.env/i.test(content), '.dockerignore must exclude .env variants');

    // Runtime data and databases
    assert.ok(/data\//.test(content) || /data\b/.test(content), '.dockerignore must exclude data/');
    assert.ok(/\*\.db/i.test(content), '.dockerignore must exclude *.db');
    assert.ok(/wal/i.test(content), '.dockerignore must exclude SQLite WAL files');
    assert.ok(/shm/i.test(content), '.dockerignore must exclude SQLite SHM files');

    // Logs
    assert.ok(/logs\//.test(content) || /\*\.log/i.test(content), '.dockerignore must exclude logs and *.log');

    // Node modules
    assert.ok(/node_modules/i.test(content), '.dockerignore must exclude node_modules/');

    // SSH and crypto keys
    assert.ok(/id_rsa/i.test(content), '.dockerignore must exclude id_rsa');
    assert.ok(/id_ed25519/i.test(content), '.dockerignore must exclude id_ed25519');
    assert.ok(/\*\.pem/i.test(content), '.dockerignore must exclude *.pem');
    assert.ok(/\*\.key/i.test(content), '.dockerignore must exclude *.key');

    // Certificates
    assert.ok(/\*\.crt/i.test(content) || /\*\.pfx/i.test(content), '.dockerignore must exclude certificates');

    // Backups
    assert.ok(/\*\.bak/i.test(content) || /\*\.tar\.gz/i.test(content), '.dockerignore must exclude backup archives');

    // Repository metadata
    assert.ok(/\.git\b/i.test(content), '.dockerignore must exclude .git');
  });

  // ── 3. Pattern evaluation for sensitive and runtime files ─────────
  await t.test('3. Rule verification: sensitive files are strictly excluded from build context', () => {
    const patterns = fs.readFileSync(DOCKERIGNORE_PATH, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const sensitiveFiles = [
      '.env',
      '.env.production',
      '.env.local',
      '.env.staging',
      'subfolder/.env',
      'data/deployments.json',
      'data/kpanel.db',
      'data/kpanel.db-wal',
      'data/kpanel.db-shm',
      'data/kpanel.log',
      'data/subdir/file.txt',
      'kpanel.log',
      'logs/error.log',
      'node_modules/express/index.js',
      'id_rsa',
      'id_rsa.pub',
      'id_ed25519',
      'server.key',
      'cert.pem',
      'bundle.crt',
      'backup.tar.gz',
      'database.bak',
      '.git/HEAD',
      '.github/workflows/deploy.yml'
    ];

    for (const file of sensitiveFiles) {
      assert.ok(
        isIgnored(file, patterns),
        `CRITICAL SECURITY VIOLATION: "${file}" must be excluded by backend/.dockerignore`
      );
    }
  });

  // ── 4. Pattern evaluation: essential source files are preserved ───
  await t.test('4. Rule verification: application source files are NOT accidentally excluded', () => {
    const patterns = fs.readFileSync(DOCKERIGNORE_PATH, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const essentialSourceFiles = [
      'server.js',
      'package.json',
      'package-lock.json',
      'Dockerfile',
      'config/database.js',
      'db/migrate.js',
      'db/migrations/001_initial.js',
      'db/migrations/010_activation_journal.js',
      'routes/applications.js',
      'routes/github.js',
      'routes/webhooks.js',
      'services/applicationService.js',
      'services/gitCredentialBroker.js',
      'services/dockerSecurityService.js',
      'helpers/gitAskpass.js'
    ];

    for (const file of essentialSourceFiles) {
      assert.strictEqual(
        isIgnored(file, patterns),
        false,
        `SOURCE FILE INTEGRITY VIOLATION: "${file}" must NOT be excluded by backend/.dockerignore`
      );
    }
  });

  // ── 5. Dockerfile uses supported Node 22+ LTS base ────────────────
  await t.test('5. backend/Dockerfile uses Node 22+ LTS base for better-sqlite3 engine compatibility', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_PATH, 'utf8');
    assert.ok(
      /FROM\s+node:22(-alpine|\.|\b)/i.test(dockerfile),
      'Dockerfile must use node:22-alpine base for better-sqlite3 engine compatibility'
    );
    assert.strictEqual(
      /FROM\s+node:20/i.test(dockerfile),
      false,
      'Dockerfile must NOT use node:20 because better-sqlite3 ^13.0.3 requires Node >=22'
    );
  });

  // ── 6. Dockerfile uses deterministic npm ci --omit=dev ────────────
  await t.test('6. backend/Dockerfile uses deterministic npm ci --omit=dev', () => {
    const dockerfile = fs.readFileSync(DOCKERFILE_PATH, 'utf8');
    assert.ok(
      /npm\s+ci\s+--omit=dev/.test(dockerfile),
      'Dockerfile must use "npm ci --omit=dev" for deterministic production dependency installation'
    );
    assert.strictEqual(
      /npm\s+install\s+--production/.test(dockerfile),
      false,
      'Dockerfile must NOT use unconstrained "npm install --production"'
    );
  });

  // ── 7. Live Docker Build Context Exclusion Test ───────────────────
  await t.test('7. Live Docker build context test: .env and data/ are never baked into image', (subTest) => {
    let dockerAvailable = false;
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      dockerAvailable = true;
    } catch {
      subTest.skip('Docker daemon not available in test environment; skipping live image build assertion');
      return;
    }

    const testDir = path.join(require('os').tmpdir(), `kpanel_build_context_test_${crypto.randomBytes(6).toString('hex')}`);
    const testImageTag = `kpanel-context-test:${crypto.randomBytes(4).toString('hex')}`;
    const canarySecret = `CANARY_SECRET_${crypto.randomBytes(16).toString('hex')}`;
    const canaryDbData = `CANARY_SQLITE_DATA_${crypto.randomBytes(16).toString('hex')}`;

    try {
      fs.mkdirSync(path.join(testDir, 'data'), { recursive: true });
      fs.writeFileSync(path.join(testDir, '.env'), `PRODUCTION_SECRET=${canarySecret}\nK_PANEL_PASSWORD=supersecret\n`);
      fs.writeFileSync(path.join(testDir, '.env.production'), `PROD_KEY=secret_key\n`);
      fs.writeFileSync(path.join(testDir, 'data', 'kpanel.db'), canaryDbData);
      fs.writeFileSync(path.join(testDir, 'data', 'deployments.json'), JSON.stringify([{ canary: canarySecret }]));
      fs.writeFileSync(path.join(testDir, 'id_rsa'), 'CANARY_SSH_PRIVATE_KEY');
      fs.writeFileSync(path.join(testDir, 'server.js'), 'console.log("kpanel test server");');
      fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'kpanel-test', version: '1.0.0' }));
      fs.writeFileSync(path.join(testDir, 'package-lock.json'), JSON.stringify({ name: 'kpanel-test', version: '1.0.0', lockfileVersion: 3 }));

      // Copy backend/.dockerignore to test directory
      fs.copyFileSync(DOCKERIGNORE_PATH, path.join(testDir, '.dockerignore'));

      // Minimal test Dockerfile that executes COPY . .
      const minimalDockerfile = `FROM alpine:latest
WORKDIR /app
COPY . .
`;
      fs.writeFileSync(path.join(testDir, 'Dockerfile'), minimalDockerfile);

      // Build test image
      execSync(`docker build -t ${testImageTag} "${testDir}"`, { stdio: 'pipe', timeout: 60000 });

      // Check contents of /app in built image
      const listing = execSync(`docker run --rm ${testImageTag} sh -c "ls -la /app && find /app -maxdepth 2"`, { stdio: 'pipe' }).toString();

      assert.strictEqual(
        listing.includes('.env'),
        false,
        'CRITICAL SECURITY FAILURE: .env was found in the built Docker image!'
      );
      assert.strictEqual(
        listing.includes('id_rsa'),
        false,
        'CRITICAL SECURITY FAILURE: id_rsa was found in the built Docker image!'
      );
      assert.strictEqual(
        listing.includes('deployments.json'),
        false,
        'CRITICAL SECURITY FAILURE: data/deployments.json was found in the built Docker image!'
      );

      // Inspect entire image filesystem for the canary secret string
      const grepResult = execSync(
        `docker run --rm ${testImageTag} sh -c "grep -rn '${canarySecret}' /app 2>/dev/null || true"`,
        { stdio: 'pipe' }
      ).toString().trim();

      assert.strictEqual(
        grepResult,
        '',
        `CRITICAL LEAK: Canary secret string was found inside Docker image: ${grepResult}`
      );
    } finally {
      // Clean up test image and directory
      try { execSync(`docker rmi -f ${testImageTag}`, { stdio: 'pipe' }); } catch {}
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });
});
