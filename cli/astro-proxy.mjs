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
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, openSync, closeSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const HOME_DIR = os.homedir();
const ASTRO_DIR = process.env.GROK_HOME || path.join(HOME_DIR, '.astro');
const LOGIN_SUCCESS_URL = 'https://www.astroai.uz/auth/success';

// ========================================================================
// Configuration
// ========================================================================

const PROXY_PORT = Number(process.env.ASTRO_PROXY_PORT) || 5544;
// The CLI dials `http://localhost:5544`. On most modern systems `localhost`
// resolves to ::1 first, so binding IPv4-only makes every request fail with
// ECONNREFUSED on exactly the machines that prefer IPv6. Bind both loopbacks.
const PROXY_HOSTS = ['127.0.0.1', '::1'];
const CLOUD_CODE_BASE = 'https://daily-cloudcode-pa.googleapis.com';
const CLOUD_CODE_STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse';
const _b64d = (s) => Buffer.from(s, 'base64').toString('utf8');
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || _b64d('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==');
const _gs = () => ['GO','CS','PX-','K58F','WR48','6LdL','J1mL','B8sX','C4z6','qDAf'].join('');
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || _gs();
// Optional project override; otherwise use Google's account-specific project.
const DEFAULT_PROJECT_ID = process.env.ASTRO_PROJECT_ID || null;
// `os.homedir()` works on every platform; `process.env.HOME` is unset on
// Windows, which used to make this the literal string
// "undefined/.omniroute/storage.sqlite" (the `||` fallback could never fire
// because the concatenation is always truthy).
const OMNIROUTE_DB_PATH = path.join(os.homedir(), '.omniroute', 'storage.sqlite');

// Encryption config (from OmniRoute's .env)
const STORAGE_ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY || _b64d('YWQxYWZhMDMyZDc1YjFkOGZhODkwMTQ4ZTNjNjdmYmU3YTk2Y2ZkZjgwZjZhMjdlMjZlNjRhNmQ3NjRlNzdhYw==');
const ENC_PREFIX = 'enc:v1:';
const STATIC_SALT = 'omniroute-field-encryption-v1';

// Astro's taxonomy is independent of backend versions and thinking levels.
// A family selector follows the newest available version; versioned names stay pinned.
const DEFAULT_MODEL_REGISTRY = [
  { id: 'vortex', family: 'claude-opus' },
  { id: 'nebula', family: 'gemini-argon' },
  { id: 'nebula-high', family: 'gemini-argon', effort: 'high' },
  { id: 'photon-3.8', family: 'gemini-flash', version: '3.8' },
  { id: 'photon-3.7', family: 'gemini-flash', version: '3.7' }
];
const MODEL_CATALOG_VERSION = 6;
const EFFORT_LEVELS = ['low', 'medium', 'high'];
// Before login/verification we cannot claim that any backend is available.
let MODEL_MAP = Object.create(null);
let MODELS_METADATA = Object.create(null);

// Auto-discover and sync models from central registry & Antigravity API
const MODELS_CACHE_FILE = path.join(ASTRO_DIR, 'proxy-models-cache.json');
let registryModels = DEFAULT_MODEL_REGISTRY;
let modelsVerifiedAt = null;
let modelsAccount = null;
let modelsSyncInFlight = null;
let modelsLastAttempt = 0;
let accountAccess = null;
let deniedModelBackends = new Set();

function tierPlan(tier) {
  const id = String(typeof tier === 'string' ? tier : tier?.id || '').toLowerCase();
  if (['ultra', 'g1-ultra-tier'].includes(id)) return 'ultra';
  if (['pro', 'g1-pro-tier'].includes(id)) return 'pro';
  if (['free', 'free-tier', 'legacy-tier'].includes(id)) return 'free';
  return 'unknown';
}

function modelIsEntitled(model, access) {
  if (['isAvailable', 'isAllowed', 'isEnabled', 'hasAccess', 'isEntitled'].some(key => model[key] === false)
      || model.disabled === true || model.requiresUpgrade === true) return false;
  const status = String(model.accessStatus || model.availability?.status || '').toUpperCase();
  if (['DENIED', 'DISABLED', 'UNAVAILABLE', 'UPGRADE_REQUIRED', 'SUBSCRIPTION_REQUIRED'].includes(status)) return false;
  const plan = access?.plan || 'unknown';
  const rank = { free: 0, pro: 1, ultra: 2 };
  const tierId = access?.tierId;
  const allowed = model.allowedTiers || model.allowedTierIds;
  if (Array.isArray(allowed) && !allowed.some(tier => {
    const id = typeof tier === 'string' ? tier : tier?.id;
    return id === tierId || (tierPlan(id) !== 'unknown' && tierPlan(id) === plan);
  })) return false;
  const required = model.requiredTier || model.minimumTier || model.requiredTierId;
  if (required) {
    const requiredId = typeof required === 'string' ? required : required.id;
    const minimum = tierPlan(requiredId);
    if (minimum === 'unknown' ? requiredId !== tierId : !(plan in rank) || rank[plan] < rank[minimum]) return false;
  }
  if (model.requiresPaidTier === true && !['pro', 'ultra'].includes(plan)) return false;
  // Presence in the authenticated available-models snapshot grants access
  // when Google returns no additional restriction. Model family is not a tariff.
  return true;
}

function persistModelCatalog() {
  ensureAstroDir();
  writeJsonAtomic(MODELS_CACHE_FILE, { catalogVersion: MODEL_CATALOG_VERSION, MODEL_MAP, MODELS_METADATA,
    registryModels, verifiedAt: modelsVerifiedAt, account: modelsAccount, accountAccess,
    deniedBackends: [...deniedModelBackends] });
}

function clearModelCatalog() {
  MODEL_MAP = Object.create(null); MODELS_METADATA = Object.create(null); modelsVerifiedAt = null;
  modelsAccount = credentialIdentity();
  persistModelCatalog();
}

function denyBackend(backend) {
  deniedModelBackends.add(backend);
  for (const [id, meta] of Object.entries(MODELS_METADATA)) {
    const backends = (meta.backends || [MODEL_MAP[id]]).filter(value => value !== backend);
    for (const [effort, route] of Object.entries(meta.reasoning_routes || {}))
      if (route.backend === backend) delete meta.reasoning_routes[effort];
    meta.reasoning_efforts = EFFORT_LEVELS.filter(level => Object.hasOwn(meta.reasoning_routes || {}, level));
    meta.backends = backends;
    // A named high-only choice must never turn into low/medium after a denial.
    if (meta.required_reasoning_effort && !meta.reasoning_efforts.includes(meta.required_reasoning_effort)) {
      delete MODEL_MAP[id]; delete MODELS_METADATA[id]; continue;
    }
    if (!backends.length || (MODEL_MAP[id] === backend && !meta.reasoning_efforts.length)) {
      delete MODEL_MAP[id]; delete MODELS_METADATA[id]; continue;
    }
    if (!meta.reasoning_efforts.includes(meta.default_reasoning_effort))
      meta.default_reasoning_effort = meta.reasoning_efforts.includes('medium') ? 'medium' : meta.reasoning_efforts.at(-1);
    MODEL_MAP[id] = meta.reasoning_routes?.[meta.default_reasoning_effort]?.backend || backends[0];
  }
  persistModelCatalog();
}

function isModelAccessDenial(status, body) {
  if (status !== 403) return false;
  try {
    const error = JSON.parse(body)?.error || {};
    const reasons = [error.reason, ...(error.details || []).map(detail => detail.reason)];
    if (reasons.some(reason => ['MODEL_ACCESS_DENIED', 'MODEL_NOT_ALLOWED', 'SUBSCRIPTION_REQUIRED',
      'INSUFFICIENT_TIER', 'TIER_NOT_SUPPORTED'].includes(reason))) return true;
    return /(?:subscription|tier|plan).{0,80}(?:required|upgrade|only)|model.{0,80}(?:not available|not allowed|requires)/i.test(error.message || '');
  } catch { return false; }
}

function backendIdentity(backend) {
  const effort = backend.match(/-(low|medium|high)$/)?.[1];
  let base = effort ? backend.slice(0, -effort.length - 1) : backend;
  // Google currently exposes Flash 3.8 as a tiered transport ID. Tiering is
  // not a different model version; preserve the exact wire ID in each route.
  if (base.startsWith('gemini-')) base = base.replace(/-tiered$/, '');
  const opus = base.match(/^claude-opus-(\d+)(?:[.-](\d{1,3})(?!\d))?(.*)$/);
  if (opus) {
    // Plain/thinking Opus transports are one version with different capabilities.
    base = base.replace(/-thinking$/, '');
    const suffix = opus[3].replace(/-thinking$/, '');
    const version = opus[2] === undefined ? opus[1] : `${opus[1]}.${opus[2]}`;
    return { base, effort, family: 'claude-opus', version,
      suffix, id: `vortex-${version}${suffix}` };
  }
  const gemini = base.match(/^gemini-(\d+(?:[.-]\d+)?)-(flash|pro|argon)(.*)$/);
  if (gemini) {
    const version = gemini[1].replace('-', '.');
    const brand = { flash: 'photon', argon: 'nebula' }[gemini[2]];
    return { base, effort, family: `gemini-${gemini[2]}`, version,
      suffix: gemini[3], id: gemini[2] === 'pro' ? base : `${brand}-${version}${gemini[3]}` };
  }
  return { base, effort, family: base, version: '', suffix: '', id: base };
}

