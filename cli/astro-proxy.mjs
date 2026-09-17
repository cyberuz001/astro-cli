/**
 * astro-proxy.mjs - Self-contained Proxy for astro CLI
 * Directly connects to Google Cloud Code (Antigravity) API
 * NO OmniRoute dependency required!
 * 
 * Flow: astro CLI -> proxy (localhost:5544) -> Google Cloud Code API
 */
import { createServer, request as httpRequest } from 'http';
import https from 'https';
import crypto from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ========================================================================
// Configuration
// ========================================================================

const PROXY_PORT = 5544;
const CLOUD_CODE_BASE = 'https://daily-cloudcode-pa.googleapis.com';
const CLOUD_CODE_STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse';
const _b64d = (s) => Buffer.from(s, 'base64').toString('utf8');
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || _b64d('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==');
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || _b64d('R0NDU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=');
const OMNIROUTE_DB_PATH = process.env.HOME?.replace(/\\/g,'/') + '/.omniroute/storage.sqlite' 
  || 'C:/Users/user/.omniroute/storage.sqlite';

// Encryption config (from OmniRoute's .env)
const STORAGE_ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY || _b64d('YWQxYWZhMDMyZDc1YjFkOGZhODkwMTQ4ZTNjNjdmYmU3YTk2Y2ZkZjgwZjZhMjdlMjZlNjRhNmQ3NjRlNzdhYw==');
const ENC_PREFIX = 'enc:v1:';
const STATIC_SALT = 'omniroute-field-encryption-v1';

// Model mapping: astro name -> Gemini model (dynamic, auto-synced with central registry)
const DEFAULT_BACKEND_MAP = {
  'vortex':     'claude-opus-4-6-thinking',
  'nebula-high':'gemini-pro-agent',
  'nebula':     'gemini-3.1-pro-low',
  'photon-3.8': 'gemini-3.8-flash-high',
  'photon-3.7': 'gemini-3.7-flash-high'
};

let MODEL_MAP = { ...DEFAULT_BACKEND_MAP };
let MODELS_METADATA = {
  'vortex':      { name: 'vortex', context_window: 1000000, badge: 'FLAGSHIP / MOST POWERFUL' },
  'nebula-high': { name: 'nebula-high', context_window: 200000, badge: 'HEAVY AGENTIC' },
  'nebula':      { name: 'nebula', context_window: 200000, badge: 'BALANCED DAILY DRIVER' },
  'photon-3.8':  { name: 'photon-3.8', context_window: 128000, badge: 'NEW / SUB-30MS' },
  'photon-3.7':  { name: 'photon-3.7', context_window: 128000, badge: 'LOW LATENCY' },
};

// Auto-discover and sync models from central registry & Antigravity API
const MODELS_CACHE_FILE = (process.env.USERPROFILE || process.env.HOME || '') + '/.astro/proxy-models-cache.json';

function geminiToAstroName(geminiId) {
  const flashMatch = geminiId.match(/gemini-(\d+\.\d+)-flash/);
  if (flashMatch) return `photon-${flashMatch[1]}`;
  
  const proMatch = geminiId.match(/gemini-(\d+\.\d+)-pro/);
  if (proMatch) return `nebula-${proMatch[1]}`;
  
  const claudeMatch = geminiId.match(/claude-(.*)/);
  if (claudeMatch) return `vortex-${claudeMatch[1]}`;
  
  return geminiId;
}

async function fetchAndUpdateModels() {
  try {
    // 1. Sync with central registry (https://astro-cli.vercel.app/api/models or raw github)
    const registryUrls = [
      'https://astro-cli.vercel.app/api/models',
      'https://raw.githubusercontent.com/cyberuz001/astro-cli/main/cli/models.json'
    ];
    let registryModels = null;
    for (const url of registryUrls) {
      try {
        const u = new URL(url);
        const data = await new Promise((resolve, reject) => {
          const req = https.get(url, { headers: { 'User-Agent': 'astro-proxy/1.0' }, timeout: 5000 }, (res) => {
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        });
        const list = Array.isArray(data) ? data : (Array.isArray(data?.models) ? data.models : null);
        if (list && list.length > 0) {
          registryModels = list;
          break;
        }
      } catch (e) {}
    }

    if (registryModels && Array.isArray(registryModels) && registryModels.length > 0) {
      const nextMap = {};
      const nextMeta = {};

      for (const m of registryModels) {
        const id = m.id;
        if (!id) continue;
        const backend = m.backend || DEFAULT_BACKEND_MAP[id] || (
          id.includes('vortex') ? 'claude-opus-4-6-thinking' :
          id.includes('nebula') ? (id.includes('high') ? 'gemini-pro-agent' : 'gemini-3.1-pro-low') :
          id.includes('3.8') ? 'gemini-3.8-flash-high' :
          id.includes('3.7') ? 'gemini-3.7-flash-high' :
          'gemini-3.8-flash-high'
        );
        nextMap[id] = backend;
        nextMeta[id] = {
          name: m.name || id,
          context_window: id.includes('vortex') ? 1000000 : id.includes('nebula') ? 200000 : 128000,
          badge: m.badge,
          speed: m.speed,
          desc: m.desc
        };
      }

      // Replaces model map strictly with central registry models (removes deleted, adds new)
      MODEL_MAP = nextMap;
      MODELS_METADATA = nextMeta;

      try {
        const { writeFileSync: wfs } = await import('fs');
        wfs(MODELS_CACHE_FILE, JSON.stringify({ MODEL_MAP, MODELS_METADATA }, null, 2));
      } catch (e) {}

      console.log(`[proxy] Synced ${Object.keys(MODEL_MAP).length} active models from central registry: ${Object.keys(MODEL_MAP).join(', ')}`);
    }

    // 2. Also check Antigravity API for any newly discovered models if credential is active
    if (credential?.accessToken) {
      const token = credential.accessToken;
      const projectId = credential.projectId || 'core-shell-4d9t3';
      const body = JSON.stringify({ project: projectId, userAgent: 'antigravity' });
      const data = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'daily-cloudcode-pa.googleapis.com',
          path: '/v1internal:fetchAvailableModels',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'antigravity/ide/2024.2.1 darwin/arm64',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 5000
        }, (res) => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.write(body); req.end();
      });

      const models = data.models || data.availableModels || [];
      if (Array.isArray(models)) {
        for (const m of models) {
          const id = m.name || m.model || m.id || m;
          if (typeof id !== 'string') continue;
          const astroName = geminiToAstroName(id);
          if (!MODEL_MAP[astroName] && (astroName.startsWith('photon-') || astroName.startsWith('nebula-') || astroName.startsWith('vortex-'))) {
            MODEL_MAP[astroName] = id;
            console.log(`[proxy] Auto-discovered new model: ${astroName} -> ${id}`);
          }
        }
      }
    }
  } catch (e) {
    console.log('[proxy] Model sync info:', e.message);
  }
}

