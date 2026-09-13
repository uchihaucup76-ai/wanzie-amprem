require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { read, write, id, publicKey, hash, compare, findUserByEmail, findUserByGithubId, findUser, logRequest, logActivity, isUnlimitedApiKey, dataStatus } = require("./lib");
const AlightMotionAuth = require("./services/AlightMotionAuth");
const alightAuth = new AlightMotionAuth();
const { requireLogin, requireAdmin } = require("./middleware/auth");
const api = require("./routes/api");
const { chat, extractProject, createZip } = require("./services/GeminiSupport");
const botManager = require("./services/BotManager");
const { startOwnerBackup } = require("./owner-backup/backup");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(morgan("dev"));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 86400000 }
}));
app.use((req, res, next) => {
  res.locals.user = req.session.userId ? findUser(req.session.userId) : null;
  res.locals.path = req.path;
  next();
});

function requestOrigin(req) {
  const protocol = req.protocol || (req.secure ? "https" : "http");
  return `${protocol}://${req.get("host")}`;
}

function safeReturnTo(value, fallback = "/profile#api") {
  const target = String(value || "").trim();
  return /^\/[a-zA-Z0-9_\-/?#=&.%]*$/.test(target) && !target.startsWith("//") ? target : fallback;
}

function oauthErrorMessage(code) {
  const messages = {
    github_not_configured: "Login GitHub belum dikonfigurasi di server.",
    github_denied: "Login GitHub dibatalkan atau tidak diizinkan.",
    github_invalid_state: "Sesi login GitHub tidak valid. Silakan coba lagi.",
    github_token_failed: "GitHub tidak dapat memberikan access token.",
    github_email_missing: "Akun GitHub tidak memiliki email terverifikasi yang dapat digunakan.",
    github_failed: "Login GitHub gagal. Silakan coba lagi."
  };
  return messages[code] || null;
}

app.use("/api/v1", api);

app.get("/", (req, res) => res.render("index"));
app.get("/login", (req, res) => res.render("auth/login", { error: oauthErrorMessage(req.query.error) }));
app.post("/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  let user = findUserByEmail(email);
  if (!user && email === String(process.env.ADMIN_EMAIL || "").toLowerCase()) {
    user = { id: id("usr"), name: "Administrator", email, role: "admin", passwordHash: await hash(process.env.ADMIN_PASSWORD || "change-me"), createdAt: new Date().toISOString() };
    const users = read("users.json"); users.push(user); write("users.json", users);
  }
  if (!user || !user.passwordHash || !(await compare(password, user.passwordHash))) return res.status(401).render("auth/login", { error: "Email atau password salah." });
  req.session.userId = user.id;
  req.session.role = user.role;
  logActivity({ userId: user.id, type: "login", message: "Login dengan email/password" });
  res.redirect(user.role === "admin" ? "/admin" : "/dashboard");
});
app.get("/signup", (req, res) => res.render("auth/signup", { error: oauthErrorMessage(req.query.error) }));
app.post("/signup", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const password2 = String(req.body.password2 || "");
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password !== password2) {
    return res.status(400).render("auth/signup", { error: "Isi data dengan benar. Password minimal 8 karakter dan harus sama dengan konfirmasi." });
  }
  if (findUserByEmail(email)) return res.status(409).render("auth/signup", { error: "Email sudah terdaftar." });
  const user = { id: id("usr"), name, email, role: "user", passwordHash: await hash(password), createdAt: new Date().toISOString() };
  const users = read("users.json"); users.push(user); write("users.json", users);
  logActivity({ userId: user.id, type: "signup", message: "Akun baru dibuat" });
  req.session.userId = user.id; req.session.role = user.role;
  res.redirect("/dashboard");
});
app.get("/auth/github", (req, res) => {
  const clientId = String(process.env.GITHUB_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GITHUB_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return res.redirect("/login?error=github_not_configured");

  const state = crypto.randomBytes(24).toString("hex");
  req.session.githubOauthState = state;
  req.session.githubOauthIntent = req.query.mode === "signup" ? "signup" : "login";
  const redirectUri = `${requestOrigin(req)}/auth/github/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:user user:email",
    state
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get("/auth/github/callback", async (req, res) => {
  const intent = req.session.githubOauthIntent === "signup" ? "signup" : "login";
  const errorBase = intent === "signup" ? "/signup" : "/login";
  const expectedState = req.session.githubOauthState;
  delete req.session.githubOauthState;
  delete req.session.githubOauthIntent;

  if (req.query.error) return res.redirect(`${errorBase}?error=github_denied`);
  const receivedState = String(req.query.state || "");
  const expectedStateBuffer = Buffer.from(String(expectedState || ""));
  const receivedStateBuffer = Buffer.from(receivedState);
  const stateIsValid = expectedStateBuffer.length > 0 && expectedStateBuffer.length === receivedStateBuffer.length && crypto.timingSafeEqual(expectedStateBuffer, receivedStateBuffer);
  if (!stateIsValid) return res.redirect(`${errorBase}?error=github_invalid_state`);

  const code = String(req.query.code || "").trim();
  const clientId = String(process.env.GITHUB_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GITHUB_CLIENT_SECRET || "").trim();
  if (!code || !clientId || !clientSecret) return res.redirect(`${errorBase}?error=github_not_configured`);

  try {
    const redirectUri = `${requestOrigin(req)}/auth/github/callback`;
    const tokenResponse = await axios.post("https://github.com/login/oauth/access_token", {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    }, {
      headers: { Accept: "application/json" },
      timeout: 12000
    });

    const accessToken = tokenResponse.data?.access_token;
    if (!accessToken) return res.redirect(`${errorBase}?error=github_token_failed`);

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "AM-Generator"
    };
    const [profileResponse, emailResponse] = await Promise.all([
      axios.get("https://api.github.com/user", { headers, timeout: 12000 }),
      axios.get("https://api.github.com/user/emails", { headers, timeout: 12000 })
    ]);

    const gh = profileResponse.data || {};
    const emails = Array.isArray(emailResponse.data) ? emailResponse.data : [];
    const selectedEmail = emails.find(e => e.primary && e.verified) || emails.find(e => e.verified);
    const email = String(selectedEmail?.email || "").trim().toLowerCase();
    if (!email) return res.redirect(`${errorBase}?error=github_email_missing`);

    const users = read("users.json");
    let user = users.find(u => String(u.githubId || "") === String(gh.id || ""));
    if (!user) user = users.find(u => String(u.email || "").toLowerCase() === email);

    if (!user) {
      user = {
        id: id("usr"),
        name: String(gh.name || gh.login || email.split("@")[0]).slice(0, 80),
        email,
        role: "user",
        passwordHash: null,
        githubId: String(gh.id || ""),
        githubUsername: String(gh.login || ""),
        avatarUrl: String(gh.avatar_url || ""),
        authProviders: ["github"],
        createdAt: new Date().toISOString()
      };
      users.push(user);
      write("users.json", users);
      logActivity({ userId: user.id, type: "signup_github", message: "Akun dibuat melalui GitHub" });
    } else {
      user.githubId = String(gh.id || user.githubId || "");
      user.githubUsername = String(gh.login || user.githubUsername || "");
      user.avatarUrl = String(gh.avatar_url || user.avatarUrl || "");
      user.authProviders = Array.from(new Set([...(Array.isArray(user.authProviders) ? user.authProviders : []), "github"]));
      write("users.json", users);
      logActivity({ userId: user.id, type: "login_github", message: "Login melalui GitHub" });
    }

    req.session.userId = user.id;
    req.session.role = user.role;
    res.redirect(user.role === "admin" ? "/admin" : "/dashboard");
  } catch (error) {
    console.error("GitHub OAuth:", error.response?.data || error.message);
    res.redirect(`${errorBase}?error=github_failed`);
  }
});

app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

function dashboardData(userId) {
  const keys = read("api-keys.json").filter(k => k.userId === userId);
  const allLogs = read("requests.json").filter(x => x.userId === userId);
  const logs = allLogs.slice(-12).reverse();
  const tasks = read("tasks.json").filter(t => t.userId === userId);
  const bots = read("bots.json").filter(b => b.userId === userId);
  return { keys, logs, requestCount: allLogs.length, tasks, bots };
}

app.get("/dashboard", requireLogin, (req, res) => res.render("user/dashboard", dashboardData(req.session.userId)));
app.get("/userbot", requireLogin, (req, res) => res.render("user/userbot", { ...dashboardData(req.session.userId), bots: botManager.list(req.session.userId) }));
app.get("/userbot/api", requireLogin, (req, res) => res.json({ success: true, bots: botManager.list(req.session.userId) }));
app.post("/userbot/api", requireLogin, async (req, res) => {
  try {
    const platform = String(req.body.platform || "").toLowerCase();
    const name = String(req.body.name || "").trim().slice(0, 60);
    let bot;
    if (platform === "whatsapp") bot = await botManager.createWhatsApp(req.session.userId, name, req.body.phone);
    else if (platform === "telegram") bot = await botManager.createTelegram(req.session.userId, name, String(req.body.token || "").trim());
    else return res.status(400).json({ success: false, message: "Pilih Telegram atau WhatsApp." });
    logActivity({ userId: req.session.userId, type: "bot_created", message: `Membuat bot ${platform}` });
    res.status(201).json({ success: true, bot });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || "Bot gagal dibuat." });
  }
});
app.post("/userbot/api/:id/reconnect", requireLogin, async (req, res) => {
  try { res.json({ success: true, bot: await botManager.reconnect(req.params.id, req.session.userId) }); }
  catch (error) { res.status(400).json({ success: false, message: error.message }); }
});
app.post("/userbot/api/:id/pairing-code", requireLogin, async (req, res) => {
  try {
    const bot = await botManager.renewPairingCode(req.params.id, req.session.userId, req.body.phone);
    res.json({ success: true, bot });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message || "Pairing code baru gagal dibuat." });
  }
});
app.delete("/userbot/api/:id", requireLogin, async (req, res) => {
  const removed = await botManager.remove(req.params.id, req.session.userId);
  if (removed) logActivity({ userId: req.session.userId, type: "bot_deleted", message: "Menghapus bot dan session" });
  res.status(removed ? 200 : 404).json({ success: removed, message: removed ? "Bot dan sesi berhasil dihapus." : "Bot tidak ditemukan." });
});
app.get("/task", requireLogin, (req, res) => res.render("user/task", dashboardData(req.session.userId)));

// Task workflow: request Magic Link -> wait for user input -> verify account -> confirm Premium status.
// IMPORTANT: Magic Link verification alone is NOT a Premium confirmation.
// Only an explicit, trusted Premium flag returned by the account/entitlement source
// may move a task to `completed`. Missing Premium evidence remains `premium_unverified`.
// Ganti fungsi ini biar lebih akurat
function getPremiumState(user) {
  const u = user && typeof user === "object" ? user : {};

  // Cek langsung dari field user
  if (u.premium === true || u.isPremium === true || u.premiumActive === true) {
    return { active: true, verified: true, source: 'user.direct' };
  }

  // Cek dari subscription
  if (u.subscription && u.subscription.active === true) {
    return { active: true, verified: true, source: 'user.subscription' };
  }

  // Cek dari customData (hasil applyPremium)
  if (u.customData && u.customData.premium === true) {
    return { active: true, verified: true, source: 'user.customData' };
  }

  return { active: false, verified: false, source: null };
}

function normalizeTaskForClient(task) {
  const out = { ...task };

  // Protect the UI from legacy tasks that were incorrectly marked completed
  // merely because Magic Link verification succeeded.
  if (out.status === "completed" && out.result?.premiumActive !== true) {
    out.status = "premium_unverified";
    out.step = "premium_check";
    out.message = "Akun berhasil diverifikasi, tetapi status Premium belum dapat dikonfirmasi.";
  }

  return out;
}

app.get("/task/api", requireLogin, (req, res) => {
  const tasks = read("tasks.json")
    .filter(t => t.userId === req.session.userId)
    .slice(-100)
    .reverse()
    .map(normalizeTaskForClient);
  res.json({ success: true, tasks });
});

app.post("/task/api", requireLogin, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: "Email tidak valid." });
  }
  const tasks = read("tasks.json");
  const task = { id: id("task"), userId: req.session.userId, email, status: "processing", step: "request", message: "Mengirim Magic Link...", result: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  tasks.push(task); write("tasks.json", tasks.slice(-10000));

  try {
    const result = await alightAuth.sendMagicLink(email);
    const rows = read("tasks.json");
    const current = rows.find(t => t.id === task.id && t.userId === req.session.userId);
    if (!current) return res.status(500).json({ success: false, message: "Task tidak ditemukan setelah dibuat." });
    current.updatedAt = new Date().toISOString();
    if (!result.success) {
      current.status = "failed"; current.step = "request"; current.message = String(result.error || "Gagal mengirim Magic Link.");
      write("tasks.json", rows);
      return res.status(502).json({ success: false, message: "Magic Link gagal dikirim.", task: current });
    }
    current.status = "waiting"; current.step = "link"; current.message = "Magic Link berhasil dikirim. Menunggu link dari email.";
    write("tasks.json", rows);
    res.json({ success: true, task: current });
  } catch (e) {
    const rows = read("tasks.json"), current = rows.find(t => t.id === task.id);
    if (current) { current.status = "failed"; current.message = e.message; current.updatedAt = new Date().toISOString(); write("tasks.json", rows); }
    res.status(502).json({ success: false, message: "Terjadi kesalahan saat mengirim Magic Link." });
  }
});

app.post("/task/api/:id/link", requireLogin, async (req, res) => {
  const magicLink = String(req.body?.magic_link || req.body?.link || "").trim();
  if (!magicLink) return res.status(400).json({ success: false, message: "Magic Link wajib diisi." });

  const tasks = read("tasks.json");
  const task = tasks.find(t => t.id === req.params.id && t.userId === req.session.userId);
  if (!task) return res.status(404).json({ success: false, message: "Task tidak ditemukan." });
  if (task.status !== "waiting") return res.status(409).json({ success: false, message: `Task tidak bisa diproses karena statusnya ${task.status}.` });

  task.status = "processing";
  task.step = "verify";
  task.message = "Memproses Magic Link...";
  task.updatedAt = new Date().toISOString();
  write("tasks.json", tasks);

  try {
    const result = await alightAuth.verifyAndFetchProfile(task.email, magicLink);
    const rows = read("tasks.json");
    const current = rows.find(t => t.id === task.id && t.userId === req.session.userId);
    current.updatedAt = new Date().toISOString();

    if (!result.success) {
      current.status = "failed";
      current.step = "verify";
      current.message = String(result.error || "Magic Link tidak valid.");
      write("tasks.json", rows);
      return res.status(400).json({ success: false, message: "Magic Link tidak valid atau sudah kedaluwarsa." });
    }

    const u = result.user || {};
    const idToken = result.idToken;
    let premiumActive = false;
    let premiumData = null;

    // 🔥 CEK PREMIUM DARI FIREBASE CUSTOM CLAIMS DULU
    try {
      const accountInfo = await axios.post(
        `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${alightAuth.API_KEY}`,
        { idToken },
        { headers: alightAuth.HEADERS }
      );
      const userData = accountInfo.data.users[0];
      if (userData?.customAttributes) {
        try {
          const custom = JSON.parse(userData.customAttributes);
          if (custom?.premium === true || custom?.isPremium === true) {
            premiumActive = true;
            console.log("[✓] User already premium from Firebase custom claims!");
          }
        } catch (_) {}
      }
    } catch (_) {}

    // 🔥 KALO BELUM, COBA APPLY PREMIUM
    if (!premiumActive) {
      try {
        const premiumResult = await alightAuth.applyPremium(idToken);
        if (premiumResult.success) {
          premiumActive = true;
          premiumData = premiumResult.data;
          console.log("[✓] Premium applied successfully:", premiumResult.codeorder);
        } else {
          console.log("[!] Premium apply failed:", premiumResult.error);
        }
      } catch (premErr) {
        console.log("[!] Premium check error:", premErr.message);
      }
    }

    // 🔥 STORE DATA
    current.result = {
      localId: u.localId || null,
      email: u.email || task.email,
      emailVerified: !!u.emailVerified,
      premiumActive: premiumActive,
      premiumVerified: premiumActive,
      premiumSource: premiumActive ? (premiumData ? "applyPremium" : "customClaims") : "none",
      premiumData: premiumData || null
    };

    // 🔥 SET STATUS
    if (premiumActive) {
      current.status = "completed";
      current.step = "completed";
      current.message = "✅ Premium aktif!";
    } else if (u.emailVerified) {
      current.status = "premium_unverified";
      current.step = "premium_check";
      current.message = "⚠️ Email terverifikasi, tapi Premium belum aktif. Coba email lain atau token baru.";
    } else {
      current.status = "failed";
      current.step = "verify";
      current.message = "❌ Email tidak terverifikasi.";
    }

    write("tasks.json", rows);
    res.json({ success: true, task: current });

  } catch (e) {
    const rows = read("tasks.json");
    const current = rows.find(t => t.id === task.id);
    if (current) {
      current.status = "failed";
      current.message = "Terjadi kesalahan: " + e.message;
      current.updatedAt = new Date().toISOString();
      write("tasks.json", rows);
    }
    res.status(502).json({ success: false, message: "Terjadi kesalahan saat memproses Magic Link." });
  }
});
app.get("/logs", requireLogin, (req, res) => res.render("user/logs", dashboardData(req.session.userId)));

app.post("/api-keys", requireLogin, (req, res) => {
  const keys = read("api-keys.json");
  const owner = findUser(req.session.userId);
  const adminUnlimited = String(owner?.role || "").toLowerCase() === "admin";
  const key = {
    id: id("key"),
    userId: req.session.userId,
    name: String(req.body.name || "My App").slice(0, 60),
    key: publicKey(),
    plan: adminUnlimited ? "admin" : "free",
    unlimited: adminUnlimited,
    limit: adminUnlimited ? null : 50,
    quotaLimit: adminUnlimited ? null : 50,
    quotaUsed: 0,
    quotaResetAt: adminUnlimited ? null : new Date(Date.now() + 86400000).toISOString(),
    active: true,
    createdAt: new Date().toISOString()
  };
  keys.push(key);
  write("api-keys.json", keys);
  logActivity({ userId: req.session.userId, type: "api_key_created", message: `API key ${key.name} dibuat` });
  res.redirect(safeReturnTo(req.body.returnTo, "/profile#api"));
});
app.post("/api-keys/:id/revoke", requireLogin, (req, res) => {
  const keys = read("api-keys.json");
  const k = keys.find(x => x.id === req.params.id && x.userId === req.session.userId);
  if (k) {
    k.active = false;
    write("api-keys.json", keys);
    logActivity({ userId: req.session.userId, type: "api_key_revoked", message: `API key ${k.name} dinonaktifkan` });
  }
  res.redirect(safeReturnTo(req.body.returnTo, "/profile#api"));
});
function profileData(userId) {
  const user = findUser(userId);
  const keys = read("api-keys.json")
    .filter(k => k.userId === userId)
    .map(k => ({ ...k, unlimited: isUnlimitedApiKey(k) }));
  const activeKey = keys.find(k => k.active) || null;
  const userbotCount = read("bots.json").filter(b => b.userId === userId).length;
  return { user, keys, activeKey, userbotCount, message: null, error: null };
}
app.get("/profile", requireLogin, (req, res) => res.render("user/profile", profileData(req.session.userId)));
app.post("/profile", requireLogin, (req, res) => {
  const users = read("users.json"), u = users.find(x => x.id === req.session.userId);
  const name = String(req.body.name || "").trim();
  const bio = String(req.body.bio || "").trim().slice(0, 180);
  if (!u || name.length < 2) return res.status(400).render("user/profile", { ...profileData(req.session.userId), error: "Nama minimal 2 karakter." });
  u.name = name; u.bio = bio; write("users.json", users);
  logActivity({ userId: req.session.userId, type: "profile_updated", message: "Profil akun diperbarui" });
  res.render("user/profile", { ...profileData(req.session.userId), message: "Profil berhasil diperbarui." });
});
app.post("/profile/password", requireLogin, async (req, res) => {
  const password = String(req.body.password || "");
  const password2 = String(req.body.password2 || "");
  if (password.length < 8 || password !== password2) {
    return res.status(400).render("user/profile", { ...profileData(req.session.userId), error: "Password minimal 8 karakter dan konfirmasi harus sama." });
  }
  const users = read("users.json"), u = users.find(x => x.id === req.session.userId);
  if (!u) return res.status(404).render("user/profile", { ...profileData(req.session.userId), error: "Akun tidak ditemukan." });
  u.passwordHash = await hash(password); write("users.json", users);
  req.session.destroy(() => res.redirect("/login"));
});
app.post("/profile/api-key/regenerate", requireLogin, (req, res) => {
  const keys = read("api-keys.json");
  keys.forEach(k => { if (k.userId === req.session.userId && k.active) k.active = false; });
  const owner = findUser(req.session.userId);
  const adminUnlimited = String(owner?.role || "").toLowerCase() === "admin";
  const key = {
    id: id("key"), userId: req.session.userId, name: "Profile API", key: publicKey(),
    plan: adminUnlimited ? "admin" : "free", unlimited: adminUnlimited,
    limit: adminUnlimited ? null : 50, quotaLimit: adminUnlimited ? null : 50, quotaUsed: 0,
    quotaResetAt: adminUnlimited ? null : new Date(Date.now() + 86400000).toISOString(),
    active: true, createdAt: new Date().toISOString()
  };
  keys.push(key); write("api-keys.json", keys);
  logActivity({ userId: req.session.userId, type: "api_key_regenerated", message: "API key profile dibuat ulang" });
  res.redirect("/profile#api");
});

app.get("/support", requireLogin, (req, res) => res.render("user/support"));
app.post("/support/api/chat", requireLogin, async (req, res) => {
  try {
    const result = await chat({ history: req.body.history, message: req.body.message, attachment: req.body.attachment });
    const project = extractProject(result.text);
    let artifact = null;
    if (project) artifact = await createZip(project, req.session.userId);
    res.json({ success: true, message: result.text.replace(/<PROJECT_JSON>[\s\S]*?<\/PROJECT_JSON>/i, '').trim(), artifact: artifact ? { id: artifact.id, name: artifact.name, files: artifact.files.map(f => f.path), download: `/support/artifacts/${artifact.id}/download` } : null });
  } catch (e) {
    console.error('Support AI:', e.message);
    res.status(502).json({ success: false, message: e.message || 'AI Support sedang tidak tersedia.' });
  }
});
app.get("/support/artifacts/:id/download", requireLogin, (req, res) => {
  const artifacts = read("artifacts.json");
  const artifact = artifacts.find(a => a.id === req.params.id && a.userId === req.session.userId);
  if (!artifact || !require('fs').existsSync(artifact.zipPath)) return res.status(404).send('Artifact tidak ditemukan.');
  res.download(artifact.zipPath, `${artifact.name}.zip`);
});

app.get("/docs", (req, res) => res.render("user/docs", { baseUrl: requestOrigin(req) }));

app.get("/admin", requireAdmin, (req, res) => {
  const users = read("users.json"), keys = read("api-keys.json"), logs = read("requests.json"), settings = read("settings.json");
  const activity = read("activity.json").slice(-8).reverse();
  res.render("admin/index", { users, keys, logs, settings, activity, dataStatus: dataStatus() });
});
app.post("/admin/maintenance", requireAdmin, (req, res) => {
  const s = read("settings.json"); s.maintenance = !s.maintenance; write("settings.json", s); res.redirect("/admin");
});

app.use((req, res) => res.status(404).render("404"));
app.listen(PORT, () => {
  console.log(`AM Generator running at http://localhost:${PORT}`);
  botManager.restore().catch(error => console.error("Bot restore:", error.message));
  startOwnerBackup();
});