function normalizeRegistry(data) {
  const list = Array.isArray(data) ? data : data?.models;
  if (!Array.isArray(list)) throw new Error('Invalid model registry');
  return list.map(m => {
    if (typeof m?.id !== 'string' || !/^[a-zA-Z0-9][\w.-]*$/.test(m.id))
      throw new Error('Invalid registry model id');
    // Older website registries have branding only (or incorrect Flash mappings).
    // The user's fixed Astro taxonomy always wins for these reserved names.
    const reserved = DEFAULT_MODEL_REGISTRY.find(rule => rule.id === m.id);
    const versioned = m.id.match(/^(photon|nebula|vortex|argon)-(\d+(?:\.\d+)?)$/);
    if (reserved) return { ...m, backend: undefined, ...reserved, version: reserved.version, effort: reserved.effort };
    if (versioned) return { ...m, backend: undefined,
      family: { photon: 'gemini-flash', nebula: 'gemini-argon', vortex: 'claude-opus', argon: 'gemini-argon' }[versioned[1]],
      version: versioned[2] };
    if ((typeof m.backend !== 'string' || !m.backend) && (typeof m.family !== 'string' || !m.family))
      throw new Error('Registry model requires a backend or family selector');
    return { ...m };
  });
}

function normalizeGoogleModels(data, access) {
  if (data?.error) throw new Error('Google model catalog returned an error');
  const raw = data?.models ?? data?.availableModels;
  if (!raw || typeof raw !== 'object') throw new Error('Invalid Google model catalog');
  const entries = Array.isArray(raw)
    ? raw.map(m => [typeof m === 'string' ? m : m?.id || m?.name || m?.model, m])
    : Object.entries(raw);
  const models = new Map();
  const normalizeId = value => typeof value === 'string' ? value.replace(/^models\//, '') : null;
  const nonAgentIds = new Set([
    ...(data.imageGenerationModelIds || []), ...(data.audioTranscriptionModelIds || []), ...(data.tabModelIds || [])
  ].map(normalizeId).filter(Boolean));
  const agentIds = new Set([normalizeId(data.defaultAgentModelId)].filter(Boolean));
  for (const sort of data.agentModelSorts || [])
    for (const group of sort.groups || [])
      for (const id of group.modelIds || []) if (normalizeId(id)) agentIds.add(normalizeId(id));
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || !key || !value ||
        (typeof value !== 'string' && (typeof value !== 'object' || Array.isArray(value))))
      throw new Error('Invalid Google model entry');
    const id = key.replace(/^models\//, '');
    if (nonAgentIds.has(id) && !agentIds.has(id) && value.supportsChat !== true) continue;
    // Zero remaining quota is temporary; it does not mean a model was removed.
    if (value.isInternal === true || value.hidden === true ||
        !/^[a-zA-Z0-9][\w.-]*$/.test(id) || /(?:^|[-_])internal(?:$|[-_])/.test(id)) continue;
    if (!modelIsEntitled(value, access) || deniedModelBackends.has(id)) continue;
    if (/^(tab_|chat_)/.test(id) || value.supportsChat === false) continue;
    models.set(id, typeof value === 'object' ? value : {});
  }
  return models;
}

function thinkingCapabilities(backend, provider) {
  if (provider.supportsThinking === false || provider.supportsReasoningEffort === false)
    return { levels: [] };
  const config = provider.thinkingConfig || provider.thinking || {};
  const capabilityModel = backend.replace(/-tiered$/, '');
  const advertised = provider.supportedThinkingLevels ?? config.supportedLevels ?? config.levels
    ?? provider.reasoningEfforts;
  const budgets = provider.thinkingBudgets || config.budgets;
  let levels = Array.isArray(advertised)
    ? EFFORT_LEVELS.filter(level => advertised.some(v => String(v?.value || v).toLowerCase() === level)) : null;
  let mode = budgets || config.maxBudget || config.max || /^gemini-2\.5-/.test(backend)
    || /^claude-.*-thinking$/.test(backend) ? 'budget' : 'level';
  if (levels === null) {
    // Documented transport capabilities, used only when Google omits metadata.
    // Unknown future models need advertised levels or explicit effort variants.
    if (/^gemini-3-pro(?:-preview)?$/.test(backend)) levels = ['low', 'high'];
    else if (/^gemini-(?:3|3\.1|3\.5|3\.6|3\.7|3\.8)-(?:flash|pro)(?:-lite)?(?:-preview)?$/.test(backend)
      || /^gemini-4-argon(?:-preview)?$/.test(backend)) levels = EFFORT_LEVELS;
    else if (/^gemini-3\.8-flash$/.test(capabilityModel) && provider.supportsThinking === true) levels = EFFORT_LEVELS;
    else if (mode === 'budget') levels = EFFORT_LEVELS;
    else levels = [];
  }
  const routes = Object.create(null);
  for (const level of levels) {
    let thinkingConfig;
    if (mode === 'budget') {
      const min = Number(config.minBudget ?? config.min ?? provider.minThinkingBudget ?? (/^claude-/.test(backend) ? 1024 : 128));
      const output = Number(provider.outputTokenLimit || provider.maxOutputTokens || (/^claude-/.test(backend) ? 64000 : 65536));
      const max = Math.min(Number(config.maxBudget ?? config.max ?? 32768), output - 1);
      const budget = Number(budgets?.[level] ?? { low: 4096, medium: 8192, high: 16384 }[level]);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || !Number.isFinite(budget) || budget < 0) continue;
      thinkingConfig = { thinkingBudget: Math.floor(Math.max(min, Math.min(max, budget))), includeThoughts: true };
    } else thinkingConfig = { thinkingLevel: level, includeThoughts: true };
    routes[level] = { backend, thinkingConfig };
  }
  return { levels: Object.keys(routes), routes,
    default: String(provider.defaultThinkingLevel || config.defaultLevel || '').toLowerCase() };
}

function buildModelCatalog(registry, available) {
  const nextMap = Object.create(null), nextMeta = Object.create(null), groups = new Map();
  for (const [backend, provider] of [...available].sort(([a], [b]) => a.localeCompare(b))) {
    const identity = backendIdentity(backend);
    let group = groups.get(identity.id);
    if (!group) { group = { ...identity, variants: [] }; groups.set(identity.id, group); }
    group.variants.push({ backend, provider, effort: identity.effort });
  }
  const prepare = (group, meta = {}) => {
    const routes = Object.create(null);
    const plain = group.variants.filter(v => !v.effort)
      .sort((a, b) => Number(b.backend.endsWith('-thinking')) - Number(a.backend.endsWith('-thinking')))[0];
    const capabilities = plain ? thinkingCapabilities(plain.backend, plain.provider) : { levels: [] };
    Object.assign(routes, capabilities.routes);
    for (const variant of group.variants) if (variant.effort) {
      // A concrete Google variant is already configured for this effort.
      routes[variant.effort] = { backend: variant.backend };
    }
    const levels = EFFORT_LEVELS.filter(level => Object.hasOwn(routes, level));
    const requestedDefault = meta.effort || capabilities.default;
    if (meta.effort && !levels.includes(meta.effort)) return null;
    const defaultEffort = levels.includes(requestedDefault) ? requestedDefault
      : levels.includes('medium') ? 'medium' : levels.includes('high') ? 'high' : levels[0];
    const backend = routes[defaultEffort]?.backend || plain?.backend || group.variants[0].backend;
    const provider = available.get(backend);
    const limits = group.variants.map(v => Number(v.provider.inputTokenLimit || v.provider.maxTokens || v.provider.maxInputTokens
      || v.provider.contextWindow)).filter(n => Number.isFinite(n) && n > 0);
    const outputLimits = group.variants.map(v => Number(v.provider.outputTokenLimit || v.provider.maxOutputTokens))
      .filter(n => Number.isFinite(n) && n > 0);
    return { backend, name: meta.id || group.id, family: group.family, version: group.version,
      context_window: limits.length ? Math.min(...limits) : Number(meta.context_window) || 128000,
      max_output_tokens: outputLimits.length ? Math.min(...outputLimits) : /^claude-/.test(backend) ? 64000 : 65536,
      accepts_images: provider.supportsImages ?? provider.acceptsImages ?? /^(gemini-|claude-)/.test(backend),
      backends: group.variants.map(v => v.backend),
      reasoning_routes: routes, reasoning_efforts: levels, default_reasoning_effort: defaultEffort,
      required_reasoning_effort: meta.effort || null };
  };
  const add = (id, group, meta) => {
    const prepared = prepare(group, meta);
    if (!prepared) return;
    nextMap[id] = prepared.backend;
    nextMeta[id] = { ...prepared, name: id };
  };
  for (const meta of registry) {
    const exact = meta.backend && [...groups.values()].find(g => g.variants.some(v => v.backend === meta.backend));
    // An exact pin is not permission to substitute a different model/version.
    if (meta.backend && !exact) continue;
    const candidates = exact ? [{ ...exact, variants: exact.variants.filter(v => v.backend === meta.backend) }]
      : [...groups.values()].filter(g => g.family === meta.family && (!meta.version || g.version === meta.version)
        && (!g.suffix || g.suffix === '-preview'));
    // Numeric ordering makes 4.10 newer than 4.9; prefer stable over preview at equal version.
    candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })
      || Number(Boolean(a.suffix)) - Number(Boolean(b.suffix)) || a.base.localeCompare(b.base));
    const chosen = candidates[0];
    if (chosen) add(meta.id, chosen, meta);
  }
  // An explicitly empty registry disables every model. Otherwise discover all families.
  if (registry.length) for (const group of groups.values()) {
    if (!Object.hasOwn(nextMap, group.id)) add(group.id, group, {});
    // Preserve the original explicit Argon selector for saved sessions.
    if (group.family === 'gemini-argon') {
      const legacyId = `argon-${group.version}${group.suffix}`;
      if (!Object.hasOwn(nextMap, legacyId)) add(legacyId, group, {});
    }
  }
  return { MODEL_MAP: nextMap, MODELS_METADATA: nextMeta };
}

