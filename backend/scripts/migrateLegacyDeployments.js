#!/usr/bin/env node

/**
 * Separately Authorized Legacy Deployments Import Utility
 *
 * Imports eligible legacy deployment records from backend/data/deployments.json
 * into the SQLite applications table.
 *
 * CRITICAL SAFETY CONTRACT:
 * 1. NEVER runs on server startup or automatic background jobs.
 * 2. NEVER deletes or modifies backend/data/deployments.json.
 * 3. Strictly idempotent: re-running does not create duplicate applications or fail.
 * 4. Supports --dry-run for complete pre-execution impact assessment.
 * 5. Supports --rollback to revert imported records cleanly.
 */

const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../config/database');

const DEFAULT_DEPLOYMENTS_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

/**
 * Sanitizes an application name into a valid, unique slug.
 */
function slugify(name, fallbackId) {
  if (!name || typeof name !== 'string') {
    return `legacy-app-${fallbackId || Math.random().toString(36).substring(2, 8)}`;
  }
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || `legacy-app-${fallbackId || Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Analyzes legacy records and plans import operations without mutating anything.
 */
function planLegacyImport(options = {}) {
  const deploymentsFile = options.deploymentsPath || DEFAULT_DEPLOYMENTS_PATH;
  const db = options.db || getDatabase({ dbPath: options.dbPath });

  if (!fs.existsSync(deploymentsFile)) {
    return {
      status: 'SOURCE_NOT_FOUND',
      deploymentsPath: deploymentsFile,
      totalLegacyRecords: 0,
      eligibleToImport: [],
      alreadyImported: [],
      incompatibleRecords: [],
      summary: 'Legacy deployments.json file does not exist.'
    };
  }

  let rawDeployments = [];
  try {
    const rawContent = fs.readFileSync(deploymentsFile, 'utf8');
    rawDeployments = JSON.parse(rawContent);
    if (!Array.isArray(rawDeployments)) {
      rawDeployments = [];
    }
  } catch (err) {
    throw new Error(`Failed to parse legacy deployments JSON: ${err.message}`);
  }

  // Fetch existing SQLite applications
  const existingApps = db.prepare('SELECT id, slug, repo_url FROM applications').all();
  const existingIds = new Set(existingApps.map((a) => a.id));
  const existingSlugs = new Set(existingApps.map((a) => a.slug));

  const eligibleToImport = [];
  const alreadyImported = [];
  const incompatibleRecords = [];

  for (const dep of rawDeployments) {
    const legacyId = dep.id || dep._id;
    if (!legacyId) {
      incompatibleRecords.push({
        record: dep,
        reason: 'Missing unique identifier'
      });
      continue;
    }

    // Determine application name and slug
    const name = dep.name || dep.containerName || `App ${legacyId.substring(0, 8)}`;
    let slug = slugify(name, legacyId.substring(0, 8));

    // Check if already imported
    if (existingIds.has(legacyId) || existingSlugs.has(slug)) {
      alreadyImported.push({
        id: legacyId,
        name,
        slug,
        reason: existingIds.has(legacyId) ? 'ID already exists in SQLite' : 'Slug already exists in SQLite'
      });
      continue;
    }

    // Determine repository URL (blueprint vs git repo)
    let repoUrl = dep.repoUrl;
    let buildType = 'dockerfile';
    if (!repoUrl) {
      if (dep.type && (dep.composeDir || dep.template)) {
        // Blueprint deployment without external git repository
        repoUrl = `local://blueprints/${dep.type.toLowerCase()}`;
        buildType = 'compose';
      } else {
        incompatibleRecords.push({
          record: dep,
          reason: 'No repoUrl or blueprint type specified'
        });
        continue;
      }
    }

    const targetPort = parseInt(dep.port, 10) || 3000;
    const branch = dep.branch || 'main';
    const domain = dep.domain || null;
    const createdAt = dep.createdAt || dep.deployedAt || new Date().toISOString();

    eligibleToImport.push({
      id: legacyId,
      name,
      slug,
      repo_url: repoUrl,
      branch,
      build_type: buildType,
      build_path: '/',
      port: targetPort,
      domain,
      cpu_limit: 1.0,
      memory_limit_mb: 1024,
      created_at: createdAt
    });
  }

  return {
    status: 'READY',
    deploymentsPath: deploymentsFile,
    totalLegacyRecords: rawDeployments.length,
    eligibleToImport,
    alreadyImported,
    incompatibleRecords,
    summary: `Found ${rawDeployments.length} legacy records: ${eligibleToImport.length} eligible, ${alreadyImported.length} already in SQLite, ${incompatibleRecords.length} incompatible.`
  };
}

