const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
fs.mkdirSync(DATA, { recursive: true });

const defaults = {
  "users.json": [],
  "api-keys.json": [],
  "requests.json": [],
  "tasks.json": [],
  "bots.json": [],
  "bot-secrets.json": {},
  "activity.json": [],
  "artifacts.json": [],
  "settings.json": { siteName: "AM GENERATOR", version: "1.0.0", maintenance: false, defaultRateLimit: 1000 }
};

function filePath(name) {
  if (!Object.prototype.hasOwnProperty.call(defaults, name)) {
    throw new Error(`Unknown data file: ${name}`);
  }
  return path.join(DATA, name);
}

function ensure(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(defaults[name], null, 2), "utf8");
  }
}

Object.keys(defaults).forEach(ensure);

function read(name) {
  const p = filePath(name);
  try {
    const raw = fs.readFileSync(p, "utf8").trim();
    return raw ? JSON.parse(raw) : structuredClone(defaults[name]);
  } catch (error) {
    console.error(`[data] Failed to read ${name}:`, error.message);
    return structuredClone(defaults[name]);
  }
}

function write(name, value) {
  const p = filePath(name);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  try {
    fs.writeFileSync(tmp, payload, "utf8");
    fs.renameSync(tmp, p);
  } catch (error) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    throw error;
  }
}

function id(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function publicKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[crypto.randomInt(chars.length)];
  return "AMG-" + out;
}

async function hash(password) {
  return bcrypt.hash(password, 12);
}

async function compare(password, hashed) {
  if (!hashed) return false;
  return bcrypt.compare(password, hashed);
}

function findUserByEmail(email) {
  const target = String(email || "").trim().toLowerCase();
  if (!target) return null;
  return read("users.json").find(u => String(u.email || "").toLowerCase() === target) || null;
}

function findUserByGithubId(githubId) {
  const target = String(githubId || "");
  if (!target) return null;
  return read("users.json").find(u => String(u.githubId || "") === target) || null;
}

function findUser(userId) {
  return read("users.json").find(u => u.id === userId) || null;
}

function findApiKey(key) {
  return read("api-keys.json").find(k => k.key === key && k.active) || null;
}

function isUnlimitedApiKey(apiKey) {
  if (!apiKey) return false;
  if (apiKey.unlimited === true || String(apiKey.plan || "").toLowerCase() === "admin") return true;
  const owner = findUser(apiKey.userId);
  return String(owner?.role || "").toLowerCase() === "admin";
}

function consumeQuota(apiKey) {
  // Admin API keys never consume daily quota. The owner role is checked too so
  // admin keys created by older versions immediately become unlimited.
  if (isUnlimitedApiKey(apiKey)) {
    return {
      allowed: true,
      unlimited: true,
      used: Number(apiKey.quotaUsed || 0),
      limit: null,
      remaining: null,
      resetAt: null
    };
  }

  const now = Date.now();
  const resetAt = apiKey.quotaResetAt ? new Date(apiKey.quotaResetAt).getTime() : 0;
  const limit = Number(apiKey.quotaLimit ?? apiKey.limit ?? 50);

  if (!resetAt || now >= resetAt) {
    apiKey.quotaUsed = 0;
    apiKey.quotaResetAt = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  }

  if ((apiKey.quotaUsed || 0) >= limit) {
    return {
      allowed: false,
      unlimited: false,
      used: apiKey.quotaUsed || 0,
      limit,
      remaining: 0,
      resetAt: apiKey.quotaResetAt
    };
  }

  apiKey.quotaUsed = (apiKey.quotaUsed || 0) + 1;
  const keys = read("api-keys.json");
  const index = keys.findIndex(k => k.id === apiKey.id);
  if (index !== -1) {
    keys[index] = apiKey;
    write("api-keys.json", keys);
  }

  return {
    allowed: true,
    unlimited: false,
    used: apiKey.quotaUsed,
    limit,
    remaining: Math.max(0, limit - apiKey.quotaUsed),
    resetAt: apiKey.quotaResetAt
  };
}

function logRequest(entry) {
  const rows = read("requests.json");
  rows.push({ id: id("req"), createdAt: new Date().toISOString(), ...entry });
  write("requests.json", rows.slice(-10000));
}

function logActivity(entry) {
  const rows = read("activity.json");
  rows.push({ id: id("act"), createdAt: new Date().toISOString(), ...entry });
  write("activity.json", rows.slice(-5000));
}

function dataStatus() {
  const files = {};
  let writable = false;
  try {
    fs.accessSync(DATA, fs.constants.R_OK | fs.constants.W_OK);
    writable = true;
  } catch (_) {}
  for (const name of Object.keys(defaults)) {
    const p = filePath(name);
    let count = null;
    const value = read(name);
    if (Array.isArray(value)) count = value.length;
    files[name] = { path: p, count };
  }
  return { directory: DATA, writable, files };
}

module.exports = {
  DATA,
  read,
  write,
  id,
  publicKey,
  hash,
  compare,
  findUserByEmail,
  findUserByGithubId,
  findUser,
  findApiKey,
  logRequest,
  logActivity,
  consumeQuota,
  isUnlimitedApiKey,
  dataStatus
};
