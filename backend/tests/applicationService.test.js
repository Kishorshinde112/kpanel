const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { getDatabase, closeDatabase, getDatabasePath, isOpen } = require('../config/database');
const { runMigrations } = require('../db/migrate');
const {
  createApplication,
  getApplicationById,
  getApplicationBySlug,
  listApplications,
  updateApplication,
  ApplicationServiceError
} = require('../services/applicationService');

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

test('Phase 2B1: Application Service Layer Suite', async (t) => {
  let tempDir;
  let tempDbPath;
  let originalDeploymentsContent;

  t.before(() => {
    // Record original legacy deployments.json content for integrity verification
    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-app-service-test-'));
    tempDbPath = path.join(tempDir, 'test-kpanel.db');

    // Initialize database and run migrations
    const db = getDatabase({ dbPath: tempDbPath });
    runMigrations(db);
  });

  t.after(() => {
    closeDatabase();
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }

    // Verify deployments.json was untouched
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const currentContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(
        currentContent,
        originalDeploymentsContent,
        'CRITICAL: backend/data/deployments.json must remain completely identical and untouched'
      );
    }
  });

  // ── 1. Create Application Successfully ─────────────────────────────
  await t.test('1. Create application successfully with valid inputs', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const app = createApplication(
      {
        name: 'Production Next.js Website',
        slug: 'prod-nextjs-site',
        repo_url: 'https://github.com/my-org/my-site.git',
        branch: 'main',
        build_type: 'dockerfile',
        build_path: '/',
        port: 3000,
        domain: 'site.kishorlab.dev',
        cpu_limit: 2.0,
        memory_limit_mb: 2048
      },
      { db }
    );

    assert.ok(app.id, 'Application must be assigned an ID');
    assert.equal(app.name, 'Production Next.js Website');
    assert.equal(app.slug, 'prod-nextjs-site');
    assert.equal(app.repo_url, 'https://github.com/my-org/my-site.git');
    assert.equal(app.branch, 'main');
    assert.equal(app.build_type, 'dockerfile');
    assert.equal(app.port, 3000);
    assert.equal(app.domain, 'site.kishorlab.dev');
    assert.equal(app.cpu_limit, 2.0);
    assert.equal(app.memory_limit_mb, 2048);
    assert.ok(app.created_at);
    assert.ok(app.updated_at);
  });

  // ── 2. Retrieve Application by ID ──────────────────────────────────
  await t.test('2. Retrieve application by ID', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const found = getApplicationBySlug('prod-nextjs-site', { db });
    assert.ok(found);

    const byId = getApplicationById(found.id, { db });
    assert.ok(byId);
    assert.equal(byId.id, found.id);
    assert.equal(byId.slug, 'prod-nextjs-site');
  });

  // ── 3. Retrieve Application by Slug ────────────────────────────────
  await t.test('3. Retrieve application by slug', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const bySlug = getApplicationBySlug('prod-nextjs-site', { db });
    assert.ok(bySlug);
    assert.equal(bySlug.name, 'Production Next.js Website');

    const missing = getApplicationBySlug('non-existent-slug-xyz', { db });
    assert.equal(missing, null);
  });

  // ── 4. List Applications ───────────────────────────────────────────
  await t.test('4. List applications returns array and deterministic ordering', () => {
    const db = getDatabase({ dbPath: tempDbPath });

    // Insert additional applications
    createApplication(
      {
        name: 'Documentation Portal',
        slug: 'docs-portal',
        repo_url: 'https://github.com/my-org/docs.git'
      },
      { db }
    );
    createApplication(
      {
        name: 'API Microservice',
        slug: 'api-service',
        repo_url: 'https://github.com/my-org/api.git'
      },
      { db }
    );

    const list = listApplications({ db });
    assert.ok(Array.isArray(list.data));
    assert.ok(list.data.length >= 3);
    assert.equal(typeof list.pagination.total, 'number');
    assert.ok(list.pagination.total >= 3);
  });

  // ── 5. Pagination ──────────────────────────────────────────────────
  await t.test('5. Pagination honors page and limit options', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const page1 = listApplications({ db, page: 1, limit: 2 });
    assert.equal(page1.data.length, 2);
    assert.equal(page1.pagination.page, 1);
    assert.equal(page1.pagination.limit, 2);

    const page2 = listApplications({ db, page: 2, limit: 2 });
    assert.ok(page2.data.length >= 1);
    assert.equal(page2.pagination.page, 2);

    // Verify page 1 and page 2 contain different records
    assert.notEqual(page1.data[0].id, page2.data[0].id);
  });

  // ── 6. Update Application ──────────────────────────────────────────
  await t.test('6. Update application modifies only supported editable fields', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const original = getApplicationBySlug('api-service', { db });
    assert.ok(original);

    const updated = updateApplication(
      original.id,
      {
        name: 'Core API Microservice v2',
        branch: 'develop',
        port: 8080,
        cpu_limit: 3.5
      },
      { db }
    );

    assert.equal(updated.id, original.id);
    assert.equal(updated.name, 'Core API Microservice v2');
    assert.equal(updated.branch, 'develop');
    assert.equal(updated.port, 8080);
    assert.equal(updated.cpu_limit, 3.5);
    // Unchanged field
    assert.equal(updated.repo_url, original.repo_url);
  });

  // ── 7. Duplicate Slug Rejection ────────────────────────────────────
  await t.test('7. Duplicate slug rejection throws DUPLICATE_SLUG error', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    assert.throws(
      () => {
        createApplication(
          {
            name: 'Another Portal',
            slug: 'prod-nextjs-site', // already exists
            repo_url: 'https://github.com/other/repo.git'
          },
          { db }
        );
      },
      (err) => {
        return err instanceof ApplicationServiceError && err.code === 'DUPLICATE_SLUG';
      }
    );
  });

  // ── 8. Missing Application Handling ────────────────────────────────
  await t.test('8. Missing application handling returns null or APPLICATION_NOT_FOUND', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const missing = getApplicationById('non-existent-uuid-12345', { db });
    assert.equal(missing, null);

    assert.throws(
      () => {
        updateApplication('non-existent-uuid-12345', { name: 'New Name' }, { db });
      },
      (err) => {
        return err instanceof ApplicationServiceError && err.code === 'APPLICATION_NOT_FOUND';
      }
    );
  });

  // ── 9. Invalid Repository URL Rejection ────────────────────────────
  await t.test('9. Invalid repository URL rejection', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const invalidUrls = [
      '',
      'not-a-url',
      'file:///etc/passwd',
      '/home/ubuntu/repo',
      '../relative/path',
      'https://',
      'http://invalid url with spaces'
    ];

    for (const url of invalidUrls) {
      assert.throws(
        () => {
          createApplication({ name: 'Test App', repo_url: url }, { db });
        },
        /Repository URL/i,
        `Expected rejection for invalid URL: "${url}"`
      );
    }
  });

  // ── 10. Repository URL Containing Credentials Rejection ────────────
  await t.test('10. Repository URL containing embedded credentials is strictly rejected', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const credentialUrls = [
      'https://user:ghp_secretToken12345@github.com/owner/repo.git',
      'http://token123@gitlab.com/owner/repo',
      'https://admin:password@my-git.dev/app'
    ];

    for (const url of credentialUrls) {
      assert.throws(
        () => {
          createApplication({ name: 'Credential App', repo_url: url }, { db });
        },
        /embedded authentication credentials/i,
        `Expected rejection for credentialed URL: "${url}"`
      );
    }
  });

  // ── 11. Invalid Port Rejection ─────────────────────────────────────
  await t.test('11. Invalid port rejection (0, negative, > 65535, strings)', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const invalidPorts = [0, -1, 65536, 999999, 'abc', 3.14];

    for (const port of invalidPorts) {
      assert.throws(
        () => {
          createApplication({ name: 'Test App', repo_url: 'https://github.com/org/repo.git', port }, { db });
        },
        /port must be an integer between 1 and 65535/i
      );
    }
  });

  // ── 12. Invalid Build Type Rejection ───────────────────────────────
  await t.test('12. Invalid build type rejection', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    assert.throws(
      () => {
        createApplication(
          {
            name: 'Test App',
            repo_url: 'https://github.com/org/repo.git',
            build_type: 'kubernetes-helm' // not supported
          },
          { db }
        );
      },
      /Unsupported build type/i
    );
  });

  // ── 13. Invalid Build Path Rejection ───────────────────────────────
  await t.test('13. Invalid build path rejection (path traversal)', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const traversalPaths = ['../', '/app/../../etc', '..', 'sub/../../root'];

    for (const build_path of traversalPaths) {
      assert.throws(
        () => {
          createApplication(
            {
              name: 'Traversal App',
              repo_url: 'https://github.com/org/repo.git',
              build_path
            },
            { db }
          );
        },
        /directory traversal/i
      );
    }
  });

  // ── 14. Unknown Update Fields Rejected ─────────────────────────────
  await t.test('14. Unknown fields in creation or update payload are rejected', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    assert.throws(
      () => {
        createApplication(
          {
            name: 'App with Rogue Field',
            repo_url: 'https://github.com/org/repo.git',
            unrecognized_property: 'injected_value'
          },
          { db }
        );
      },
      /Unknown field "unrecognized_property"/i
    );

    const app = getApplicationBySlug('prod-nextjs-site', { db });
    assert.throws(
      () => {
        updateApplication(app.id, { rogue_field: 123 }, { db });
      },
      /Unknown field "rogue_field"/i
    );
  });

  // ── 15. Immutable Fields Cannot Be Changed ─────────────────────────
  await t.test('15. Immutable fields (id, created_at, active_release_id) cannot be changed', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const app = getApplicationBySlug('prod-nextjs-site', { db });

    assert.throws(
      () => {
        updateApplication(app.id, { id: 'new-id-xyz' }, { db });
      },
      /Field "id" is immutable/i
    );

    assert.throws(
      () => {
        updateApplication(app.id, { created_at: '2020-01-01' }, { db });
      },
      /Field "created_at" is immutable/i
    );

    assert.throws(
      () => {
        updateApplication(app.id, { active_release_id: 'rel_fake' }, { db });
      },
      /Field "active_release_id" is immutable/i
    );
  });

  // ── 16. Created Timestamp Remains Unchanged ────────────────────────
  await t.test('16. Created timestamp remains unchanged across updates', async () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const before = getApplicationBySlug('docs-portal', { db });
    const originalCreatedAt = before.created_at;

    // Small delay to ensure timestamp resolution
    await new Promise((resolve) => setTimeout(resolve, 20));

    const updated = updateApplication(before.id, { branch: 'v2-docs' }, { db });
    assert.equal(updated.created_at, originalCreatedAt, 'created_at must not change upon update');
  });

  // ── 17. Updated Timestamp Changes Appropriately ───────────────────
  await t.test('17. Updated timestamp is present and valid after modification', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const app = getApplicationBySlug('docs-portal', { db });
    assert.ok(app.updated_at);
  });

  // ── 18. Records Survive Database Close/Reopen ──────────────────────
  await t.test('18. Records survive database close and reopen cycle', () => {
    closeDatabase();
    assert.equal(isOpen(), false);

    // Reopen using same path
    const reopenedDb = getDatabase({ dbPath: tempDbPath });
    assert.equal(isOpen(), true);

    const app = getApplicationBySlug('prod-nextjs-site', { db: reopenedDb });
    assert.ok(app, 'Application must be present after reopening');
    assert.equal(app.name, 'Production Next.js Website');
    assert.equal(app.port, 3000);
  });

  // ── 19. Parameterized Queries Prevent SQL Injection ────────────────
  await t.test('19. Parameterized queries prevent SQL injection in name or slug', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const maliciousPayload = "'; DROP TABLE applications; --";

    const app = createApplication(
      {
        name: maliciousPayload,
        slug: 'sql-injection-test',
        repo_url: 'https://github.com/org/repo.git'
      },
      { db }
    );

    assert.equal(app.name, maliciousPayload);

    // Verify applications table still exists and was not dropped
    const count = db.prepare('SELECT COUNT(*) as c FROM applications').get().c;
    assert.ok(count >= 1, 'Table must remain intact after injection payload');
  });

  // ── 20. No Credentials Appear in Responses or Errors ───────────────
  await t.test('20. No credentials appear in service responses or errors', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const app = getApplicationBySlug('prod-nextjs-site', { db });

    const json = JSON.stringify(app);
    assert.ok(!json.includes('password'));
    assert.ok(!json.includes('token'));
    assert.ok(!json.includes('secret'));
  });

  // ── 21. WAL Synchronous Mode FULL is Active ────────────────────────
  await t.test('21. Active connection reports PRAGMA synchronous = 2 (FULL)', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const synchronousMode = db.pragma('synchronous', { simple: true });
    assert.equal(synchronousMode, 2, 'PRAGMA synchronous must report mode 2 (FULL) for maximal durability');

    const journalMode = db.pragma('journal_mode', { simple: true });
    assert.equal(journalMode.toLowerCase(), 'wal', 'journal_mode must remain WAL');
  });

  // ── 22. Legacy deployments.json Remains Untouched ──────────────────
  await t.test('22. Legacy deployments.json remains untouched throughout service operations', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent);
    }
  });

  // ── 23. Path Resolution Stability (Section 3C) ─────────────────────
  await t.test('23. Database path resolution is stable across different working directories', () => {
    const defaultPath = getDatabasePath();
    assert.ok(defaultPath.endsWith('backend/data/kpanel.db') || defaultPath.endsWith('backend/data/kpanel.db'.replace(/\//g, path.sep)));

    // Override via KPANEL_DB_PATH
    process.env.KPANEL_DB_PATH = '/custom/path/to/my-kpanel.db';
    const overridden = getDatabasePath();
    assert.equal(overridden, path.resolve('/custom/path/to/my-kpanel.db'));
    delete process.env.KPANEL_DB_PATH;
  });
});