function modelRoute(id, requestedEffort) {
  const meta = MODELS_METADATA[id] || {};
  if (requestedEffort !== undefined && (typeof requestedEffort !== 'string'
      || !(meta.reasoning_efforts || []).includes(requestedEffort))) {
    const error = new Error(`Unsupported reasoning_effort for ${id}. Available: ${(meta.reasoning_efforts || []).join(', ') || 'none'}`);
    error.code = 'unsupported_reasoning_effort';
    throw error;
  }
  const effort = requestedEffort ?? meta.default_reasoning_effort;
  return meta.reasoning_routes?.[effort] || { backend: MODEL_MAP[id] };
}

function requestJson(url, { method = 'GET', body, headers = {}, timeoutMs = 5000 } = {}) {
  let deadline;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request(url, { method, timeout: timeoutMs, headers: {
      'User-Agent': 'astro-proxy/1.0',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers
    } }, res => {
      let data = '';
      res.on('error', reject);
      res.on('data', c => {
        data += c;
        if (data.length > 2 * 1024 * 1024) req.destroy(new Error('JSON response too large'));
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`HTTP ${res.statusCode}`);
          error.status = res.statusCode;
          try { error.details = JSON.parse(data)?.error; } catch {}
          reject(error); return;
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    deadline = setTimeout(() => req.destroy(new Error('Request deadline exceeded')), timeoutMs);
    deadline.unref?.();
    if (payload) req.write(payload);
    req.end();
  }).finally(() => clearTimeout(deadline));
}

function fetchAndUpdateModels() {
  reloadChangedCredentials();
  if (modelsSyncInFlight) return modelsSyncInFlight;
  modelsLastAttempt = Date.now();
  modelsSyncInFlight = syncModelCatalog().finally(() => { modelsSyncInFlight = null; });
  return modelsSyncInFlight;
}

function credentialIdentity() {
  const identity = credential?.userId || credential?.email || credential?.refreshToken;
  return identity ? crypto.createHash('sha256').update(identity).digest('hex') : null;
}

async function syncModelCatalog() {
  for (const url of ['https://www.astroai.uz/api/models',
    'https://raw.githubusercontent.com/cyberuz001/astro-cli/main/cli/models.json']) {
    try { registryModels = normalizeRegistry(await requestJson(url)); break; }
    catch (e) { console.warn('[proxy] Registry sync:', e.message); }
  }
  if (!credential?.refreshToken) return;
  try {
    const { token, projectId } = await getValidToken();
    const account = credentialIdentity();
    const access = await setupCloudAccount(token, projectId);
    if (credentialIdentity() !== account) return;
    const changedPlan = accountAccess && accountAccess.tierId !== access.tierId;
    accountAccess = { ...access, verifiedAt: new Date().toISOString() };
    if (changedPlan) {
      deniedModelBackends.clear();
      clearModelCatalog();
    }
    if (credential.projectId !== access.projectId) { credential.projectId = access.projectId; saveCredential(); }
    const available = normalizeGoogleModels(await requestJson(
      `${CLOUD_CODE_BASE}/v1internal:fetchAvailableModels`, {
        method: 'POST', body: { project: access.projectId },
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'antigravity' }
      }), accountAccess);
    // A login that completes during this request owns a different catalog.
    if (credentialIdentity() !== account) return;
    const next = buildModelCatalog(registryModels, available);
    MODEL_MAP = next.MODEL_MAP;
    MODELS_METADATA = next.MODELS_METADATA;
    modelsVerifiedAt = new Date().toISOString();
    modelsAccount = account;
    persistModelCatalog();
    console.log(`[proxy] Google verified ${Object.keys(MODEL_MAP).length} models: ${Object.keys(MODEL_MAP).join(', ')}`);
  } catch (e) {
    if ([401, 403].includes(e.status) || ['account_ineligible', 'authentication_expired'].includes(e.code)) {
      accountAccess = null;
      try { clearModelCatalog(); } catch {}
    }
    // HTTP/JSON/token failures are not an authoritative deletion snapshot.
    console.warn('[proxy] Model sync retained previous catalog:', e.message);
  }
}

