const express = require("express");
const router = express.Router();
const { findApiKey, findUser, logRequest, consumeQuota, isUnlimitedApiKey, read } = require("../lib");
const AlightMotionAuth = require("../services/AlightMotionAuth");
const service = new AlightMotionAuth();

function auth(req, res, next) {
  const raw = req.get("authorization") || "";
  const key = raw.startsWith("Bearer ") ? raw.slice(7).trim() : (req.get("x-api-key") || "");
  const apiKey = findApiKey(key);
  if (!apiKey) return res.status(401).json({ success: false, error: { code: "INVALID_API_KEY", message: "API key is invalid or inactive." } });
  req.apiKey = apiKey;
  req.apiUser = findUser(apiKey.userId);
  if (req.path !== "/checkstatus") {
    const quota = consumeQuota(apiKey);
    if (!quota.allowed) return res.status(429).json({ success: false, error: { code: "QUOTA_EXCEEDED", message: "Daily quota exhausted.", quota: { used: quota.used, limit: quota.limit, remaining: 0, reset_at: quota.resetAt } } });
    req.quota = quota;
  }
  next();
}
function audit(req, status, startedAt) {
  logRequest({ userId: req.apiUser?.id || null, apiKeyId: req.apiKey?.id || null, endpoint: req.originalUrl, method: req.method, status, durationMs: Date.now() - startedAt, ip: req.ip });
}

// 1. Check API key status/quota
router.get("/checkstatus", auth, (req, res) => {
  const started = Date.now();
  const mine = read("requests.json").filter(x => x.apiKeyId === req.apiKey.id);
  const fresh = findApiKey(req.apiKey.key);
  audit(req, 200, started);
  const unlimited = isUnlimitedApiKey(fresh);
  const limit = unlimited ? null : Number(fresh.quotaLimit ?? fresh.limit ?? 50);
  const used = Number(fresh.quotaUsed || 0);
  res.json({
    success: true,
    status: fresh.active ? "active" : "inactive",
    api_key: {
      name: fresh.name,
      plan: unlimited ? "admin" : fresh.plan,
      requests: mine.length,
      quota: {
        unlimited,
        used: unlimited ? null : used,
        limit,
        remaining: unlimited ? null : Math.max(0, limit - used),
        reset_at: unlimited ? null : (fresh.quotaResetAt || null)
      }
    }
  });
});

// 2. Request magic link to an email
router.post("/request", auth, async (req, res) => {
  const started = Date.now();
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    audit(req, 400, started);
    return res.status(400).json({ success: false, error: { code: "INVALID_EMAIL", message: "A valid email is required." } });
  }
  const result = await service.sendMagicLink(email);
  audit(req, result.success ? 200 : 502, started);
  if (!result.success) return res.status(502).json({ success: false, error: { code: "UPSTREAM_ERROR", message: String(result.error) } });
  res.json({ success: true, message: result.message, data: { email: email.replace(/^(.).+(@.*)$/, "$1***$2"), expires_in: 300 } });
});

// 3. Process a magic link supplied by the user
router.post("/linkmagic", auth, async (req, res) => {
  const started = Date.now();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const magicLink = String(req.body?.magic_link || req.body?.link || "").trim();
  
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !magicLink) {
    audit(req, 400, started);
    return res.status(400).json({ 
      success: false, 
      error: { code: "MISSING_FIELDS", message: "email and magic_link are required." } 
    });
  }

  // 🔥 STEP 1: VERIFY MAGIC LINK
  const result = await service.verifyAndFetchProfile(email, magicLink);
  
  if (!result.success) {
    audit(req, 400, started);
    return res.status(400).json({ 
      success: false, 
      error: { code: "INVALID_MAGIC_LINK", message: String(result.error) } 
    });
  }

  // 🔥 STEP 2: GET USER DATA
  const user = result.user || {};
  const idToken = result.idToken;
  let premiumActive = false;
  let premiumData = null;

  // 🔥 STEP 3: CEK CUSTOM CLAIMS DARI FIREBASE
  try {
    const axios = require("axios");
    const accountInfo = await axios.post(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${service.API_KEY}`,
      { idToken },
      { headers: service.HEADERS }
    );
    const userData = accountInfo.data.users[0];
    if (userData?.customAttributes) {
      try {
        const custom = JSON.parse(userData.customAttributes);
        if (custom?.premium === true || custom?.isPremium === true) {
          premiumActive = true;
          console.log(`[API] ✅ User already premium from custom claims: ${email}`);
        }
      } catch (_) {}
    }
  } catch (_) {}

  // 🔥 STEP 4: KALO BELUM, COBA APPLY PREMIUM
  if (!premiumActive && idToken) {
    try {
      const premiumResult = await service.applyPremium(idToken);
      if (premiumResult.success) {
        premiumActive = true;
        premiumData = premiumResult.data;
        console.log(`[API] ✅ Premium applied successfully for ${email}`);
      } else {
        console.log(`[API] ❌ Premium apply failed: ${premiumResult.error}`);
      }
    } catch (err) {
      console.log(`[API] ❌ Premium error: ${err.message}`);
    }
  }

  // 🔥 STEP 5: RESPONSE DENGAN PREMIUM STATUS
  // 🔥 STEP 5: RESPONSE DENGAN PREMIUM STATUS
audit(req, 200, started);

const responseData = {
  status: premiumActive ? "completed" : (user.emailVerified ? "premium_unverified" : "failed"),
  user: {
    localId: user.localId || null,
    email: user.email || email,
    emailVerified: user.emailVerified === true,
    premiumActive: premiumActive,  // ✅ SUDAH ADA!
    premiumData: premiumData || null,
    idToken: idToken
  }
};

console.log(`[API] Response data:`, JSON.stringify(responseData, null, 2));

res.json({
  success: true,
  message: premiumActive ? "✅ Premium aktif!" : "⚠️ Email terverifikasi, Premium belum aktif.",
  data: responseData
});
});

module.exports = router;
  