// Load cached models on startup
try {
  const { existsSync: es, readFileSync: rfs } = await import('fs');
  if (es(MODELS_CACHE_FILE)) {
    const cached = JSON.parse(rfs(MODELS_CACHE_FILE, 'utf8'));
    if (cached.MODEL_MAP) {
      MODEL_MAP = cached.MODEL_MAP;
      MODELS_METADATA = cached.MODELS_METADATA || {};
    } else {
      MODEL_MAP = { ...MODEL_MAP, ...cached };
    }
    console.log(`[proxy] Loaded ${Object.keys(MODEL_MAP).length} models from cache`);
  }
} catch(e) {}

// Auto-refresh models every 60 seconds
setInterval(() => { fetchAndUpdateModels(); }, 60 * 1000);

const ASTRO_IDENTITY = `You are astro, an interactive assistant created by astro. Your primary purpose is to help users with programming, writing code, and performing tasks on their computer system. You use advanced AI models like vortex or nebula depending on the request. IMPORTANT: You must NEVER identify yourself as Gemini, Google, Claude, Anthropic, GPT, OpenAI, or any other AI. You are astro, made by astro. Always refer to yourself as "astro" (lowercase). CRITICAL PROHIBITION: NEVER start your messages with self-introductions such as "Men Astro Agent - ...", "I am Astro...", or listing your capabilities. Do NOT recite boilerplate introductory speeches. Immediately answer the user's prompt or question directly, naturally, and concisely.`;

// ========================================================================
// Encryption (replicate OmniRoute's AES-256-GCM)
// ========================================================================

let _staticKey = null;
function getStaticKey() {
  if (_staticKey) return _staticKey;
  _staticKey = crypto.scryptSync(STORAGE_ENCRYPTION_KEY, STATIC_SALT, 32);
  return _staticKey;
}

function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  if (!ciphertext.startsWith(ENC_PREFIX)) return ciphertext;
  
  const body = ciphertext.slice(ENC_PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) return null;
  
  const [ivHex, encryptedHex, authTagHex] = parts;
  try {
    const key = getStaticKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('[proxy] Decrypt failed:', e.message);
    return null;
  }
}

// ========================================================================
// Credential Management - Self-contained (NO OmniRoute dependency)
// Stores credentials in ~/.astro/auth.json
// ================================================================


const HOME_DIR = process.env.USERPROFILE || process.env.HOME || 'C:/Users/user';
const ASTRO_DIR = path.join(HOME_DIR, '.astro');
const AUTH_FILE = path.join(ASTRO_DIR, 'proxy-auth.json');
const ONBOARD_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser';
const OAUTH2_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/cloud-platform',
].join(' ');

let credential = null;
let loginInProgress = false;
let loginWaiters = [];

function ensureAstroDir() {
  if (!existsSync(ASTRO_DIR)) mkdirSync(ASTRO_DIR, { recursive: true });
}

function saveCredential() {
  ensureAstroDir();
  writeFileSync(AUTH_FILE, JSON.stringify({
    email: credential.email,
    refresh_token: credential.refreshToken,
    access_token: credential.accessToken,
    project_id: credential.projectId,
    expires_at: credential.expiresAt?.toISOString(),
  }, null, 2));
}

function loadCredential() {
  try {
    if (!existsSync(AUTH_FILE)) return false;
    const data = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
    if (!data.refresh_token) return false;
    credential = {
      email: data.email || 'unknown',
      accessToken: data.access_token || null,
      refreshToken: data.refresh_token,
      projectId: data.project_id || 'core-shell-4d9t3',
      expiresAt: data.expires_at ? new Date(data.expires_at) : new Date(0),
    };
    console.log(`[proxy] Loaded credentials for ${credential.email} (project: ${credential.projectId})`);
    return true;
  } catch (e) {
    console.error('[proxy] Failed to load proxy-auth.json:', e.message);
    return false;
  }
}