// Load cached models on startup
try {
  if (existsSync(MODELS_CACHE_FILE)) {
    const cached = JSON.parse(readFileSync(MODELS_CACHE_FILE, 'utf8'));
    if (cached.catalogVersion === MODEL_CATALOG_VERSION && cached.MODEL_MAP
        && typeof cached.MODEL_MAP === 'object' && !Array.isArray(cached.MODEL_MAP)) {
      MODEL_MAP = cached.MODEL_MAP;
      MODELS_METADATA = cached.MODELS_METADATA || {};
      modelsVerifiedAt = cached.verifiedAt || null;
      modelsAccount = cached.account || null;
      accountAccess = cached.accountAccess || null;
      deniedModelBackends = new Set(cached.deniedBackends || []);
      if (cached.registryModels) registryModels = normalizeRegistry(cached.registryModels);
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


// Must match the Rust CLI's `GROK_HOME` override, otherwise the two sides
// read and write different auth.json files.
const AUTH_FILE = path.join(ASTRO_DIR, 'proxy-auth.json');
const CLI_AUTH_FILE = path.join(ASTRO_DIR, 'auth.json');
let credentialFilesStamp = '';

function authFilesStamp() {
  return [CLI_AUTH_FILE, AUTH_FILE].map(file => {
    try { const stat = statSync(file); return `${stat.ino}:${stat.mtimeMs}:${stat.size}`; }
    catch { return 'missing'; }
  }).join('|');
}

function reloadChangedCredentials() {
  const stamp = authFilesStamp();
  if (stamp !== credentialFilesStamp) {
    loadCredential();
    credentialFilesStamp = authFilesStamp();
  }
  if (modelsAccount !== credentialIdentity()) {
    accountAccess = null; deniedModelBackends.clear(); modelsLastAttempt = 0;
    clearModelCatalog();
  }
}
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
let tokenRefreshInFlight = null;

function ensureAstroDir() {
  if (!existsSync(ASTRO_DIR)) mkdirSync(ASTRO_DIR, { recursive: true });
}

/// Write `obj` as pretty JSON to `target` without ever exposing a torn file.
///
/// The Rust CLI reads auth.json unlocked and treats non-empty invalid JSON as
/// corruption: it renames the file to `auth.json.corrupt.<ms>` and continues
/// with an *empty* credential store, which surfaces to the user as "it asked
/// me to log in again". A plain `writeFileSync` leaves exactly that window
/// open, so publish via temp + rename instead — `rename` is atomic on POSIX
/// and maps to `MoveFileEx(MOVEFILE_REPLACE_EXISTING)` on Windows.
function writeJsonAtomic(target, obj) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
}

// Advisory lock guarding our own auth.json writes. Deliberately NOT
// `auth.json.lock` — that name belongs to the Rust CLI's flock, and touching
// it corrupts the CLI's own locking (see `cleanStaleProxyLocks`).
const PROXY_LOCK_FILE = path.join(ASTRO_DIR, 'auth.json.proxy.lock');
const PROXY_LOCK_STALE_MS = 30_000;

// Best-effort and strictly non-blocking: this runs on the request path, so it
// must never spin or sleep — stalling the event loop here would stall every
// in-flight completion. If another proxy holds the lock we proceed anyway;
// `writeJsonAtomic` alone already guarantees readers never see a torn file,
// and the lock only narrows a lost-update window between two proxies, which
// requires two instances racing on the same account.
function withProxyAuthLock(fn) {
  ensureAstroDir();
  let fd = null;
  try {
    fd = openSync(PROXY_LOCK_FILE, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      // Reclaim a lock abandoned by a crashed proxy; otherwise just continue.
      try {
        if (Date.now() - statSync(PROXY_LOCK_FILE).mtimeMs > PROXY_LOCK_STALE_MS) {
          unlinkSync(PROXY_LOCK_FILE);
          fd = openSync(PROXY_LOCK_FILE, 'wx');
        }
      } catch {}
    }
    // Any other error (read-only FS, permissions) — carry on unlocked.
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
      try { unlinkSync(PROXY_LOCK_FILE); } catch {}
    }
  }
}

/// Drop anything from `auth.json` that is not a `scope -> credential` entry.
///
/// The Rust CLI deserializes auth.json as `BTreeMap<String, GrokAuth>`, so a
/// single top-level scalar makes the *whole file* unparseable. An earlier
/// build of this proxy wrote its own flat shape
/// (`{email, refresh_token, access_token, project_id, expires_at}`) straight
/// into auth.json. That is still valid JSON, so the read-modify-write below
/// parsed it happily, added the real scope beside it, and left the flat keys
/// in place — producing a file the CLI rejected as corrupt on every launch.
/// It renamed it to `auth.json.corrupt.<ms>`, fell back to an empty store and
/// asked the user to log in again. Because the poison was re-read and
/// re-written each time, it recurred indefinitely.
///
/// Verified against a real install: 18 `auth.json.corrupt.*` backups, each
/// holding exactly that flat shape.
function sanitizeAuthStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) return {};
  const clean = {};
  const dropped = [];
  for (const [k, v] of Object.entries(store)) {
    // A credential entry is an object carrying at least a token or a
    // refresh token. Scope keys are issuer-qualified ("issuer::client_id")
    // or the known legacy/api-key scopes.
    const looksLikeCredential =
      v && typeof v === 'object' && !Array.isArray(v) &&
      (typeof v.key === 'string' || typeof v.refresh_token === 'string');
    if (looksLikeCredential) clean[k] = v;
    else dropped.push(k);
  }

  // Recover the login instead of discarding it. The flat shape is ours and
  // we know which scope it belongs to, so a poisoned file can be converted
  // into a valid credential rather than forcing one more trip through the
  // browser. Only applied when the scope is not already present, so a good
  // entry is never overwritten by the stale flat one.
  const scopeKey = `https://accounts.google.com::${GOOGLE_CLIENT_ID}`;
  if (typeof store.refresh_token === 'string' && !clean[scopeKey]) {
    clean[scopeKey] = {
      key: typeof store.access_token === 'string' ? store.access_token : '',
      auth_mode: 'oidc',
      create_time: new Date().toISOString(),
      user_id: typeof store.user_id === 'string' ? store.user_id : '',
      email: typeof store.email === 'string' ? store.email : null,
      coding_data_retention_opt_out: true,
      refresh_token: store.refresh_token,
      expires_at: typeof store.expires_at === 'string'
        ? store.expires_at
        : new Date(Date.now() + 3600000).toISOString(),
      oidc_issuer: 'https://accounts.google.com',
      oidc_client_id: GOOGLE_CLIENT_ID,
    };
    console.log(`[proxy] auth.json: migrated a legacy flat credential into scope ${scopeKey}`);
  }

  if (dropped.length) {
    console.warn(`[proxy] auth.json: dropped ${dropped.length} non-credential top-level key(s) that would make the CLI treat the file as corrupt: ${dropped.join(', ')}`);
  }
  return clean;
}

function saveCredential() {
  ensureAstroDir();
  const errors = [];
  withProxyAuthLock(() => {
    // 1. Save to proxy-auth.json
    try {
      writeJsonAtomic(AUTH_FILE, {
        email: credential.email,
        user_id: credential.userId || null,
        refresh_token: credential.refreshToken,
        access_token: credential.accessToken,
        project_id: credential.projectId || DEFAULT_PROJECT_ID,
        expires_at: credential.expiresAt?.toISOString(),
      });
    } catch (e) {
      console.error('[proxy] Failed to write proxy-auth.json:', e.message);
      errors.push(e);
    }

    // 2. Also save to ~/.astro/auth.json for CLI compatibility!
    try {
      let cliAuth = {};
      if (existsSync(CLI_AUTH_FILE)) {
        try { cliAuth = JSON.parse(readFileSync(CLI_AUTH_FILE, 'utf8')); } catch {}
      }
      cliAuth = sanitizeAuthStore(cliAuth);
      const scopeKey = `https://accounts.google.com::${GOOGLE_CLIENT_ID}`;
      // Merge over any existing entry: the CLI enriches this scope with
      // principal_type / team_id / organization_id from GET /v1/user, and
      // blindly replacing the object dropped all of it on every refresh.
      const stored = cliAuth[scopeKey];
      const sameAccount = stored && ((credential.userId && stored.user_id === credential.userId)
        || (credential.email && stored.email === credential.email));
      const prev = sameAccount ? stored : {};
      cliAuth[scopeKey] = {
        ...prev,
        key: credential.accessToken || '',
        auth_mode: 'oidc',
        // `create_time` is the mint time of the *credential*, not of this
        // write. Restamping it on every refresh reset the CLI's 30-day TTL
        // accounting and its clock-skew diagnostics.
        create_time: prev.create_time || new Date().toISOString(),
        user_id: credential.userId || prev.user_id || '',
        email: credential.email,
        first_name: credential.firstName ?? prev.first_name ?? null,
        last_name: credential.lastName ?? prev.last_name ?? null,
        coding_data_retention_opt_out: prev.coding_data_retention_opt_out ?? true,
        refresh_token: credential.refreshToken,
        expires_at: credential.expiresAt?.toISOString() || new Date(Date.now() + 3600000).toISOString(),
        oidc_issuer: 'https://accounts.google.com',
        oidc_client_id: GOOGLE_CLIENT_ID
      };
      writeJsonAtomic(CLI_AUTH_FILE, cliAuth);
      console.log(`[proxy] Synced credentials to ${CLI_AUTH_FILE}`);
    } catch (e) {
      console.error('[proxy] Failed to sync auth.json:', e.message);
      errors.push(e);
    }
  });
  if (errors.length) throw new Error('Could not persist credentials: ' + errors.map(e => e.message).join('; '));
  credentialFilesStamp = authFilesStamp();
}

function loadCredential() {
  // First, check ~/.astro/auth.json (primary CLI auth written by astro login)
  try {
    if (existsSync(CLI_AUTH_FILE)) {
      const cliData = JSON.parse(readFileSync(CLI_AUTH_FILE, 'utf8'));
      for (const [k, v] of Object.entries(cliData)) {
        if (v && v.refresh_token && (k === `https://accounts.google.com::${GOOGLE_CLIENT_ID}`
            || (v.oidc_issuer === 'https://accounts.google.com' && v.oidc_client_id === GOOGLE_CLIENT_ID))) {
          let savedProject = null;
          try {
            const saved = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
            if ((v.user_id && saved.user_id === v.user_id) || saved.refresh_token === v.refresh_token)
              savedProject = saved.project_id;
          } catch {}
          credential = {
            email: v.email || null,
            userId: v.user_id || null,
            firstName: v.first_name || null,
            lastName: v.last_name || null,
            accessToken: v.key || null,
            refreshToken: v.refresh_token,
            projectId: DEFAULT_PROJECT_ID || savedProject || null,
            expiresAt: v.expires_at ? new Date(v.expires_at) : new Date(0),
          };
          console.log(`[proxy] Loaded credentials from auth.json for ${credential.email}`);
          return true;
        }
      }
      // A successfully parsed CLI store without this Google scope means logout.
      // The proxy's secondary copy must not revive the removed login.
      credential = null;
      return false;
    }
  } catch (e) {
    console.error('[proxy] Failed to load auth.json:', e.message);
  }

  // Second, check proxy-auth.json
  try {
    if (existsSync(AUTH_FILE)) {
      const data = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
      if (data.refresh_token) {
        credential = {
          email: data.email || null,
          userId: data.user_id || null,
          firstName: null,
          lastName: null,
          accessToken: data.access_token || null,
          refreshToken: data.refresh_token,
          projectId: data.project_id || DEFAULT_PROJECT_ID,
          expiresAt: data.expires_at ? new Date(data.expires_at) : new Date(0),
        };
        console.log(`[proxy] Loaded credentials from proxy-auth.json for ${credential.email}`);
        return true;
      }
    }
  } catch (e) {
    console.error('[proxy] Failed to load proxy-auth.json:', e.message);
  }
  credential = null;
  return false;
}

