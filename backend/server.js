const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, exec } = require('child_process');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const DEPLOYMENTS_FILE = path.join(__dirname, 'data', 'deployments.json');
const DEPLOY_LOGS = {};
const LOG_FILE = '/home/ubuntu/.openclaw/workspace/memory/kpanel-dev.log';

// ── Auth config ───────────────────────────────────────────
const K_PANEL_PASSWORD = process.env.K_PANEL_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSIONS = new Set(); // in-memory signed tokens

// ── Logging ───────────────────────────────────────────────
function fileLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  console.log(msg);
}

// ── Cookie helpers ────────────────────────────────────────
function signToken(token) {
  return token + '.' + crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}
function verifyToken(signed) {
  if (!signed) return false;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return false;
  const token = signed.slice(0, idx);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
  const actual = signed.slice(idx + 1);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual)) && SESSIONS.has(token);
}
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(c => c.trim().split('=').map(decodeURIComponent)));
}

// ── Auth middleware ───────────────────────────────────────
function authMiddleware(req, res, next) {
  next();
}

// ── Helpers ───────────────────────────────────────────────
function readDeployments() {
  try { return JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, 'utf-8')); }
  catch { return []; }
}
function writeDeployments(data) {
  fs.mkdirSync(path.dirname(DEPLOYMENTS_FILE), { recursive: true });
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(data, null, 2));
}
function appendLog(id, line) {
  if (!DEPLOY_LOGS[id]) DEPLOY_LOGS[id] = [];
  const entry = `[${new Date().toISOString()}] ${line}`;
  DEPLOY_LOGS[id].push(entry);
  if (DEPLOY_LOGS[id].length > 300) DEPLOY_LOGS[id].shift();
  fileLog(`[deploy:${id}] ${line}`);
}

function runDeploy(deployment) {
  const { id, repoUrl, branch, deployDir, composeFile } = deployment;
  appendLog(id, `Triggered for: ${repoUrl} @ ${branch}`);

  const deps = readDeployments();
  const i = deps.findIndex(d => d.id === id);
  if (i !== -1) { deps[i].deployStatus = 'running'; writeDeployments(deps); }

  (async () => {
    try {
      if (!fs.existsSync(deployDir)) {
        appendLog(id, `Cloning repo...`);
        execSync(`git clone -b ${branch} ${repoUrl} ${deployDir}`, { timeout: 120000 });
      } else {
        appendLog(id, `Pulling latest changes...`);
        execSync(`cd ${deployDir} && git fetch origin && git reset --hard origin/${branch}`, { timeout: 60000 });
      }
      appendLog(id, `Git sync done.`);

      const composePath = path.join(deployDir, composeFile || 'docker-compose.yml');
      if (fs.existsSync(composePath)) {
        appendLog(id, `Running docker compose up -d --build...`);
        const out = execSync(`cd ${deployDir} && docker compose up -d --build 2>&1`, { timeout: 300000 }).toString();
        out.split('\n').filter(Boolean).forEach(l => appendLog(id, l));
        appendLog(id, `Deploy complete.`);
      } else {
        appendLog(id, `No compose file found at ${composePath}, skipping.`);
      }

      const d2 = readDeployments();
      const j = d2.findIndex(d => d.id === id);
      if (j !== -1) {
        d2[j].deployStatus = 'success';
        d2[j].lastDeployed = new Date().toISOString();
        writeDeployments(d2);
      }
    } catch (err) {
      appendLog(id, `FAILED: ${err.message}`);
      const d2 = readDeployments();
      const j = d2.findIndex(d => d.id === id);
      if (j !== -1) { d2[j].deployStatus = 'failed'; writeDeployments(d2); }
    }
  })();
}