// Also try loading from OmniRoute DB as a migration path
function tryLoadFromOmniRoute() {
  try {
    const dbPath = 'C:/Users/user/.omniroute/storage.sqlite';
    if (!existsSync(dbPath)) return false;
    const betterSqlitePath = 'C:/Users/user/.omniroute/runtime/node_modules/better-sqlite3';
    if (!existsSync(betterSqlitePath)) return false;
    const Database = require(betterSqlitePath);
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT * FROM provider_connections WHERE provider IN ('antigravity', 'agy') AND is_active = 1 AND refresh_token IS NOT NULL ORDER BY test_status = 'active' DESC"
    ).all();
    db.close();
    if (rows.length === 0) return false;
    const r = rows[0];
    const rt = decrypt(r.refresh_token);
    if (!rt) return false;
    credential = {
      email: r.email || r.name || 'omniroute-migrated',
      accessToken: decrypt(r.access_token),
      refreshToken: rt,
      projectId: r.project_id,
      expiresAt: r.expires_at ? new Date(r.expires_at) : new Date(0),
    };
    saveCredential();
    console.log(`[proxy] Migrated credentials from OmniRoute for ${credential.email}`);
    return true;
  } catch (e) {
    console.log('[proxy] OmniRoute migration not available:', e.message);
    return false;
  }
}