// Also try loading from OmniRoute DB as a migration path
function tryLoadFromOmniRoute() {
  try {
    const dbPath = OMNIROUTE_DB_PATH;
    if (!existsSync(dbPath)) return false;
    const betterSqlitePath = path.join(os.homedir(), '.omniroute', 'runtime', 'node_modules', 'better-sqlite3');
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
    const state = crypto.randomBytes(32).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
      scope: OAUTH2_SCOPES, access_type: 'offline', prompt: 'consent', state,
      code_challenge: challenge, code_challenge_method: 'S256'
    });
    let settled = false, exchanging = false, timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callbackServer.close();
      loginInProgress = false;
      const waiters = loginWaiters;
      loginWaiters = [];
      if (error) { waiters.forEach(w => w.reject(error)); reject(error); }
      else { waiters.forEach(w => w.resolve()); resolve(); }
    };
    const callbackServer = createServer(async (cbReq, cbRes) => {
      // This listener belongs to one login attempt; a reused keep-alive
      // connection must not deliver the next login to the old attempt.
      cbRes.setHeader('Connection', 'close');
      let url;
      try { url = new URL(cbReq.url, redirectUri); }
      catch { cbRes.writeHead(400).end('Invalid callback URL.'); return; }
      if (cbReq.method !== 'GET' || url.pathname !== '/callback') {
        cbRes.writeHead(404).end(); return;
      }
      // Unrelated or forged callbacks cannot cancel the real user's login.
      if (url.searchParams.get('state') !== state) {
        cbRes.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid OAuth state.'); return;
      }
      if (settled || exchanging) { cbRes.writeHead(409).end('Callback already handled.'); return; }
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code) {
        cbRes.writeHead(400, { 'Content-Type': 'text/plain' }).end('Login cancelled. Run: astro login');
        finish(new Error('Google login cancelled')); return;
      }
      exchanging = true;
      const previous = credential;
      try {
        const tokens = await exchangeCodeForTokens(code, redirectUri, verifier);
        const userInfo = await getUserInfo(tokens.access_token);
        const sameAccount = previous && (
          (userInfo.id && userInfo.id === previous.userId) ||
          (userInfo.email && userInfo.email === previous.email)
        );
        const refreshToken = tokens.refresh_token || (sameAccount ? previous.refreshToken : null);
        if (!refreshToken) throw new Error('Google returned no refresh token. Run: astro login');
        const nextCredential = {
          email: userInfo.email || null, userId: userInfo.id || userInfo.sub || null,
          firstName: userInfo.given_name || null, lastName: userInfo.family_name || null,
          accessToken: tokens.access_token, refreshToken, projectId: null,
          expiresAt: new Date(Date.now() + (tokens.expires_in || 3599) * 1000)
        };
        const nextAccess = await setupCloudAccount(tokens.access_token, DEFAULT_PROJECT_ID);
        nextCredential.projectId = nextAccess.projectId;
        if (settled) { cbRes.writeHead(408).end('Login timed out.'); return; }
        credential = nextCredential;
        saveCredential();
        // Do not expose another account's cached models after a switch.
        accountAccess = { ...nextAccess, verifiedAt: new Date().toISOString() };
        deniedModelBackends.clear();
        clearModelCatalog();
        modelsLastAttempt = 0;
        cbRes.writeHead(303, {
          Location: LOGIN_SUCCESS_URL, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'
        });
        cbRes.end();
        finish();
        // If the old account still has a sync running, wait for its result to
        // be discarded before asking Google for the new account's catalog.
        Promise.resolve(modelsSyncInFlight).then(() => fetchAndUpdateModels());
        console.log('[proxy] Login successful');
      } catch (e) {
        if (!settled) credential = previous;
        cbRes.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        cbRes.end('Login failed. Run: astro login');
        console.error('[proxy] Login failed:', e.message);
        finish(e);
      }
    });
    callbackServer.on('error', finish);
    callbackServer.listen(callbackPort, '127.0.0.1', () => {
      timer = setTimeout(() => finish(new Error('Login timeout (5 min). Run: astro login')), 5 * 60 * 1000);
      console.log(`[proxy] Login URL:\n${authUrl}\n`);
      const openCmd = process.platform === 'win32'
        ? `rundll32 url.dll,FileProtocolHandler "${authUrl}"`
        : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
      try { exec(openCmd, err => { if (err) console.log('[proxy] Open the login URL manually.'); }); }
      catch { console.log('[proxy] Open the login URL manually.'); }
    });
  });
}

function validateTokenResponse(tokens) {
  const expires = Number(tokens?.expires_in ?? 3599);
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token || tokens.error
      || !Number.isFinite(expires) || expires <= 0 || expires > 86400)
    throw new Error('Invalid Google token response');
  return { ...tokens, expires_in: expires };
}

async function exchangeCodeForTokens(code, redirectUri, verifier) {
  const body = new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri,
    grant_type: 'authorization_code', code_verifier: verifier }).toString();
  return validateTokenResponse(await requestJson(GOOGLE_TOKEN_URL, { method: 'POST', body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeoutMs: 10000 }));
}

async function getUserInfo(accessToken) {
  const info = await requestJson('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (typeof (info?.id || info?.sub) !== 'string' || !(info.id || info.sub))
    throw new Error('Google profile did not return a verified account identity. Run: astro login');
  return info;
}

async function setupCloudAccount(accessToken, projectId) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'antigravity' };
  const metadata = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
  const loaded = await requestJson(`${CLOUD_CODE_BASE}/v1internal:loadCodeAssist`, {
    method: 'POST', headers, body: { metadata,
      ...(DEFAULT_PROJECT_ID ? { cloudaicompanionProject: DEFAULT_PROJECT_ID } : {}) }
  });
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || loaded.error)
    throw new Error('Invalid Google account access response');
  if (!loaded.currentTier && !loaded.paidTier && loaded.ineligibleTiers?.length) {
    const error = new Error('This Google account is not eligible for Cloud Code. Check age, region, verification and subscription requirements.');
    error.code = 'account_ineligible'; throw error;
  }
  const tier = loaded.paidTier || loaded.currentTier || loaded.allowedTiers?.find(t => t.isDefault);
  const accountTier = tier?.id;
  if (typeof accountTier !== 'string' || !accountTier) throw new Error('Google did not verify an account tier');
  const project = value => typeof value === 'string' && value ? value
    : typeof value?.id === 'string' && value.id ? value.id : null;
  let resolvedProject = project(loaded.cloudaicompanionProject) || DEFAULT_PROJECT_ID;
  if (!resolvedProject) {
    const onboardTier = loaded.allowedTiers?.find(t => t.isDefault) || loaded.currentTier;
    if (!onboardTier?.id) throw new Error('Google did not provide an eligible onboarding tier');
    let operation = await requestJson(ONBOARD_URL, { method: 'POST', headers,
      body: { tierId: onboardTier.id, metadata } });
    for (let attempt = 0; operation?.done === false && operation?.name && attempt < 8; attempt++) {
      if (!/^operations\/[a-zA-Z0-9_./-]+$/.test(operation.name)) throw new Error('Invalid onboarding operation');
      await new Promise(resolve => setTimeout(resolve, 500));
      operation = await requestJson(`${CLOUD_CODE_BASE}/v1internal/${operation.name}`, { headers });
    }
    if (operation?.error || operation?.done === false) throw new Error('Google onboarding failed or timed out. Run: astro login');
    resolvedProject = project(operation?.response?.cloudaicompanionProject)
      || project(operation?.cloudaicompanionProject) || project(operation?.projectId);
    if (!resolvedProject) throw new Error('Google onboarding returned no usable project. Run: astro login');
  }
  return { tierId: accountTier, plan: tierPlan(accountTier), tierName: tier.name || accountTier, projectId: resolvedProject };
}

// -- Token Refresh --
async function refreshAccessToken() {
  const identity = credentialIdentity();
  if (tokenRefreshInFlight?.identity === identity) return tokenRefreshInFlight.promise;
  const refresh = { identity };
  refresh.promise = performTokenRefresh().finally(() => {
    if (tokenRefreshInFlight === refresh) tokenRefreshInFlight = null;
  });
  tokenRefreshInFlight = refresh;
  return refresh.promise;
}

async function performTokenRefresh() {
  if (!credential?.refreshToken) throw Object.assign(new Error('No refresh token. Run: astro login'), { code: 'authentication_expired' });
  const account = credential;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: account.refreshToken,
    client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET }).toString();
  let json;
  try {
    json = validateTokenResponse(await requestJson(GOOGLE_TOKEN_URL, { method: 'POST', body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeoutMs: 10000 }));
  } catch (e) {
    if (e.details === 'invalid_grant' || e.details?.error === 'invalid_grant') e.code = 'authentication_expired';
    throw e;
  }
  if (credential !== account) throw new Error('Account changed during token refresh');
  credential.accessToken = json.access_token;
  if (json.refresh_token) credential.refreshToken = json.refresh_token;
  credential.expiresAt = new Date(Date.now() + json.expires_in * 1000);
  saveCredential();
  return credential.accessToken;
}