/**
 * Executes the planned import transactionally.
 * Idempotent: Skips existing records and only inserts unmigrated records.
 */
function executeLegacyImport(options = {}) {
  const db = options.db || getDatabase({ dbPath: options.dbPath });
  const plan = planLegacyImport(options);

  if (plan.eligibleToImport.length === 0) {
    return {
      status: 'NO_CHANGES',
      importedCount: 0,
      plan
    };
  }

  const insertStmt = db.prepare(`
    INSERT INTO applications (
      id, name, slug, repo_url, branch, build_type, build_path,
      port, domain, cpu_limit, memory_limit_mb, created_at, updated_at
    ) VALUES (
      @id, @name, @slug, @repo_url, @branch, @build_type, @build_path,
      @port, @domain, @cpu_limit, @memory_limit_mb, @created_at, CURRENT_TIMESTAMP
    )
  `);

  const importTx = db.transaction((records) => {
    let count = 0;
    for (const record of records) {
      insertStmt.run(record);
      count++;
    }
    return count;
  });

  const importedCount = importTx(plan.eligibleToImport);

  return {
    status: 'COMPLETED',
    importedCount,
    plan
  };
}

/**
 * Rollback utility: deletes applications that were imported from legacy records.
 */
function rollbackLegacyImport(options = {}) {
  const db = options.db || getDatabase({ dbPath: options.dbPath });
  const deploymentsFile = options.deploymentsPath || DEFAULT_DEPLOYMENTS_PATH;

  if (!fs.existsSync(deploymentsFile)) {
    return { status: 'NOOP', deletedCount: 0 };
  }

  const rawDeployments = JSON.parse(fs.readFileSync(deploymentsFile, 'utf8') || '[]');
  const legacyIds = rawDeployments.map((d) => d.id || d._id).filter(Boolean);

  if (legacyIds.length === 0) {
    return { status: 'NOOP', deletedCount: 0 };
  }

  const deleteStmt = db.prepare('DELETE FROM applications WHERE id = ?');
  const rollbackTx = db.transaction((ids) => {
    let deleted = 0;
    for (const id of ids) {
      const res = deleteStmt.run(id);
      if (res.changes > 0) deleted++;
    }
    return deleted;
  });

  const deletedCount = rollbackTx(legacyIds);
  return {
    status: 'COMPLETED',
    deletedCount
  };
}

// CLI Execution entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || (!args.includes('--execute') && !args.includes('--rollback'));
  const isRollback = args.includes('--rollback');
  const isExecute = args.includes('--execute');

  try {
    if (isRollback) {
      console.log('--- EXECUTING ROLLBACK OF LEGACY IMPORT ---');
      const res = rollbackLegacyImport();
      console.log(`Rollback completed. Deleted ${res.deletedCount} imported application records from SQLite.`);
      process.exit(0);
    }

    if (isDryRun) {
      console.log('--- LEGACY DEPLOYMENTS IMPORT DRY-RUN ---');
      const plan = planLegacyImport();
      console.log(plan.summary);
      console.log('Eligible records to import:', plan.eligibleToImport);
      console.log('Already imported:', plan.alreadyImported);
      console.log('Incompatible records:', plan.incompatibleRecords);
      console.log('\nRun with --execute to commit these changes to SQLite.');
      process.exit(0);
    }

    if (isExecute) {
      console.log('--- EXECUTING AUTHORIZED LEGACY IMPORT ---');
      const res = executeLegacyImport();
      console.log(`Execution result: ${res.status}. Successfully imported ${res.importedCount} application records into SQLite.`);
      process.exit(0);
    }
  } catch (err) {
    console.error(`Import failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  planLegacyImport,
  executeLegacyImport,
  rollbackLegacyImport,
  slugify
};