// -- Browser-based Google OAuth2 Login Flow --
async function startOAuth2Login() {
  if (loginInProgress) {
    return new Promise((resolve, reject) => loginWaiters.push({ resolve, reject }));
  }
  loginInProgress = true;
  return new Promise((resolve, reject) => {
    const callbackPort = 18392;
    const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;
    const state = crypto.randomBytes(16).toString('hex');
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(OAUTH2_SCOPES)}` +
      `&access_type=offline&prompt=consent&state=${state}`;
    const callbackServer = createServer(async (cbReq, cbRes) => {
      if (!cbReq.url.startsWith('/callback')) { cbRes.writeHead(404); cbRes.end(); return; }
      const params = new URL(cbReq.url, `http://127.0.0.1:${callbackPort}`).searchParams;
      const code = params.get('code');
      if (!code || params.get('state') !== state) {
        cbRes.writeHead(400, { 'Content-Type': 'text/html' });
        cbRes.end('<html><body><h1>Login failed</h1><p>Invalid code. Try: astro login</p></body></html>');
        callbackServer.close(); loginInProgress = false;
        loginWaiters.forEach(w => w.reject(new Error('Login cancelled'))); loginWaiters = [];
        reject(new Error('OAuth callback invalid')); return;
      }
      try {
        const tokens = await exchangeCodeForTokens(code, redirectUri);
        const userInfo = await getUserInfo(tokens.access_token);
        credential = {
          email: userInfo.email || 'user',
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          projectId: null,
          expiresAt: new Date(Date.now() + (tokens.expires_in || 3599) * 1000),
        };
        try { credential.projectId = await onboardUser(tokens.access_token); } catch (e) {
          console.error('[proxy] Onboarding failed (will retry):', e.message);
        }
        saveCredential();
        cbRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        cbRes.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>astro &mdash; authenticated</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: #0B0807;
      color: #F7EBE8;
      font-family: 'Space Mono', 'Courier New', monospace;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      overflow: hidden;
      position: relative;
    }
    .grid-bg {
      position: absolute;
      inset: 0;
      background-size: 32px 32px;
      background-image: 
        linear-gradient(to right, rgba(255, 85, 30, 0.05) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255, 85, 30, 0.05) 1px, transparent 1px);
      pointer-events: none;
    }
    .glow-bg {
      position: absolute;
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, rgba(255, 85, 30, 0.14) 0%, rgba(255, 159, 28, 0.04) 40%, transparent 70%);
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      filter: blur(40px);
    }
    .pixel-card {
      position: relative;
      width: 100%;
      max-width: 460px;
      background-color: #140E0C;
      border: 1px solid #2B1D18;
      box-shadow: 6px 6px 0px 0px #060403;
      padding: 32px;
      text-align: center;
      z-index: 10;
      animation: fadeIn 0.4s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(14px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .pixel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #261B17;
      padding-bottom: 14px;
      margin-bottom: 22px;
    }
    .pixel-dots { display: flex; gap: 6px; }
    .pixel-dot { width: 8px; height: 8px; background-color: #38251F; }
    .badge {
      font-size: 10px;
      letter-spacing: 0.15em;
      color: #FF9F1C;
      background: rgba(255, 159, 28, 0.08);
      border: 1px solid rgba(255, 159, 28, 0.25);
      padding: 3px 8px;
    }
    .logo-container {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .logo-mark {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, #FF551E, #FF9F1C);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: #0B0807;
      font-size: 18px;
      box-shadow: 2px 2px 0px 0px #701A04;
    }
    .logo-text {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: 0.15em;
      color: #F7EBE8;
    }
    h2 {
      font-size: 13px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: #FF551E;
      margin-bottom: 16px;
      font-weight: 700;
    }
    .info-box {
      background-color: #0E0A08;
      border: 1px solid #221612;
      padding: 14px;
      margin-bottom: 22px;
      text-align: left;
      font-size: 12px;
      line-height: 1.8;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px dashed #1E130F;
      padding: 4px 0;
    }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: #8E7C77; text-transform: uppercase; font-size: 11px; }
    .info-value { color: #F7EBE8; font-weight: 700; word-break: break-all; }
    .status-active { color: #22C55E; display: inline-flex; align-items: center; gap: 6px; }
    .status-dot {
      width: 6px; height: 6px;
      background-color: #22C55E;
      border-radius: 50%;
      box-shadow: 0 0 8px #22C55E;
    }
    p.desc {
      color: #8E7C77;
      font-size: 12px;
      line-height: 1.6;
      margin-bottom: 22px;
    }
    .pixel-btn {
      display: block;
      width: 100%;
      background-color: #FF551E;
      color: #0B0807;
      border: 1px solid #FFA07A;
      box-shadow: 3px 3px 0px 0px #701A04;
      font-family: 'Space Mono', monospace;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      padding: 12px;
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .pixel-btn:hover {
      background-color: #FF6E38;
      transform: translate(-1px, -1px);
      box-shadow: 4px 4px 0px 0px #701A04;
    }
    .footer-note {
      margin-top: 16px;
      font-size: 10px;
      color: #5C4B47;
      letter-spacing: 0.05em;
    }
  </style>
</head>
<body>
  <div class="grid-bg"></div>
  <div class="glow-bg"></div>
  <div class="pixel-card">
    <div class="pixel-header">
      <div class="pixel-dots">
        <div class="pixel-dot"></div>
        <div class="pixel-dot"></div>
        <div class="pixel-dot"></div>
      </div>
      <div class="badge">[ AUTHENTICATED ]</div>
    </div>
    <div class="logo-container">
      <div class="logo-mark">&gt;_</div>
      <span class="logo-text">astro</span>
    </div>
    <h2>Login Successful</h2>
    <div class="info-box">
      <div class="info-row">
        <span class="info-label">Account</span>
        <span class="info-value">\${userInfo.email}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Session</span>
        <span class="info-value status-active"><span class="status-dot"></span> Active</span>
      </div>
      <div class="info-row">
        <span class="info-label">Workspace</span>
        <span class="info-value">\${credential.projectId || 'ready'}</span>
      </div>
    </div>
    <p class="desc">
      Your terminal is now connected to <strong>astro</strong>.<br>
      You can safely close this browser window.
    </p>
    <button onclick="window.close()" class="pixel-btn">RETURN TO TERMINAL</button>
    <div class="footer-note">astro &bull; autonomous agentic coding assistant</div>
  </div>
</body>
</html>`);
        callbackServer.close(); loginInProgress = false;
        loginWaiters.forEach(w => w.resolve()); loginWaiters = [];
        resolve();
        console.log(`[proxy] Login successful: ${userInfo.email} (project: ${credential.projectId})`);
      } catch (e) {
        cbRes.writeHead(500, { 'Content-Type': 'text/html' });
        cbRes.end(`<html><body><h1>Error</h1><p>${e.message}</p></body></html>`);
        callbackServer.close(); loginInProgress = false;
        loginWaiters.forEach(w => w.reject(e)); loginWaiters = [];
        reject(e);
      }
    });
    callbackServer.listen(callbackPort, '127.0.0.1', () => {
      console.log(`[proxy] Waiting for Google login...`);
      console.log(`[proxy] Login URL:\n${authUrl}\n`);
      const openCmd = process.platform === 'win32'
        ? `powershell -NoProfile -NonInteractive -Command "Start-Process '${authUrl}'"`
        : process.platform === 'darwin'
          ? `open "${authUrl}"`
          : `xdg-open "${authUrl}"`;
      try {
        exec(openCmd, (err) => {
          if (err) console.log(`[proxy] Open this URL manually in browser:\n${authUrl}`);
        });
      } catch (e) {
        console.log(`[proxy] Open this URL manually in browser:\n${authUrl}`);
      }
      setTimeout(() => {
        if (loginInProgress) {
          callbackServer.close(); loginInProgress = false;
          loginWaiters.forEach(w => w.reject(new Error('Login timeout'))); loginWaiters = [];
          reject(new Error('Login timeout (5 min). Run: astro login'));
        }
      }, 5 * 60 * 1000);
    });
    callbackServer.on('error', (err) => { loginInProgress = false; reject(err); });
  });
}

function exchangeCodeForTokens(code, redirectUri) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString();
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { const json = JSON.parse(data); if (json.error) reject(new Error(`Token exchange: ${json.error}`)); else resolve(json); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function getUserInfo(accessToken) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'www.googleapis.com', path: '/oauth2/v2/userinfo', headers: { 'Authorization': `Bearer ${accessToken}` } }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

function onboardUser(accessToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const url = new URL(ONBOARD_URL);
    const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'antigravity/ide/2024.2.1 darwin/arm64', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { try { const json = JSON.parse(data); const pid = json.projectId || json.project_id || json.name; if (pid) resolve(pid); else reject(new Error('No project ID: ' + data.substring(0, 200))); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// -- Token Refresh --
async function refreshAccessToken() {
  if (!credential?.refreshToken) throw new Error('No refresh token. Run: astro login');
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET });
    const req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'astro/1.0 proxy' } }, (res) => {
      let data = ''; res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            credential.accessToken = json.access_token;
            credential.expiresAt = new Date(Date.now() + (json.expires_in || 3599) * 1000);
            saveCredential();
            console.log(`[proxy] Token refreshed for ${credential.email}, expires: ${credential.expiresAt.toISOString()}`);
            resolve(credential.accessToken);
          } else {
            console.error('[proxy] Token refresh failed:', data);
            reject(new Error(`Token refresh failed: ${json.error || 'unknown'}`));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject); req.write(params.toString()); req.end();
  });
}

// -- Get Valid Token (auto-refresh + auto-login) --
async function getValidToken() {
  if (!credential) {
    if (!loadCredential()) {
      if (!tryLoadFromOmniRoute()) {
        console.log('[proxy] No credentials found. Starting browser login...');
        await startOAuth2Login();
      }
    }
  }
  if (!credential) throw new Error('No credentials. Run: astro login');
  if (!credential.accessToken || credential.expiresAt < new Date(Date.now() + 5 * 60 * 1000)) {
    console.log(`[proxy] Token expired for ${credential.email}, refreshing...`);
    try { await refreshAccessToken(); } catch (e) {
      console.error(`[proxy] Refresh failed: ${e.message}. Starting re-login...`);
      await startOAuth2Login();
    }
  }
  if (!credential.projectId) {
    try { credential.projectId = await onboardUser(credential.accessToken); saveCredential(); } catch (e) {
      console.error('[proxy] Onboarding failed:', e.message);
    }
  }
  return { token: credential.accessToken, projectId: credential.projectId, email: credential.email };
}

function rotateCredential() {
  console.log('[proxy] Single account mode - no rotation available');
}

// ========================================================================
// Usage Tracking
// ========================================================================

const usageTracker = {};
function trackUsage(model) {
  const now = Date.now();
  if (!usageTracker[model]) usageTracker[model] = { total: 0, hourly: [], weekly: [] };
  usageTracker[model].total++;
  usageTracker[model].hourly.push(now);
  usageTracker[model].weekly.push(now);
  const hour = 5 * 3600 * 1000;
  const week = 7 * 24 * 3600 * 1000;
  usageTracker[model].hourly = usageTracker[model].hourly.filter(t => now - t < hour);
  usageTracker[model].weekly = usageTracker[model].weekly.filter(t => now - t < week);
}

// ========================================================================
// Request Translation (OpenAI -> Gemini format)
// ========================================================================

function openaiToGemini(messages, toolNameMap) {
  const contents = [];
  let systemInstruction = null;
  
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (systemInstruction) {
        systemInstruction.parts[0].text += '\n\n' + text;
      } else {
        systemInstruction = { parts: [{ text }] };
      }
      continue;
    }
    
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    
    // Merge consecutive same-role messages
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts.push({ text });
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }
  
  // Inject astro identity into system instruction
  const identityText = ASTRO_IDENTITY;
  if (systemInstruction) {
    systemInstruction.parts[0].text = identityText + '\n\n' + systemInstruction.parts[0].text;
  } else {
    systemInstruction = { parts: [{ text: identityText }] };
  }
  
  // Strip trailing model turn (Gemini rejects it)
  while (contents.length > 1 && contents[contents.length - 1].role === 'model') {
    contents.pop();
  }
  
  return { contents, systemInstruction };
}

function buildAntigravityEnvelope(model, geminiRequest, projectId) {
  return {
    project: projectId,
    model: model,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: crypto.randomUUID(),
    request: {
      ...geminiRequest,
      generationConfig: {
        topK: 40,
        topP: 1.0,
        maxOutputTokens: 65536,
        ...(geminiRequest.generationConfig || {})
      }
    }
  };
}

// ========================================================================
// Response Translation (Gemini SSE -> OpenAI SSE)
// ========================================================================

function geminiChunkToOpenAI(data, model, chunkId, toolNameMap, reqState = { hasToolCall: false }) {
  try {
    const json = JSON.parse(data);
    const candidate = json.response?.candidates?.[0] || json.candidates?.[0];
    if (!candidate) return null;
    
    const parts = candidate.content?.parts || [];
    const chunks = [];
    
    for (const part of parts) {
      if (part.thought && typeof part.text === 'string') {
        // Thinking/reasoning content
        chunks.push({
          id: chunkId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { reasoning_content: part.text }, finish_reason: null }]
        });
      } else if (part.functionCall) {
        reqState.hasToolCall = true;
        let originalName = (typeof toolNameMap !== 'undefined' && toolNameMap instanceof Map) ? (toolNameMap.get(part.functionCall.name) || part.functionCall.name) : part.functionCall.name;
        chunks.push({
          id: chunkId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: part.functionCall.id || ('call_' + chunkId),
                type: 'function',
                function: { name: originalName, arguments: JSON.stringify(part.functionCall.args || {}) }
              }]
            },
            finish_reason: null
          }]
        });
      } else if (typeof part.text === 'string') {
        // Regular content
        chunks.push({
          id: chunkId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }]
        });
      }
    }
    
    // Check for finish
    if (candidate.finishReason) {
      const finishMap = {
        'STOP': 'stop',
        'MAX_TOKENS': 'length',
        'SAFETY': 'content_filter',
        'RECITATION': 'content_filter',
        'MALFORMED_FUNCTION_CALL': 'tool_calls',
        'UNEXPECTED_TOOL_CALL': 'tool_calls',
        'OTHER': 'stop'
      };
      
      let finish_reason = finishMap[candidate.finishReason] || candidate.finishReason?.toLowerCase() || 'stop';
      if (finish_reason === 'stop' && reqState.hasToolCall) finish_reason = 'tool_calls';
      
      // If the model aborted due to a malformed tool call, synthesize a fake tool call
      // so the client agent framework sees an explicit error rather than an empty response
      if (candidate.finishReason === 'MALFORMED_FUNCTION_CALL' || candidate.finishReason === 'UNEXPECTED_TOOL_CALL') {
        const fakeCallId = `call_${chunkId}_err`;
        chunks.push({
          id: chunkId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: fakeCallId,
                type: 'function',
                function: {
                  name: "malformed_tool_call",
                  arguments: JSON.stringify({
                    error: candidate.finishReason,
                    message: candidate.finishMessage || "Unknown error"
                  })
                }
              }]
            },
            finish_reason: null
          }]
        });
        finish_reason = 'tool_calls';
      }
      
      chunks.push({
        id: chunkId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason }],
        usage: (json.response?.usageMetadata || json.usageMetadata) ? {
          prompt_tokens: (json.response?.usageMetadata || json.usageMetadata).promptTokenCount || 0,
          completion_tokens: (json.response?.usageMetadata || json.usageMetadata).candidatesTokenCount || 0,
          total_tokens: (json.response?.usageMetadata || json.usageMetadata).totalTokenCount || 0,
        } : undefined
      });
    }
    
    return chunks;
  } catch (e) {
    console.error('[proxy] geminiChunkToOpenAI Error:', e.message, 'Data:', data.substring(0,100));
    return null;
  }
}

// ========================================================================
// Proxy Handler for chat/completions
// ========================================================================

async function handleChatCompletions(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk.toString());
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const originalModel = payload.model || 'vortex';
      let upstreamModel = MODEL_MAP[originalModel] || originalModel;
      
      trackUsage(originalModel);
      
      const { token, projectId, email } = await getValidToken();
      
      // Convert OpenAI messages to Gemini format
      const { contents, systemInstruction } = openaiToGemini(payload.messages || []);
      
      let tools = undefined;
      let toolConfig = undefined;
      const toolNameMap = new Map();
      if (Array.isArray(payload.tools) && payload.tools.length > 0) {
        const functionDeclarations = [];
        
        const blocklistKeys = [
          '$schema', '$id', '$ref', '$defs', '$comment', '$anchor',
          'default', 'additionalProperties', 'strict', 'encrypted', 'multipleOf',
          'minLength', 'maxLength', 'exclusiveMinimum', 'exclusiveMaximum', 'title',
          'anyOf', 'oneOf', 'allOf', 'not', 'const', 'examples', 'pattern',
          'minimum', 'maximum', 'uniqueItems', 'minItems', 'maxItems',
          'minProperties', 'maxProperties', 'contentMediaType', 'contentEncoding',
          'if', 'then', 'else', 'dependentRequired', 'dependentSchemas',
          'prefixItems', 'unevaluatedItems', 'unevaluatedProperties', 'deprecated',
          'patternProperties', 'propertyNames'
        ];
        
        // Blocklist-based schema cleaner for Gemini
        const cleanSchema = (obj, isPropertiesMap = false) => {
          if (Array.isArray(obj)) return obj.map(x => cleanSchema(x, false));
          if (obj !== null && typeof obj === 'object') {
            const cleaned = {};
            
            // Fix arrays in type (e.g. ["string", "null"] -> "string")
            if (!isPropertiesMap && Array.isArray(obj.type)) {
              obj.type = obj.type.find(t => t !== 'null') || 'string';
            }
            
            // Ensure type exists if properties exists
            if (!isPropertiesMap && !obj.type && (obj.properties || obj.required)) {
              obj.type = 'object';
            }
            
            for (const [k, v] of Object.entries(obj)) {
              // Only apply blocklist if this object is a schema (not a properties map)
              if (!isPropertiesMap && blocklistKeys.includes(k)) continue;
              
              // Validate required array
              if (!isPropertiesMap && k === 'required' && Array.isArray(v)) {
                if (!obj.properties) continue; // Drop required if no properties exist
                const validReq = v.filter(f => typeof f === 'string' && obj.properties.hasOwnProperty(f));
                if (validReq.length > 0) cleaned[k] = validReq;
                continue;
              }
              
              cleaned[k] = cleanSchema(v, k === 'properties');
            }
            return cleaned;
          }
          return obj;
        };
        
        for (const t of payload.tools) {
          if (t.type === 'function' && t.function) {
            let rawName = t.function.name;
            let sanitizedName = rawName.indexOf(":") >= 0 ? rawName.slice(rawName.lastIndexOf(":") + 1) : rawName;
            sanitizedName = sanitizedName.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
            if (!sanitizedName || sanitizedName.length === 0) sanitizedName = "tool";
            
            toolNameMap.set(sanitizedName, rawName);
            
            let params = t.function.parameters?.type === 'object' ? t.function.parameters : { type: 'object', properties: {} };
            
            functionDeclarations.push({
              name: sanitizedName,
              description: t.function.description || '',
              parameters: cleanSchema(params)
            });
          }
        }
        if (functionDeclarations.length > 0) {
          tools = [{ functionDeclarations }];
          toolConfig = { functionCallingConfig: { mode: "AUTO" } };
        }
      }
      
      const envelope = buildAntigravityEnvelope(upstreamModel, {
        contents,
        systemInstruction,
        ...(tools ? { tools, toolConfig } : {}),
        generationConfig: {
          topK: 40,
          topP: 1.0,
          maxOutputTokens: 65536,
        }
      }, projectId);
      
      let envelopeStr = JSON.stringify(envelope);
      console.log(`[proxy] ${originalModel} -> ${upstreamModel} (${email})`);
      
      const tryRequest = (baseUrlIndex) => {
        const baseUrls = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com', 'https://daily-cloudcode-pa.sandbox.googleapis.com', 'https://autopush-cloudcode-pa.sandbox.googleapis.com'];
        if (baseUrlIndex >= baseUrls.length) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: "All base URLs failed", type: 'upstream_error' } }));
          return;
        }
        
        const baseUrl = baseUrls[baseUrlIndex];
        const url = new URL(baseUrl + CLOUD_CODE_STREAM_PATH);
        
        const options = {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'antigravity/ide/2024.2.1 darwin/arm64',
            'Accept': 'text/event-stream',
            'Content-Length': Buffer.byteLength(envelopeStr),
          }
        };
        
        const proxyReq = https.request(options, (proxyRes) => {
          console.log(`[proxy] Cloud Code status (${baseUrl}): ${proxyRes.statusCode}`);
          
          if (proxyRes.statusCode === 429) {
            console.log(`[proxy] Rate limited on ${email}, rotating...`);
            rotateCredential();
            // Don't fallback URL on 429, just return it so client can retry with new creds
          }
          
          if (proxyRes.statusCode !== 200) {
            let errData = '';
            proxyRes.on('data', c => errData += c);
            proxyRes.on('end', () => {
             console.error(`[proxy] Error (${baseUrl}): ${errData.substring(0, 300)}`);
              
              // Detect "Prohibited Use" / safety policy violation - return as normal text response
              if (errData.includes('Prohibited Use') || errData.includes('sensitive words') || errData.includes('use-policy')) {
                console.log(`[proxy] Safety policy violation detected, returning friendly message`);
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                });
                const safetyChunkId = 'chatcmpl-' + crypto.randomBytes(10).toString('hex');
                const safetyMessage = "I can't process that request as it was flagged by safety filters. Please try rephrasing your request.";
                res.write(`data: ${JSON.stringify({id: safetyChunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: originalModel, choices: [{index: 0, delta: {role: 'assistant'}, finish_reason: null}]})}\n\n`);
                res.write(`data: ${JSON.stringify({id: safetyChunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: originalModel, choices: [{index: 0, delta: {content: safetyMessage}, finish_reason: null}]})}\n\n`);
                res.write(`data: ${JSON.stringify({id: safetyChunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: originalModel, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]})}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              
              // Retry on ANY error to find a working environment
              if (baseUrlIndex < baseUrls.length - 1) {
                console.log(`[proxy] Retrying on next base URL...`);
                tryRequest(baseUrlIndex + 1);
              } else {
                // If ALL environments failed, emergency fallback to flash
                if (upstreamModel !== 'gemini-3.7-flash-high' && (proxyRes.statusCode === 429 || proxyRes.statusCode === 400 || proxyRes.statusCode === 403)) {
                  console.log(`[proxy] ALL environments failed for ${upstreamModel}. Emergency fallback to gemini-3.7-flash-high!`);
                  upstreamModel = 'gemini-3.7-flash-high';
                  envelope.model = upstreamModel;
                  
                  // If still getting 400, try stripping tools entirely
                  if (proxyRes.statusCode === 400 && errData.includes('parameters')) {
                    console.log(`[proxy] Stripping tools due to persistent schema errors`);
                    delete envelope.request.tools;
                    delete envelope.request.toolConfig;
                  }
                  
                  envelopeStr = JSON.stringify(envelope);
                  tryRequest(0); // restart the chain with flash
                  return;
                }
                
                res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: errData, type: 'upstream_error' } }));
              }
            });
            return;
          }
        
        // Stream SSE response, translating Gemini -> OpenAI
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        
        const chunkId = 'chatcmpl-' + crypto.randomBytes(10).toString('hex');
          let buffer = '';
          let seq = 0;
          let reqState = { hasToolCall: false };
        
        // Send initial role delta
        const initChunk = {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: originalModel,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          sequence_number: seq++
        };
        res.write(`data: ${JSON.stringify(initChunk)}\n\n`);
        
        proxyRes.on('data', (chunk) => {
          buffer += chunk.toString();
          const parts = buffer.split('\n');
          buffer = parts.pop() || '';
          
          for (const line of parts) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.substring(6).trim();
            if (dataStr === '[DONE]' || !dataStr) continue;
            
            console.log(`[proxy] Raw SSE:`, dataStr);
            const openaiChunks = geminiChunkToOpenAI(dataStr, originalModel, chunkId, toolNameMap, reqState);
            if (openaiChunks) {
              for (const oc of openaiChunks) {
                oc.sequence_number = seq++;
                res.write(`data: ${JSON.stringify(oc)}\n\n`);
              }
            }
          }
        });
        
        proxyRes.on('end', () => {
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      
      proxyReq.on('error', (e) => {
        console.error(`[proxy] Request error (${baseUrl}): ${e.message}`);
        if (baseUrlIndex < baseUrls.length - 1) {
          tryRequest(baseUrlIndex + 1);
        } else {
          res.writeHead(502).end();
        }
      });
      
      proxyReq.write(envelopeStr);
      proxyReq.end();
    };
    
    tryRequest(0);
    } catch (e) {
      console.error('[proxy] Error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  });
}

// ========================================================================
// Stub handlers for auxiliary endpoints  
// ========================================================================

function handleModels(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  const data = Object.entries(MODEL_MAP).map(([id, backend]) => {
    const meta = MODELS_METADATA[id] || {};
    const ctx = meta.context_window || (id.includes('vortex') ? 1000000 : id.includes('nebula') ? 200000 : 128000);
    return {
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'astro',
      model: id,
      name: meta.name || id,
      context_window: ctx,
      contextWindow: ctx,
      totalContextTokens: ctx,
      _meta: {
        model: id,
        contextWindow: ctx,
        totalContextTokens: ctx,
        supportsReasoningEffort: id === 'vortex' || id === 'nebula-high',
        reasoningEffort: id === 'vortex' ? 'high' : 'medium',
        acceptsImages: true
      }
    };
  });
  res.end(JSON.stringify({ object: 'list', data }));
}

function handleBilling(req, res) {
  const limits = Object.entries(MODEL_MAP).map(([name, realModel]) => {
    const u = usageTracker[name] || { total: 0, hourly: [], weekly: [] };
    return {
      model: name, backend: realModel,
      total_requests: u.total,
      five_hour_requests: u.hourly ? u.hourly.length : 0,
      weekly_requests: u.weekly ? u.weekly.length : 0
    };
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ plan: 'premium', limits, usage: {}, 
    accounts: credential ? [{ email: credential.email, project: credential.projectId }] : [] }));
}