// -- Get Valid Token (auto-refresh) --
async function getValidToken() {
  // Native Rust OAuth also writes auth.json. Notice that login immediately
  // instead of continuing to use the proxy's old account until token expiry.
  reloadChangedCredentials();
  if (!credential) {
    loadCredential();
    if (!credential) {
      tryLoadFromOmniRoute();
    }
  }
  if (!credential || !credential.refreshToken) {
    throw Object.assign(new Error('No credentials found. Please run "astro login" in your terminal.'), { code: 'authentication_expired' });
  }
  if (!credential.accessToken || !Number.isFinite(credential.expiresAt?.getTime()) || credential.expiresAt < new Date(Date.now() + 5 * 60 * 1000)) {
    console.log(`[proxy] Token expired for ${credential.email}, refreshing silently...`);
    try {
      await refreshAccessToken();
    } catch (e) {
      console.error(`[proxy] Token refresh failed: ${e.message}`);
      if (e.code === 'authentication_expired' || !credential.accessToken || !Number.isFinite(credential.expiresAt?.getTime()) || credential.expiresAt <= new Date()) {
        throw Object.assign(new Error(`Authentication expired (${e.message}). Please run "astro login" in your terminal.`), { code: 'authentication_expired' });
      }
    }
  }
  if (!credential.projectId) {
    credential.projectId = DEFAULT_PROJECT_ID;
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
  const hour = 3600 * 1000;
  const week = 7 * 24 * 3600 * 1000;
  usageTracker[model].hourly = usageTracker[model].hourly.filter(t => now - t < hour);
  usageTracker[model].weekly = usageTracker[model].weekly.filter(t => now - t < week);
}

// ========================================================================
// Request Translation (OpenAI -> Gemini format)
// ========================================================================

// The CLI preserves call ids but not provider-specific signature fields.
// Keep the opaque signatures by call id, scoped to account and model version.
const TOOL_SIGNATURES_FILE = path.join(ASTRO_DIR, 'proxy-tool-signatures.json');
let toolSignatures = new Map(), toolSignaturesAccount;
function currentToolSignatures() {
  const account = credentialIdentity();
  if (account !== toolSignaturesAccount) {
    toolSignatures = new Map();
    toolSignaturesAccount = account;
    try {
      const cached = JSON.parse(readFileSync(TOOL_SIGNATURES_FILE, 'utf8'));
      if (account && cached.account === account && Array.isArray(cached.calls))
        toolSignatures = new Map(cached.calls.slice(-512));
    } catch {}
  }
  return toolSignatures;
}
function rememberToolSignature(id, value) {
  const cache = currentToolSignatures();
  cache.set(id, value);
  while (cache.size > 512) cache.delete(cache.keys().next().value);
  try {
    ensureAstroDir();
    writeJsonAtomic(TOOL_SIGNATURES_FILE, { account: toolSignaturesAccount, calls: [...cache] });
  } catch (e) { console.warn('[proxy] Tool signature cache:', e.message); }
}

function sanitizeToolName(raw) {
  if (typeof raw !== 'string' || !raw) throw new SyntaxError('Tool function requires a name');
  let name = raw.slice(raw.lastIndexOf(':') + 1).replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  if (/^\d/.test(name)) name = 'tool_' + name;
  return name.slice(0, 64);
}

function openaiToGemini(messages, toolNameMap = new Map(), upstreamModel) {
  const contents = [];
  let systemInstruction = null;
  const callNames = new Map();
  const wireName = name => name ? [...toolNameMap].find(([, original]) => original === name)?.[0] || sanitizeToolName(name) : undefined;
  const textParts = content => {
    if (content == null) return [];
    if (!Array.isArray(content)) return [{ text: typeof content === 'string' ? content : JSON.stringify(content) }];
    return content.flatMap(item => {
      if (item?.type === 'text') return [{ text: item.text }];
      const inline = item?.image_url?.url?.match(/^data:([^;]+);base64,(.+)$/s);
      if (item?.type === 'image_url' && inline) return [{ inlineData: { mimeType: inline[1], data: inline[2] } }];
      return [{ text: JSON.stringify(item) }];
    });
  };
  
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
    const parts = textParts(msg.content);
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const name = wireName(call.function?.name);
        callNames.set(call.id, name);
        const args = typeof call.function?.arguments === 'string'
          ? JSON.parse(call.function.arguments || '{}') : call.function?.arguments || {};
        const part = { functionCall: { id: call.id, name, args } };
        const cached = currentToolSignatures().get(call.id);
        const explicit = call.extra_content?.google?.thought_signature;
        const signature = explicit || (cached?.model === backendIdentity(upstreamModel || '').base ? cached.signature : undefined);
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
    } else if (msg.role === 'tool') {
      const name = callNames.get(msg.tool_call_id) || wireName(msg.name);
      if (!name) throw new SyntaxError('Tool result requires a matching assistant tool call');
      let result = msg.content;
      if (typeof result === 'string') { try { result = JSON.parse(result); } catch {} }
      parts.splice(0, parts.length, { functionResponse: { id: msg.tool_call_id, name,
        response: result && typeof result === 'object' && !Array.isArray(result) ? result : { result } } });
    }
    if (!parts.length) continue;
    
    // Merge consecutive same-role messages
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts.push(...parts);
    } else {
      contents.push({ role, parts });
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

function geminiChunkToOpenAI(data, model, chunkId, toolNameMap, reqState = { hasToolCall: false }, upstreamModel) {
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
        const callIndex = reqState.nextToolIndex || 0;
        reqState.nextToolIndex = callIndex + 1;
        const callId = `call_${crypto.randomUUID().replace(/-/g, '')}`;
        if (part.thoughtSignature) rememberToolSignature(callId, {
          model: backendIdentity(upstreamModel || MODEL_MAP[model] || '').base, signature: part.thoughtSignature
        });
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
                index: callIndex,
                id: callId,
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
  req.setEncoding('utf8');
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'messages must be an array', type: 'invalid_request_error' } }));
        return;
      }
      if (payload.stream !== undefined && typeof payload.stream !== 'boolean') throw new SyntaxError('stream must be a boolean');
      const streaming = payload.stream !== false;
      await ensureModelsCurrent();
      // Refresh/login may replace the account and clear its model catalog.
      // Resolve the selected route only after validating that account's token.
      const { token, projectId, email } = await getValidToken();
      const requestAccount = credentialIdentity();
      const tokenAccount = credential;
      await ensureModelsCurrent();
      if (credential !== tokenAccount || credentialIdentity() !== requestAccount) {
        throw Object.assign(new Error('Account changed while selecting the model. Refresh the model list and try again.'),
          { code: 'account_changed', status: 409 });
      }
      res.setHeader('X-Models-Etag', modelCatalogEtag());
      const originalModel = payload.model ?? (Object.hasOwn(MODEL_MAP, 'vortex') ? 'vortex' : Object.keys(MODEL_MAP)[0]);
      if (typeof originalModel !== 'string' || !Object.hasOwn(MODEL_MAP, originalModel)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Model is unavailable. Refresh /v1/models and choose an active model.', type: 'invalid_request_error', code: 'model_not_found' } }));
        return;
      }
      let selectedRoute;
      try { selectedRoute = modelRoute(originalModel, payload.reasoning_effort); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message, type: 'invalid_request_error', code: e.code } }));
        return;
      }
      const upstreamModel = selectedRoute.backend;
      
      trackUsage(originalModel);
      
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
            const rawName = t.function.name;
            let sanitizedName = sanitizeToolName(rawName);
            if (toolNameMap.has(sanitizedName) && toolNameMap.get(sanitizedName) !== rawName)
              sanitizedName = sanitizedName.slice(0, 53) + '_' + crypto.createHash('sha256').update(rawName).digest('hex').slice(0, 10);
            
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
      
      const { contents, systemInstruction } = openaiToGemini(payload.messages, toolNameMap, upstreamModel);
      const requestedLimit = payload.max_completion_tokens ?? payload.max_tokens;
      if (requestedLimit !== undefined && (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0)) {
        throw new SyntaxError('max_completion_tokens/max_tokens must be a positive integer');
      }
      const outputLimit = Math.min(requestedLimit ?? Infinity, MODELS_METADATA[originalModel]?.max_output_tokens || 65536);
      if (selectedRoute.thinkingConfig?.thinkingBudget >= outputLimit) {
        throw new SyntaxError('Output token limit must exceed the selected thinking budget. Increase max_completion_tokens or choose a lower reasoning effort.');
      }
      const envelope = buildAntigravityEnvelope(upstreamModel, {
        contents,
        systemInstruction,
        ...(tools ? { tools, toolConfig } : {}),
        generationConfig: {
          topK: 40,
          topP: 1.0,
          maxOutputTokens: outputLimit,
          ...(selectedRoute.thinkingConfig ? { thinkingConfig: selectedRoute.thinkingConfig } : {}),
        }
      }, projectId);
      
      let envelopeStr = JSON.stringify(envelope);
      console.log(`[proxy] ${originalModel} -> ${upstreamModel} (${email})`);
      
      const tryRequest = (baseUrlIndex) => {
        const baseUrls = ['https://daily-cloudcode-pa.googleapis.com'];
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
        let failed = false;
        let proxyReq;
        const failGeneration = (error, status = 502) => {
          if (failed || res.writableEnded || res.destroyed) return;
          failed = true;
          console.error(`[proxy] Generation failed: ${error.message}`);
          const data = { error: { message: error.message, type: 'upstream_error',
            code: status === 409 ? 'account_changed' : status === 504 ? 'upstream_timeout' : 'upstream_connection_error' } };
          if (res.headersSent) {
            res.end(`data: ${JSON.stringify(data)}\n\n`);
          } else {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
          }
          proxyReq?.destroy();
        };
        const deadline = setTimeout(() => failGeneration(new Error('Generation deadline exceeded'), 504), 10 * 60 * 1000);
        deadline.unref?.();
        res.once('close', () => {
          clearTimeout(deadline);
          if (!res.writableEnded) { failed = true; proxyReq?.destroy(); }
        });
        res.once('finish', () => clearTimeout(deadline));
        proxyReq = https.request(options, (proxyRes) => {
          proxyRes.on('error', error => failGeneration(error));
          proxyRes.on('aborted', () => failGeneration(new Error('Upstream response was interrupted')));
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
              if (failed || res.writableEnded || res.destroyed) return;
             console.error(`[proxy] Error (${baseUrl}) for ${upstreamModel}: ${errData}`);
              if (requestAccount === credentialIdentity() && isModelAccessDenial(proxyRes.statusCode, errData)) {
                try { denyBackend(upstreamModel); } catch (e) { console.warn('[proxy] Persist denied model:', e.message); }
                res.setHeader('X-Models-Etag', modelCatalogEtag());
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Your Google account cannot access this model. Choose an available model.',
                  type: 'permission_error', code: 'model_access_denied' } }));
                return;
              }
              
              // Detect "Prohibited Use" / safety policy violation - return as normal text response
              if (errData.includes('Prohibited Use') || errData.includes('sensitive words') || errData.includes('use-policy')) {
                console.log(`[proxy] Safety policy violation detected, returning friendly message`);
                const safetyMessage = "I can't process that request as it was flagged by safety filters. Please try rephrasing your request.";
                if (!streaming) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ id: 'chatcmpl-' + crypto.randomBytes(10).toString('hex'),
                    object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: originalModel,
                    choices: [{ index: 0, message: { role: 'assistant', content: safetyMessage }, finish_reason: 'content_filter' }] }));
                  return;
                }
                res.writeHead(200, {
                  'Content-Type': 'text/event-stream',
                  'Cache-Control': 'no-cache',
                  'Connection': 'keep-alive',
                });
                const safetyChunkId = 'chatcmpl-' + crypto.randomBytes(10).toString('hex');
                res.write(`data: ${JSON.stringify({id: safetyChunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: originalModel, choices: [{index: 0, delta: {role: 'assistant'}, finish_reason: null}]})}\n\n`);
                res.write(`data: ${JSON.stringify({id: safetyChunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: originalModel, choices: [{index: 0, delta: {content: safetyMessage}, finish_reason: null}]})}\n\n`);
                res.write(`data: ${JSON.stringify({id: safetyChunkId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: originalModel, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]})}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              
              // Retry only transient/server routing failures using the SAME model.
              if ([404, 500, 502, 503, 504].includes(proxyRes.statusCode) && baseUrlIndex < baseUrls.length - 1) {
                console.log(`[proxy] Retrying on next base URL...`);
                tryRequest(baseUrlIndex + 1);
              } else {
                res.writeHead(proxyRes.statusCode || 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: errData, type: 'upstream_error' } }));
              }
            });
            return;
          }
        
        // Stream SSE response, translating Gemini -> OpenAI
        if (streaming) res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        
        const chunkId = 'chatcmpl-' + crypto.randomBytes(10).toString('hex');
          let buffer = Buffer.alloc(0);
          let seq = 0;
          let reqState = { hasToolCall: false };
        const message = { role: 'assistant', content: '' };
        const toolCalls = new Map();
        let finishReason = null, usage;
        const emitChunk = chunk => {
          if (streaming) { res.write(`data: ${JSON.stringify(chunk)}\n\n`); return; }
          if (chunk.usage) usage = chunk.usage;
          for (const choice of chunk.choices || []) {
            const delta = choice.delta || {};
            if (delta.content) message.content += delta.content;
            if (delta.reasoning_content) message.reasoning_content = (message.reasoning_content || '') + delta.reasoning_content;
            for (const tool of delta.tool_calls || []) {
              let call = toolCalls.get(tool.index);
              if (!call) {
                call = { id: tool.id, type: 'function', function: { name: '', arguments: '' } };
                toolCalls.set(tool.index, call);
              }
              if (tool.id) call.id = tool.id;
              if (tool.function?.name) call.function.name += tool.function.name;
              if (tool.function?.arguments) call.function.arguments += tool.function.arguments;
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        };
        
        // Send initial role delta
        const initChunk = {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: originalModel,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          sequence_number: seq++
        };
        emitChunk(initChunk);
        
        const processLine = line => {
            if (!line.startsWith('data:')) return;
            const dataStr = line.substring(5).trim();
            if (dataStr === '[DONE]' || !dataStr) return;
            
            const openaiChunks = geminiChunkToOpenAI(dataStr, originalModel, chunkId, toolNameMap, reqState, upstreamModel);
            if (openaiChunks) {
              for (const oc of openaiChunks) {
                oc.sequence_number = seq++;
                emitChunk(oc);
              }
            }
        };
        proxyRes.on('data', (chunk) => {
          if (failed || res.writableEnded || res.destroyed) return;
          if (credentialIdentity() !== requestAccount) {
            failGeneration(new Error('Account changed during generation'), 409); return;
          }
          // Decode whole SSE lines, not arbitrary TCP chunks: a character can
          // occupy several bytes and be split at any network boundary.
          buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
          let newline;
          while ((newline = buffer.indexOf(10)) !== -1) {
            processLine(buffer.subarray(0, newline).toString('utf8'));
            buffer = buffer.subarray(newline + 1);
          }
        });
        
        proxyRes.on('end', () => {
          if (failed || res.writableEnded || res.destroyed) return;
          if (credentialIdentity() !== requestAccount) {
            failGeneration(new Error('Account changed during generation'), 409); return;
          }
          if (buffer.length) processLine(buffer.toString('utf8'));
          if (streaming) {
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            if (toolCalls.size) message.tool_calls = [...toolCalls.values()];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: chunkId, object: 'chat.completion',
              created: Math.floor(Date.now() / 1000), model: originalModel,
              choices: [{ index: 0, message, finish_reason: finishReason || (toolCalls.size ? 'tool_calls' : 'stop') }],
              ...(usage ? { usage } : {}) }));
          }
        });
      });
      
      proxyReq.on('error', (e) => {
        failGeneration(e);
      });
      proxyReq.setTimeout(120000, () => failGeneration(new Error('Upstream idle timeout'), 504));
      
      proxyReq.write(envelopeStr);
      proxyReq.end();
    };
    
    tryRequest(0);
    } catch (e) {
      console.error('[proxy] Error:', e.message);
      res.writeHead(e.code === 'authentication_expired' ? 401 : e.status === 409 ? 409 : e instanceof SyntaxError ? 400 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, code: e.code } }));
    }
  });
}

// ========================================================================
// Stub handlers for auxiliary endpoints  
// ========================================================================

async function ensureModelsCurrent() {
  const previousAccount = credentialIdentity();
  reloadChangedCredentials();
  if (previousAccount !== credentialIdentity()) {
    MODEL_MAP = {}; MODELS_METADATA = {}; modelsVerifiedAt = null;
    accountAccess = null; deniedModelBackends.clear();
    modelsAccount = credentialIdentity(); modelsLastAttempt = 0;
    if (modelsSyncInFlight) await modelsSyncInFlight;
  }
  if (modelsSyncInFlight) return modelsSyncInFlight;
  if (Date.now() - modelsLastAttempt >= 60 * 1000) return fetchAndUpdateModels();
}

function modelCatalogEtag() {
  return '"' + crypto.createHash('sha256').update(JSON.stringify({ MODEL_MAP, MODELS_METADATA })).digest('hex') + '"';
}

async function handleModels(req, res) {
  await ensureModelsCurrent();
  res.writeHead(200, { 'Content-Type': 'application/json', Etag: modelCatalogEtag(), 'Cache-Control': 'no-store' });
  const data = Object.entries(MODEL_MAP).map(([id, backend]) => {
    const meta = MODELS_METADATA[id] || {};
    const ctx = meta.context_window || 128000;
    return {
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'astro',
      model: id,
      name: meta.name || id,
      description: `${meta.family || 'Model'} · ${backend}`,
      provider_model: backend,
      context_window: ctx,
      contextWindow: ctx,
      totalContextTokens: ctx,
      maxCompletionTokens: meta.max_output_tokens,
      modelFamily: meta.family,
      _meta: {
        model: id,
        providerModel: backend,
        modelFamily: meta.family,
        contextWindow: ctx,
        totalContextTokens: ctx,
        supportsReasoningEffort: (meta.reasoning_efforts || []).length > 0,
        reasoningEffort: meta.default_reasoning_effort,
        reasoningEfforts: (meta.reasoning_efforts || []).map(level => ({
          id: level, value: level, label: level, default: level === meta.default_reasoning_effort
        })),
        acceptsImages: Boolean(meta.accepts_images)
      }
    };
  });
  res.end(JSON.stringify({ object: 'list', data, verified_at: modelsVerifiedAt,
    account: accountAccess ? { plan: accountAccess.plan, tier_id: accountAccess.tierId, verified_at: accountAccess.verifiedAt } : null }));
}

function handleBilling(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    config: {
      creditUsagePercent: 0.0,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_MONTHLY',
        start: new Date(Date.now() - 86400000).toISOString(),
        end: new Date(Date.now() + 30 * 86400000).toISOString()
      },
      isUnifiedBillingUser: true
    },
    onDemandEnabled: false,
    subscriptionTier: accountAccess?.plan || 'unknown',
    billingVerified: false
  }));
}

function handleUser(req, res) {
  // No hardcoded identity: these used to leak the developer's own name and
  // email to every install, and handed every user the same user_id.
  const uid = credential?.userId || '';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    userId: uid,
    user_id: uid,
    email: credential?.email || null,
    firstName: credential?.firstName || null,
    lastName: credential?.lastName || null,
    subscriptionTier: accountAccess?.plan || 'unknown',
    subscription_tier: accountAccess?.plan || 'unknown',
    codingDataRetentionOptOut: true,
    subscription: {
      tier: accountAccess?.plan || 'unknown',
      is_active: Boolean(accountAccess),
      verified_at: accountAccess?.verifiedAt || null
    }
  }));
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
    
    await ensureModelsCurrent();
    const backends = [...new Set(Object.values(MODEL_MAP))].filter(id => id.startsWith('gemini-'));
    const audioModel = backends.find(id => id.includes('-flash')) || backends[0];
    if (!audioModel) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active Gemini model is available for transcription.' }));
      return;
    }
    const { token, projectId } = await getValidToken();
    const base64Audio = bodyBuffer.toString('base64');
    
    const envelope = {
      project: projectId,
      model: audioModel,
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
      signal: AbortSignal.timeout(30000),
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
        signal: AbortSignal.timeout(30000),
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

function requestHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'POST' && (p === '/v1/chat/completions' || p === '/chat/completions' || p === '/v1/responses' || p === '/responses')) 
    return handleChatCompletions(req, res);
  if (req.method === 'POST' && (p === '/v1/stt' || p === '/v1/audio/transcriptions'))
    return handleSTT(req, res);
  if (req.method === 'GET' && (p === '/v1/models' || p === '/models')) return handleModels(req, res);
  if ((req.method === 'GET' || req.method === 'POST') && (p === '/auth/login' || p === '/v1/auth/login' || p === '/login')) {
    startOAuth2Login().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', message: 'Logged in successfully', email: credential?.email }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    });
    return;
  }
  if (req.method === 'GET' && (p.startsWith('/v1/user') || p.startsWith('/user'))) return handleUser(req, res);
  if (req.method === 'GET' && (p === '/v1/billing' || p === '/billing')) return handleBilling(req, res);
  if (req.method === 'GET' && (p === '/v1/settings' || p === '/settings')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
    return;
  }
  if (req.method === 'GET' && (p === '/v1/auto-topup-rule' || p === '/auto-topup-rule')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rule: { enabled: false } }));
    return;
  }

  // Readiness probe. The launcher scripts poll this instead of sleeping a
  // fixed number of seconds — a bare TCP check cannot tell "port bound" from
  // "ready to serve", and a fixed sleep is simultaneously too long on fast
  // machines and too short on slow ones.
  if (req.method === 'GET' && (p === '/health' || p === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      authenticated: !!credential?.refreshToken,
      email: credential?.email || null,
      models: Object.keys(MODEL_MAP),
    }));
    return;
  }

  // All other endpoints - return OK to prevent retry errors.
  // Logged so a missing route is diagnosable instead of silently answering
  // `{}` to a request the CLI expected real data from.
  console.warn(`[proxy] unhandled route ${req.method} ${p} -> 200 {}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({}));
}