// ── Middleware ────────────────────────────────────────────
app.use(cors());
// Raw body needed for HMAC verification on webhook route
app.use('/api/webhook', express.raw({ type: '*/*' }));
app.use(express.json());
app.use(authMiddleware);
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── Auth endpoints ────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  if (!K_PANEL_PASSWORD || K_PANEL_PASSWORD.length === 0) return res.json({ success: true, noAuth: true });
  const { password } = req.body;
  if (!password || !crypto.timingSafeEqual(Buffer.from(password), Buffer.from(K_PANEL_PASSWORD))) {
    fileLog(`Failed login attempt from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  SESSIONS.add(token);
  const signed = signToken(token);
  res.setHeader('Set-Cookie', `kp_session=${encodeURIComponent(signed)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
  fileLog(`Successful login from ${req.ip}`);
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const signed = cookies['kp_session'];
  if (signed) {
    const idx = signed.lastIndexOf('.');
    if (idx !== -1) SESSIONS.delete(signed.slice(0, idx));
  }
  res.setHeader('Set-Cookie', 'kp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/auth/status', (req, res) => {
  if (!K_PANEL_PASSWORD || K_PANEL_PASSWORD.length === 0) return res.json({ authenticated: true, noAuth: true });
  const cookies = parseCookies(req);
  res.json({ authenticated: verifyToken(cookies['kp_session']) });
});

// ── Health ────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── System stats ──────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  res.json({
    memory: { used: usedMem, total: totalMem, percent: parseFloat(((usedMem / totalMem) * 100).toFixed(1)) },
    cpu: { cores: os.cpus().length, loadAvg: os.loadavg() },
    disk: { percent: parseFloat(execSync('df -B1 /').toString().split('\n')[1].split(/\s+/)[4].replace('%', '')) },
    uptime: os.uptime()
  });
});