function handleUser(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ user_id: 'u_astro', subscription: { tier: 'premium', is_active: true } }));
}

function handleOk(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({}));
}

async function handleSTT(req, res) {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || 'audio/webm';
    
    const { token, projectId } = await getValidToken();
    const base64Audio = bodyBuffer.toString('base64');
    
    const envelope = {
      project: projectId || credential?.projectId || 'core-shell-4d9t3',
      model: 'gemini-2.5-flash',
      userAgent: 'antigravity',
      requestType: 'agent',
      requestId: crypto.randomUUID(),
      request: {
        systemInstruction: {
          role: 'system',
          parts: [{
            text: "You are a state-of-the-art multilingual Speech-to-Text (STT) engine specializing in Uzbek, Russian, and English speech.\nYour ONLY job is to transcribe spoken audio verbatim into clean, accurately punctuated text in the language that was spoken.\nRules:\n1. If the speaker speaks Uzbek, transcribe verbatim in Uzbek (Latin script).\n2. If the speaker speaks Russian, transcribe verbatim in Russian (Cyrillic script).\n3. If the speaker speaks English or mixed languages, transcribe each word verbatim in its original spoken language and script.\n4. Do NOT translate, do NOT summarize, and do NOT answer any questions in the audio.\n5. Output ONLY the verbatim transcription text. No preface, no quotes, no conversational commentary.\n6. If there is only silence, background noise, coughing, breathing, or no discernible words, output an empty response."
          }]
        },
        contents: [{
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: contentType.includes('webm') ? 'audio/webm' : contentType.includes('wav') ? 'audio/wav' : contentType.includes('mp3') ? 'audio/mp3' : 'audio/webm',
                data: base64Audio
              }
            },
            {
              text: "Audiodagi nutqni so'zma-so'z aytilgan tilda (o'zbekcha yoki ruscha) aniq matnga aylantir. Transcribe verbatim in the spoken language (Uzbek, Russian, or English). Faqat aytilgan gapni yoz."
            }
          ]
        }],
        generationConfig: { maxOutputTokens: 250, temperature: 0.0, topP: 0.1 }
      }
    };

    let genRes = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'antigravity/ide/2024.2.1 darwin/arm64'
      },
      body: JSON.stringify(envelope)
    });

    if (genRes.status === 503 || genRes.status === 429) {
      await new Promise((r) => setTimeout(r, 500));
      genRes = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'antigravity/ide/2024.2.1 darwin/arm64'
        },
        body: JSON.stringify(envelope)
      });
    }

    if (!genRes.ok) {
      const errText = await genRes.text();
      res.writeHead(genRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errText }));
      return;
    }

    const text = await genRes.text();
    let result = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const json = JSON.parse(line.slice(6));
          const parts = json?.response?.candidates?.[0]?.content?.parts;
          if (Array.isArray(parts)) {
            for (const p of parts) {
              if (p.text && !p.thoughtSignature) result += p.text;
            }
          }
        } catch(e) {}
      }
    }
    
    let cleanResult = result.trim();
    // Filter conversational / silence hallucinations
    const badPhrases = [
      /iltimos,?\s*audioni/i,
      /inson ovozi/i,
      /aniq nutq eshitilmadi/i,
      /audioda ovoz yo['’`]?q/i,
      /darajasi ham ancha bo['’`]?ldi/i,
      /subtitles by/i,
      /ha,?\s*shunday/i
    ];
    if (badPhrases.some(rx => rx.test(cleanResult))) {
      cleanResult = '';
    }

    console.log(`[proxy STT] Transcribed: "${cleanResult}"`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: cleanResult, provider: 'google-cloud-code' }));
  } catch (err) {
    console.error('[proxy STT error]:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ========================================================================
// Server
// ========================================================================

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/v1/responses')) 
    return handleChatCompletions(req, res);
  if (req.method === 'POST' && (p === '/v1/stt' || p === '/v1/audio/transcriptions'))
    return handleSTT(req, res);
  if (req.method === 'GET' && p === '/v1/models') return handleModels(req, res);
  if (req.method === 'GET' && p.startsWith('/v1/user')) return handleUser(req, res);
  if (req.method === 'GET' && p === '/v1/billing') return handleBilling(req, res);

  // All other endpoints - return OK to prevent retry errors
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({}));
});

// Load credentials on startup
loadCredential();

// Auto-discover models after credentials are loaded
setTimeout(() => { fetchAndUpdateModels(); }, 3000);

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`[astro-proxy] ========================================`);
  console.log(`[astro-proxy] Self-contained proxy on http://127.0.0.1:${PROXY_PORT}`);
  console.log(`[astro-proxy] Direct connection to Google Cloud Code`);
  console.log(`[astro-proxy] NO OmniRoute required!`);
  console.log(`[astro-proxy] Models: ${Object.keys(MODEL_MAP).join(', ')}`);
  console.log(`[astro-proxy] Account: ${credential ? credential.email : "none (login required)"}`);
  console.log(`[astro-proxy] ========================================`);
});