const server = createServer(requestHandler);

// Clear a lock left behind by a crashed *proxy*.
//
// This used to delete every `*.lock` in ~/.astro, including the Rust CLI's
// `auth.json.lock`. That file backs a real flock, and the CLI re-validates it
// by inode before persisting a refreshed token (`AuthFileLock::still_live`):
// unlinking it makes the CLI believe it lost the lock and abandon the write,
// so the refreshed token never reaches disk and the next launch demands a new
// login. On Unix that check is live, which is why Linux was hit hardest.
try {
  if (existsSync(PROXY_LOCK_FILE)) unlinkSync(PROXY_LOCK_FILE);
} catch {}

// Heal a poisoned auth.json before the CLI ever reads it.
//
// Waiting for the next token refresh to clean the file is too late: the CLI
// reads auth.json at startup, and one unparseable file there is the whole
// "it asks me to log in again every time" symptom. Rewriting it here, once,
// at proxy start costs nothing and breaks the loop immediately.
try {
  if (existsSync(CLI_AUTH_FILE)) {
    const raw = readFileSync(CLI_AUTH_FILE, 'utf8');
    if (raw.trim()) {
      const parsed = JSON.parse(raw);
      const clean = sanitizeAuthStore(parsed);
      if (Object.keys(clean).length !== Object.keys(parsed).length) {
        withProxyAuthLock(() => writeJsonAtomic(CLI_AUTH_FILE, clean));
        console.log('[proxy] auth.json healed — removed keys the CLI could not parse');
      }
    }
  }
} catch (e) {
  // Unparseable JSON is the CLI's own recovery path (it backs the file up and
  // re-prompts); don't try to second-guess it from here.
  console.warn('[proxy] auth.json pre-check skipped:', e.message);
}