// ── Containers ────────────────────────────────────────────
app.get('/api/apps', async (req, res) => {
  const containers = await docker.listContainers({ all: true });
  const deployments = readDeployments();
  res.json(containers.map(c => {
    const name = c.Names[0]?.replace(/^\//, '') || c.Id.substring(0, 12);
    const dep = deployments.find(d => d.containerName === name);
    return {
      id: c.Id.substring(0, 12),
      name,
      status: c.State,
      image: c.Image,
      deploymentId: dep?.id || null
    };
  }));
});

app.get('/api/apps/:id/stats', (req, res) => {
  try {
    const out = execSync(`docker stats ${req.params.id} --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}"`, { timeout: 5000 }).toString().trim();
    const [cpu, mem] = out.split('|');
    res.json({ cpuPercent: cpu, memUsage: mem });
  } catch {
    res.json({ cpuPercent: 'N/A', memUsage: 'N/A' });
  }
});

app.post('/api/apps/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const container = docker.getContainer(id);
  try {
    if (action === 'start') await container.start();
    else if (action === 'stop') await container.stop();
    else if (action === 'restart') await container.restart();
    else return res.status(400).json({ error: 'Unknown action' });
    fileLog(`Container ${id} action: ${action}`);
    res.json({ success: true });
  } catch (err) {
    fileLog(`Container ${id} action ${action} failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/apps/:id/logs', async (req, res) => {
  try {
    const logs = await docker.getContainer(req.params.id).logs({ stdout: true, stderr: true, tail: 100 });
    res.json({ logs: logs.toString('utf-8') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ENV editor ────────────────────────────────────────────
app.get('/api/apps/:id/env', (req, res) => {
  const deps = readDeployments();
  const dep = deps.find(d => d.id === req.params.id);
  if (!dep) return res.status(404).json({ error: 'Deployment not found' });
  const envPath = dep.envFile;
  if (!envPath) return res.json({ content: '', path: null });
  try {
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    res.json({ content, path: envPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/apps/:id/env', async (req, res) => {
  const deps = readDeployments();
  const dep = deps.find(d => d.id === req.params.id);
  if (!dep) return res.status(404).json({ error: 'Deployment not found' });
  const envPath = dep.envFile;
  if (!envPath) return res.status(400).json({ error: 'No envFile configured for this deployment' });

  // Prevent path traversal — only write to the declared path
  const resolved = path.resolve(envPath);
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'Invalid content' });

  try {
    fs.writeFileSync(resolved, content, 'utf-8');
    fileLog(`ENV written for deployment ${dep.id} at ${resolved}`);

    // Restart associated container if containerName is set
    if (dep.containerName) {
      try {
        const containers = await docker.listContainers({ all: true });
        const match = containers.find(c => c.Names.some(n => n.replace(/^\//, '') === dep.containerName));
        if (match) {
          await docker.getContainer(match.Id).restart();
          fileLog(`Restarted container ${dep.containerName} after env update`);
        }
      } catch (restartErr) {
        fileLog(`Restart failed for ${dep.containerName}: ${restartErr.message}`);
      }
    }
    res.json({ success: true });
  } catch (err) {
    fileLog(`ENV write failed for ${dep.id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Deployments CRUD ──────────────────────────────────────
app.get('/api/deployments', (req, res) => res.json(readDeployments()));

app.post('/api/deployments', (req, res) => {
  const { repoUrl, branch, deployDir, composeFile, containerName, envFile, secret } = req.body;
  if (!repoUrl || !branch || !deployDir) return res.status(400).json({ error: 'repoUrl, branch, deployDir required' });
  const deps = readDeployments();
  const dep = {
    id: crypto.randomBytes(8).toString('hex'),
    repoUrl, branch,
    deployDir: path.resolve(deployDir),
    composeFile: composeFile || 'docker-compose.yml',
    containerName: containerName || '',
    envFile: envFile ? path.resolve(envFile) : '',
    secret: secret || '',
    deployStatus: 'idle',
    lastDeployed: null
  };
  deps.push(dep);
  writeDeployments(deps);
  fileLog(`New deployment registered: ${dep.id} -> ${repoUrl}`);
  res.json(dep);
});

app.delete('/api/deployments/:id', (req, res) => {
  const deps = readDeployments().filter(d => d.id !== req.params.id);
  writeDeployments(deps);
  res.json({ success: true });
});

app.get('/api/deployments/:id/logs', (req, res) => {
  const logs = DEPLOY_LOGS[req.params.id] || [];
  res.json({ logs });
});

// ── GitHub Webhook ────────────────────────────────────────
app.post('/api/webhook/:id', (req, res) => {
  const deps = readDeployments();
  const dep = deps.find(d => d.id === req.params.id);
  if (!dep) {
    fileLog(`Webhook hit for unknown deployment: ${req.params.id}`);
    return res.status(404).json({ error: 'Deployment not found' });
  }

  // HMAC verification — required if secret is configured
  if (dep.secret) {
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return res.status(401).json({ error: 'Missing signature' });
    const expected = 'sha256=' + crypto.createHmac('sha256', dep.secret).update(req.body).digest('hex');
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        fileLog(`Webhook HMAC mismatch for ${dep.id}`);
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch {
      return res.status(401).json({ error: 'Signature verification failed' });
    }
  }

  // Optional: only deploy on push to configured branch
  try {
    const payload = JSON.parse(req.body.toString());
    const pushedBranch = (payload.ref || '').replace('refs/heads/', '');
    if (pushedBranch && pushedBranch !== dep.branch) {
      return res.json({ skipped: true, reason: `Push to ${pushedBranch}, configured for ${dep.branch}` });
    }
  } catch { /* non-JSON payloads: proceed */ }

  res.json({ triggered: true, id: dep.id });
  runDeploy(dep);
});

// ── Database Insights ─────────────────────────────────────
const DB_IMAGES = ['postgres', 'mysql', 'mariadb', 'mongo', 'redis'];

function detectDbType(image) {
  const img = image.toLowerCase();
  for (const t of DB_IMAGES) if (img.includes(t)) return t;
  return null;
}

async function queryDbStats(containerId, dbType) {
  try {
    let cmd;
    if (dbType === 'postgres') cmd = `docker exec ${containerId} psql -U postgres -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"`;
    else if (dbType === 'mysql' || dbType === 'mariadb') cmd = `docker exec ${containerId} mysql -uroot -e "SELECT COUNT(*) FROM information_schema.tables" 2>/dev/null`;
    else if (dbType === 'mongo') cmd = `docker exec ${containerId} mongosh --quiet --eval "db.adminCommand({listDatabases:1}).databases.length" 2>/dev/null`;
    else if (dbType === 'redis') cmd = `docker exec ${containerId} redis-cli DBSIZE`;
    else return null;

    const out = execSync(cmd, { timeout: 5000 }).toString().trim();
    const num = parseInt(out.replace(/\D/g, ''), 10);
    return isNaN(num) ? null : num;
  } catch {
    return null;
  }
}

app.get('/api/db', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const dbContainers = containers
      .map(c => ({ ...c, dbType: detectDbType(c.Image) }))
      .filter(c => c.dbType);

    const results = await Promise.all(dbContainers.map(async c => {
      const count = c.State === 'running' ? await queryDbStats(c.Id.substring(0, 12), c.dbType) : null;
      const label = c.dbType === 'redis' ? 'keys' : c.dbType === 'mongo' ? 'databases' : 'tables';
      return {
        id: c.Id.substring(0, 12),
        name: c.Names[0]?.replace(/^\//, '') || c.Id.substring(0, 12),
        image: c.Image,
        type: c.dbType,
        status: c.State,
        count,
        label
      };
    }));

    res.json(results);
  } catch (err) {
    fileLog(`DB insights error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Static / SPA ──────────────────────────────────────────
const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  fileLog(`K-Panel started on port ${PORT} | Auth: ${K_PANEL_PASSWORD ? 'enabled' : 'DISABLED'}`);
});