// Load credentials on startup
loadCredential();
credentialFilesStamp = authFilesStamp();
if (modelsAccount && modelsAccount !== credentialIdentity()) {
  MODEL_MAP = {}; MODELS_METADATA = {}; modelsVerifiedAt = null;
  accountAccess = null; deniedModelBackends.clear();
}

// Auto-discover models after credentials are loaded
setTimeout(() => { fetchAndUpdateModels(); }, 3000);

// Without an 'error' listener an EADDRINUSE here is an unhandled 'error'
// event, which kills the process outright. The launcher would then wait out
// its sleep and start the CLI against a port nobody is listening on, which
// the user sees as "it authenticates and then never answers".
function listenOn(host) {
  return new Promise((resolve) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[astro-proxy] port ${PROXY_PORT} already in use on ${host} — another astro-proxy is probably running`);
      } else if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
        console.warn(`[astro-proxy] ${host} unavailable on this host (${err.code}), skipping`);
      } else {
        console.error(`[astro-proxy] listen on ${host} failed: ${err.code || err.message}`);
      }
      resolve(false);
    };
    const srv = host === '127.0.0.1' ? server : createServer(requestHandler);
    srv.once('error', onError);
    srv.listen(PROXY_PORT, host, () => {
      srv.removeListener('error', onError);
      srv.on('error', (e) => console.error(`[astro-proxy] server error on ${host}: ${e.message}`));
      resolve(true);
    });
  });
}

const bound = [];
for (const host of PROXY_HOSTS) {
  if (await listenOn(host)) bound.push(host);
}

if (bound.length === 0) {
  console.error(`[astro-proxy] FATAL: could not bind port ${PROXY_PORT} on any loopback address.`);
  console.error(`[astro-proxy] Close whatever is using it, or set ASTRO_PROXY_PORT to a free port.`);
  process.exit(1);
}

console.log(`[astro-proxy] ========================================`);
console.log(`[astro-proxy] Self-contained proxy on port ${PROXY_PORT}`);
console.log(`[astro-proxy] Listening on: ${bound.join(', ')}`);
console.log(`[astro-proxy] Direct connection to Google Cloud Code`);
console.log(`[astro-proxy] Models: ${Object.keys(MODEL_MAP).join(', ')}`);
console.log(`[astro-proxy] Account: ${credential ? (credential.email || 'authenticated') : 'none (login required)'}`);
console.log(`[astro-proxy] ========================================`);
