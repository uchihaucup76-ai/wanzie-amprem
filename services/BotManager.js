const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const NodeCache = require("node-cache");
const pino = require("pino");
const { read, write, id } = require("../lib");

const DATA_ROOT = path.resolve(process.env.DATA_DIR || path.join(__dirname, "..", "data"));
const SESSION_ROOT = path.join(DATA_ROOT, "bot-sessions");
const KEY_FILE = path.join(DATA_ROOT, ".bot-master-key");
fs.mkdirSync(SESSION_ROOT, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function masterKey() {
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  return fs.readFileSync(KEY_FILE);
}
function encrypt(value) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(x => x.toString("base64url")).join(".");
}
function decrypt(value) {
  const [iv, tag, body] = value.split(".").map(x => Buffer.from(x, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

class BotManager {
  constructor() {
    this.instances = new Map();
    this.restartTimers = new Map();
    this.baileys = null;
    this.waVersion = null;
  }

  publicBot(bot) {
    const safe = { ...bot };
    delete safe.sessionPath;
    delete safe.pairingPhone;
    return safe;
  }

  list(userId) {
    return read("bots.json").filter(b => b.userId === userId).map(b => this.publicBot(b));
  }

  findOwned(botId, userId) {
    return read("bots.json").find(b => b.id === botId && b.userId === userId);
  }

  update(botId, patch) {
    const bots = read("bots.json"), bot = bots.find(b => b.id === botId);
    if (!bot) return null;
    Object.assign(bot, patch, { updatedAt: new Date().toISOString() });
    write("bots.json", bots);
    return bot;
  }

  async loadBaileys() {
    if (!this.baileys) this.baileys = await import("@whiskeysockets/baileys");
    return this.baileys;
  }

  async latestWaVersion(B) {
    if (this.waVersion) return this.waVersion;
    try {
      const result = await B.fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10000) });
      if (Array.isArray(result?.version)) this.waVersion = result.version;
    } catch (error) {
      console.warn("[WhatsApp] Gagal mengambil versi Web terbaru, memakai versi bawaan:", error.message);
    }
    return this.waVersion;
  }

  clearRestart(botId) {
    const timer = this.restartTimers.get(botId);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(botId);
  }

  scheduleWhatsAppRestart(botId, delay = 1000) {
    this.clearRestart(botId);
    const timer = setTimeout(async () => {
      this.restartTimers.delete(botId);
      if (this.instances.has(botId)) return;
      const bot = read("bots.json").find(item => item.id === botId);
      if (!bot || bot.platform !== "whatsapp" || bot.status === "logged_out") return;
      try {
        console.log(`[WhatsApp:${botId}] restarting socket with saved auth state`);
        await this.startWhatsApp(botId);
      } catch (error) {
        console.error(`[WhatsApp:${botId}] restart gagal:`, error.message);
        this.update(botId, { status: "error", error: `Gagal menyelesaikan koneksi WhatsApp: ${error.message}` });
      }
    }, delay);
    this.restartTimers.set(botId, timer);
  }


  maskEmail(email) {
    const value = String(email || "").trim();
    const [local, domain] = value.split("@");
    if (!local || !domain) return "Tidak tersedia";
    const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
    return `${visible}${"*".repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`;
  }

  formatDate(value) {
    if (!value) return "-";
    try {
      return new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit",
        month: "short",
        year: "numeric"
      }).format(new Date(value));
    } catch (_) {
      return "-";
    }
  }

  formatDateTime(value = new Date()) {
    try {
      return new Intl.DateTimeFormat("id-ID", {
        timeZone: "Asia/Jakarta",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(value)).replace(".", ":");
    } catch (_) {
      return "-";
    }
  }

  greeting() {
    const hour = Number(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      hour12: false
    }).format(new Date()));
    if (hour >= 4 && hour < 11) return "Selamat pagi";
    if (hour >= 11 && hour < 15) return "Selamat siang";
    if (hour >= 15 && hour < 18) return "Selamat sore";
    return "Selamat malam";
  }

  senderLabel(message) {
    return String(message?.pushName || "Pengguna WhatsApp").trim().slice(0, 60) || "Pengguna WhatsApp";
  }

  senderIdentity(message) {
    const raw = String(
      message?.key?.participant ||
      message?.key?.participantAlt ||
      message?.key?.remoteJidAlt ||
      message?.key?.remoteJid ||
      ""
    );
    const local = raw.split("@")[0].replace(/\D/g, "");
    if (raw.endsWith("@s.whatsapp.net") && local) return `+${local}`;
    if (raw.endsWith("@lid")) return "WhatsApp Linked ID";
    return local ? `ID ${local.slice(0, 4)}••••${local.slice(-3)}` : "WhatsApp";
  }

  accountSnapshot(bot) {
    const owner = read("users.json").find(user => user.id === bot.userId) || {};
    const keys = read("api-keys.json").filter(key => key.userId === bot.userId);
    const activeKey = keys.find(key => key.active) || null;
    const bots = read("bots.json").filter(item => item.userId === bot.userId);
    const tasks = read("tasks.json").filter(task => task.userId === bot.userId);
    const requests = read("requests.json").filter(item => item.userId === bot.userId);
    const unlimited = Boolean(activeKey) && (activeKey.unlimited === true || String(activeKey.plan || "").toLowerCase() === "admin" || String(owner.role || "").toLowerCase() === "admin");
    const quotaLimit = unlimited ? null : Number(activeKey?.quotaLimit ?? activeKey?.limit ?? 0);
    const quotaUsed = unlimited ? null : Number(activeKey?.quotaUsed || 0);
    const completedTasks = tasks.filter(task => ["completed", "success", "done"].includes(String(task.status || "").toLowerCase())).length;

    return {
      owner,
      activeKey,
      unlimited,
      plan: unlimited ? "ADMIN" : String(activeKey?.plan || owner.plan || "free").toUpperCase(),
      quotaLimit,
      quotaUsed,
      quotaRemaining: unlimited ? null : Math.max(0, quotaLimit - quotaUsed),
      botCount: bots.length,
      taskCount: tasks.length,
      completedTasks,
      requestCount: requests.length
    };
  }

  incomingContent(B, message) {
    if (!message?.message) return {};
    try {
      return B.normalizeMessageContent?.(message.message) || message.message;
    } catch (_) {
      return message.message;
    }
  }

  incomingText(B, message) {
    const content = this.incomingContent(B, message);
    return String(
      content?.conversation ||
      content?.extendedTextMessage?.text ||
      content?.imageMessage?.caption ||
      content?.videoMessage?.caption ||
      ""
    ).trim();
  }

  selectedMenuId(B, message) {
    const content = this.incomingContent(B, message);

    const listId = content?.listResponseMessage?.singleSelectReply?.selectedRowId;
    if (listId) return String(listId);

    const buttonId = content?.buttonsResponseMessage?.selectedButtonId;
    if (buttonId) return String(buttonId);

    const interactive = content?.interactiveResponseMessage;
    const paramsJson = interactive?.nativeFlowResponseMessage?.paramsJson;
    if (paramsJson) {
      try {
        const params = JSON.parse(paramsJson);
        return String(params.id || params.row_id || params.selected_id || "");
      } catch (_) {}
    }
    return "";
  }

  buildMenuBody(bot, message) {
    const info = this.accountSnapshot(bot);
    const sender = this.senderLabel(message);
    const chatType = String(message?.key?.remoteJid || "").endsWith("@g.us") ? "Grup" : "Pribadi";
    const apiStatus = info.activeKey ? "Aktif" : "Belum aktif";
    const memberSince = this.formatDate(info.owner.createdAt);

    return [
      `👋 *${this.greeting()}, ${sender}!*`,
      "",
      "Selamat datang di *AM Generator Userbot*.",
      "",
      "╭─〔 👤 INFORMASI PENGGUNA 〕",
      `│ Nama WA : ${sender}`,
      `│ Identitas : ${this.senderIdentity(message)}`,
      `│ Chat : ${chatType}`,
      "╰────────────────",
      "",
      "╭─〔 🌐 AKUN WEBSITE 〕",
      `│ Nama : ${info.owner.name || "User"}`,
      `│ Email : ${this.maskEmail(info.owner.email)}`,
      `│ Role : ${String(info.owner.role || "user").toUpperCase()}`,
      `│ Plan : ${info.plan}`,
      `│ Member : ${memberSince}`,
      "╰────────────────",
      "",
      "╭─〔 ⚡ RINGKASAN LAYANAN 〕",
      `│ API : ${apiStatus}`,
      `│ Quota : ${info.unlimited ? "UNLIMITED" : `${info.quotaUsed}/${info.quotaLimit || 0} per hari`}`,
      `│ Userbot : ${info.botCount}`,
      `│ Task : ${info.taskCount}`,
      `│ Request API : ${info.requestCount}`,
      "╰────────────────",
      "",
      `🤖 *${bot.name}* • ${String(bot.status || "online").toUpperCase()}`,
      "Pilih informasi yang ingin dibuka melalui tombol di bawah."
    ].join("\n");
  }

  buildMixedNativeFlowBizNode() {
    const privacyModeTs = (Math.floor(Date.now() / 1000) - 77980457).toString();
    return {
      tag: "biz",
      attrs: {
        actual_actors: "2",
        host_storage: "2",
        privacy_mode_ts: privacyModeTs
      },
      content: [
        {
          tag: "interactive",
          attrs: { type: "native_flow", v: "1" },
          content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }]
        },
        {
          tag: "quality_control",
          attrs: { source_type: "third_party" }
        }
      ]
    };
  }

  async sendWhatsAppMenu(B, sock, bot, message) {
    const jid = message.key.remoteJid;
    if (!jid) return;

    const singleSelect = {
      name: "single_select",
      buttonParamsJson: JSON.stringify({
        title: "📋 Buka Menu",
        sections: [
          {
            title: "AM Generator",
            highlight_label: "MENU",
            rows: [
              {
                header: "ACCOUNT",
                title: "👤 Informasi Akun",
                description: "Profil akun website AM Generator",
                id: "amg_menu_account"
              },
              {
                header: "BOT",
                title: "🤖 Informasi Bot",
                description: "Status dan statistik Userbot WhatsApp",
                id: "amg_menu_bot"
              },
              {
                header: "API",
                title: "🔑 API & Quota",
                description: "Status API, plan, dan pemakaian quota",
                id: "amg_menu_api"
              },
              {
                header: "ACTIVITY",
                title: "📊 Aktivitas",
                description: "Task dan request API akun",
                id: "amg_menu_activity"
              },
              {
                header: "HELP",
                title: "📚 Bantuan",
                description: "Cara menggunakan menu bot",
                id: "amg_menu_help"
              }
            ]
          }
        ]
      })
    };

    const interactiveMessage = B.proto.Message.InteractiveMessage.create({
      header: B.proto.Message.InteractiveMessage.Header.create({
        title: "AM GENERATOR",
        subtitle: "WhatsApp Userbot",
        hasMediaAttachment: false
      }),
      body: B.proto.Message.InteractiveMessage.Body.create({
        text: this.buildMenuBody(bot, message)
      }),
      footer: B.proto.Message.InteractiveMessage.Footer.create({
        text: `AM Generator • ${this.formatDateTime()} WIB`
      }),
      nativeFlowMessage: B.proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: [
          B.proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create(singleSelect)
        ],
        messageParamsJson: "{}",
        messageVersion: 1
      })
    });

    const ownJid = sock.user?.id || undefined;
    const waMessage = B.generateWAMessageFromContent(
      jid,
      { interactiveMessage },
      { userJid: ownJid, quoted: message }
    );

    const bizNode = this.buildMixedNativeFlowBizNode();
    const additionalNodes = String(jid).endsWith("@g.us")
      ? [bizNode]
      : [{ tag: "bot", attrs: { biz_bot: "1" } }, bizNode];

    await sock.relayMessage(jid, waMessage.message, {
      messageId: waMessage.key.id,
      additionalNodes
    });

    console.log(`[WhatsApp:${bot.id}] .menu single_select dikirim ke ${jid}`);
  }


  getActiveApiKey(userId) {
    return read("api-keys.json").find(key => key.userId === userId && key.active) || null;
  }

  whatsappActor(message) {
    return String(
      message?.key?.participant ||
      message?.key?.participantAlt ||
      message?.key?.remoteJidAlt ||
      message?.key?.remoteJid ||
      ""
    );
  }

  safeLinkPreview(rawLink) {
    try {
      const url = new URL(String(rawLink || "").trim());
      if (!/^https?:$/.test(url.protocol)) return null;
      return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 500);
    } catch (_) {
      return null;
    }
  }

  docsApiUrl(endpoint) {
    const port = String(process.env.PORT || "3000").trim() || "3000";
    const route = String(endpoint || "").replace(/^\/+/, "");
    return `http://127.0.0.1:${port}/api/v1/${route}`;
  }

  async callDocsApi(endpoint, apiKey, body) {
    const response = await fetch(this.docsApiUrl(endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(30000)
    });

    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; }
    catch (_) { payload = { success: false, error: { code: "INVALID_RESPONSE", message: "Respons API tidak valid." } }; }

    return {
      ok: response.ok && payload?.success !== false,
      status: response.status,
      payload
    };
  }

  async createAMTaskFromWhatsApp(bot, message, requestedEmail) {
    const apiKey = this.getActiveApiKey(bot.userId);
    if (!apiKey) {
      return {
        success: false,
        message: [
          "❌ *Request AM belum dapat dimulai*",
          "",
          "Akun website pemilik bot belum memiliki API Key aktif.",
          "Buat/aktifkan API Key dari website terlebih dahulu, lalu kirim ulang command *.am*."
        ].join("\n")
      };
    }

    const email = String(requestedEmail || "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, message: "❌ Format email tidak valid.\n\nContoh: *.am email@example.com*" };
    }

    let docsRequest;
    try {
      docsRequest = await this.callDocsApi("request", apiKey, { email });
    } catch (error) {
      return {
        success: false,
        message: [
          "❌ *Request AM gagal dikirim ke API website*",
          "",
          "Endpoint: */api/v1/request*",
          `Error: ${String(error?.message || "API tidak dapat dihubungi").slice(0, 180)}`
        ].join("\n")
      };
    }

    if (!docsRequest.ok) {
      const apiError = docsRequest.payload?.error || {};
      if (docsRequest.status === 429 || apiError.code === "QUOTA_EXCEEDED") {
        const quota = apiError.quota || {};
        return {
          success: false,
          message: [
            "⚠️ *Quota API habis*",
            "",
            Number.isFinite(Number(quota.used)) && Number.isFinite(Number(quota.limit)) ? `Terpakai: ${quota.used}/${quota.limit}` : "Quota tidak tersedia.",
            quota.reset_at ? `Reset: ${this.formatDateTime(quota.reset_at)} WIB` : "",
            "",
            "Request *.am* tidak dikirim."
          ].filter(Boolean).join("\n")
        };
      }

      return {
        success: false,
        message: [
          "❌ *Request AM ditolak API website*",
          "",
          `Endpoint: */api/v1/request*`,
          `Status: ${docsRequest.status}`,
          `Pesan: ${String(apiError.message || "Request gagal.").slice(0, 220)}`
        ].join("\n")
      };
    }

    const now = new Date().toISOString();
    const tasks = read("tasks.json");
    const task = {
      id: id("task"),
      userId: bot.userId,
      botId: bot.id,
      source: "whatsapp_userbot",
      requestedBy: message.pushName || "WhatsApp User",
      whatsappChatId: String(message?.key?.remoteJid || ""),
      whatsappActorId: this.whatsappActor(message),
      email,
      apiKeyId: apiKey.id,
      apiKeyUsed: true,
      apiPlan: apiKey.plan || "free",
      requestEndpoint: "/api/v1/request",
      status: "waiting",
      step: "link",
      message: "Request email berhasil dikirim melalui /api/v1/request. Menunggu .verif link.",
      result: null,
      verification: {
        required: true,
        mode: "linkmagic",
        verified: false,
        verifiedAt: null,
        linkPreview: null
      },
      createdAt: now,
      updatedAt: now
    };

    tasks.push(task);
    write("tasks.json", tasks.slice(-10000));

    const info = this.accountSnapshot(bot);
    const quotaText = info.unlimited
      ? "UNLIMITED"
      : `${info.quotaUsed}/${info.quotaLimit || 0} • sisa ${info.quotaRemaining}`;

    return {
      success: true,
      task,
      message: [
        "✅ *Request AM berhasil dikirim*",
        "",
        `📧 Email target: ${email}`,
        `🆔 Task ID: ${task.id}`,
        "🌐 Endpoint: */api/v1/request*",
        `🔑 API: Aktif (${String(info.plan || apiKey.plan || "free").toUpperCase()})`,
        `📊 Quota: ${quotaText}`,
        "",
        "⏳ Status: *WAITING VERIFICATION*",
        "",
        "Link sudah diminta lewat API website.",
        "Lanjutkan dengan:",
        "*.verif https://link-verifikasi...*"
      ].join("\n")
    };
  }

  findWaitingWhatsAppTask(bot, message) {
    const chatId = String(message?.key?.remoteJid || "");
    const actorId = this.whatsappActor(message);
    return read("tasks.json")
      .filter(task =>
        task.userId === bot.userId &&
        task.botId === bot.id &&
        task.source === "whatsapp_userbot" &&
        task.status === "waiting" &&
        task.step === "link" &&
        String(task.whatsappChatId || "") === chatId &&
        String(task.whatsappActorId || "") === actorId
      )
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0] || null;
  }

  async verifyAMTaskFromWhatsApp(bot, message, rawLink) {
  const preview = this.safeLinkPreview(rawLink);
  if (!preview) {
    return {
      success: false,
      message: "❌ Link tidak valid.\n\nContoh: *.verif https://example.com/verify/abc*"
    };
  }

  const waiting = this.findWaitingWhatsAppTask(bot, message);
  if (!waiting) {
    return {
      success: false,
      message: [
        "❌ *Tidak ada task yang menunggu verifikasi*",
        "",
        "Buat task terlebih dahulu:",
        "*.am email@example.com*"
      ].join("\n")
    };
  }

  const apiKey = read("api-keys.json").find(key => key.id === waiting.apiKeyId && key.userId === bot.userId && key.active);
  if (!apiKey) {
    return {
      success: false,
      message: "❌ API Key task tidak aktif lagi. Aktifkan API Key lalu ulangi proses *.am*."
    };
  }

  // 🔥 PANGGIL ENDPOINT LINKMAGIC DARI WEBSITE
  let docsRequest;
  try {
    docsRequest = await this.callDocsApi("linkmagic", apiKey, {
      email: waiting.email,
      magic_link: String(rawLink || "").trim()
    });
  } catch (error) {
    return {
      success: false,
      message: [
        "❌ *Verifikasi gagal dikirim ke API website*",
        "",
        "Endpoint: */api/v1/linkmagic*",
        `Error: ${String(error?.message || "API tidak dapat dihubungi").slice(0, 180)}`
      ].join("\n")
    };
  }

  if (!docsRequest.ok) {
    const apiError = docsRequest.payload?.error || {};
    return {
      success: false,
      message: [
        "❌ *Verifikasi ditolak API website*",
        "",
        `Status: ${docsRequest.status}`,
        `Pesan: ${String(apiError.message || "Magic link tidak dapat diproses.").slice(0, 220)}`,
        "",
        "Task tetap menunggu agar link bisa dikirim ulang."
      ].join("\n")
    };
  }

  const tasks = read("tasks.json");
  const task = tasks.find(item => item.id === waiting.id && item.userId === bot.userId);
  if (!task) return { success: false, message: "❌ Task tidak ditemukan." };

  const now = new Date().toISOString();

  // 🔥 CEK APAKAH EMAIL SUDAH VERIFIED DARI RESPONSE API
  // 🔥 BACA PREMIUM ACTIVE DARI RESPONSE API
const userData = docsRequest.payload?.data?.user || {};
const emailVerified = userData.emailVerified === true;
const premiumActive = userData.premiumActive === true;  // 🔥 INI YANG DITAMBAHIN!
const premiumData = userData.premiumData || null;

console.log(`[BotManager] Response: emailVerified=${emailVerified}, premiumActive=${premiumActive}`);

  // 🔥 KALO EMAIL VERIFIED TAPI PREMIUM BELUM, COBA APPLY PREMIUM LEWAT ALIGHT AUTH
  if (emailVerified && !premiumActive) {
    try {
      const AlightMotionAuth = require("./AlightMotionAuth");
      const alightAuth = new AlightMotionAuth();
      
      // Ambil idToken dari response (kalo ada)
      const idToken = docsRequest.payload?.data?.idToken || userData.idToken;
      
      if (idToken) {
        console.log(`[BotManager] Attempting to apply premium for ${task.email}...`);
        const premiumResult = await alightAuth.applyPremium(idToken);
        if (premiumResult.success) {
          premiumActive = true;
          premiumData = premiumResult.data;
          console.log(`[BotManager] ✅ Premium applied for ${task.email}`);
        } else {
          console.log(`[BotManager] ❌ Premium apply failed: ${premiumResult.error}`);
        }
      }
    } catch (err) {
      console.error(`[BotManager] Premium apply error:`, err.message);
    }
  }

  // 🔥 UPDATE TASK
  task.status = "completed";
  task.step = "done";
  task.message = premiumActive 
    ? "✅ Magic link berhasil diproses dan Premium aktif!" 
    : (emailVerified ? "⚠️ Email terverifikasi, tapi Premium belum aktif." : "❌ Email tidak terverifikasi.");
  
  task.result = {
    endpoint: "/api/v1/linkmagic",
    status: docsRequest.payload?.data?.status || "completed",
    user: userData,
    emailVerified: emailVerified,
    premiumActive: premiumActive,
    premiumData: premiumData || null
  };
  task.verification = {
    ...(task.verification || {}),
    required: true,
    mode: "linkmagic",
    verified: emailVerified,
    verifiedAt: now,
    linkPreview: preview
  };
  task.updatedAt = now;
  write("tasks.json", tasks);

  // 🔥 BUILD RESPONSE MESSAGE
  let responseMessage = [
    "✅ *Verifikasi berhasil diproses*",
    "",
    `🆔 Task ID: ${task.id}`,
    `📧 Email: ${task.email}`,
    `📧 Status Email: ${emailVerified ? '✅ Terverifikasi' : '❌ Belum terverifikasi'}`,
    `💎 Premium: ${premiumActive ? '✅ AKTIF' : '❌ Tidak aktif'}`,
    "🌐 Endpoint: */api/v1/linkmagic*",
    `⚙️ Status: ${premiumActive ? 'COMPLETED ✅' : 'PREMIUM_UNVERIFIED ⚠️'}`,
    "",
    premiumActive 
      ? "🎉 Akun sudah Premium! Login ke Alight Motion pake email ini." 
      : "⚠️ Email terverifikasi tapi Premium belum aktif. Coba email lain atau pastikan token applyPremium valid.",
    "",
    "_Task sudah tersinkron ke dashboard website._"
  ].join("\n");

  return {
    success: true,
    task,
    message: responseMessage
  };
}

  async handleWhatsAppTaskCommand(sock, bot, message, text) {
    const input = String(text || "").trim();

    const amMatch = input.match(/^\.am\s+(.+)$/i);
    if (amMatch) {
      const result = await this.createAMTaskFromWhatsApp(bot, message, amMatch[1]);
      await sock.sendMessage(message.key.remoteJid, { text: result.message }, { quoted: message });
      console.log(`[WhatsApp:${bot.id}] .am ${result.success ? "created" : "blocked"}`);
      return true;
    }

    if (/^\.am$/i.test(input)) {
      await sock.sendMessage(
        message.key.remoteJid,
        { text: "📧 Format command:\n*.am email@example.com*" },
        { quoted: message }
      );
      return true;
    }

    const verifyMatch = input.match(/^\.verif\s+(.+)$/i);
    if (verifyMatch) {
      const result = await this.verifyAMTaskFromWhatsApp(bot, message, verifyMatch[1]);
      await sock.sendMessage(message.key.remoteJid, { text: result.message }, { quoted: message });
      console.log(`[WhatsApp:${bot.id}] .verif(linkmagic) ${result.success ? "accepted" : "blocked"}`);
      return true;
    }

    if (/^\.verif$/i.test(input)) {
      await sock.sendMessage(
        message.key.remoteJid,
        { text: "🔗 Format command:\n*.verif https://link-verifikasi...*\n\nSaat ini verifikasi masih mode dummy." },
        { quoted: message }
      );
      return true;
    }

    return false;
  }

  async handleWhatsAppMenuSelection(B, sock, bot, message, selectedId) {
    if (!selectedId || !selectedId.startsWith("amg_menu_")) return false;

    const jid = message.key.remoteJid;
    if (!jid) return true;

    const info = this.accountSnapshot(bot);
    const sender = this.senderLabel(message);
    const apiStatus = info.activeKey ? "AKTIF" : "BELUM AKTIF";
    const quotaReset = info.unlimited ? "Tidak ada" : (info.activeKey?.quotaResetAt ? this.formatDateTime(info.activeKey.quotaResetAt) : "-");
    let reply;

    switch (selectedId) {
      case "amg_menu_account":
        reply = [
          "👤 *INFORMASI AKUN AM GENERATOR*",
          "",
          `Halo, *${sender}* 👋`,
          "",
          `• Nama akun : ${info.owner.name || "User"}`,
          `• Email : ${this.maskEmail(info.owner.email)}`,
          `• Role : ${String(info.owner.role || "user").toUpperCase()}`,
          `• Plan : ${info.plan}`,
          `• Member sejak : ${this.formatDate(info.owner.createdAt)}`,
          `• Masa aktif : ${info.owner.expiresAt ? this.formatDate(info.owner.expiresAt) : "Lifetime"}`,
          `• Kredit : ${typeof info.owner.credits === "number" ? info.owner.credits : "—"}`,
          "",
          "_Email ditampilkan dalam bentuk tersamarkan untuk keamanan._"
        ].join("\n");
        break;

      case "amg_menu_bot":
        reply = [
          "🤖 *INFORMASI USERBOT*",
          "",
          `• Nama bot : ${bot.name}`,
          "• Platform : WhatsApp",
          `• Status : ${String(bot.status || "unknown").toUpperCase()}`,
          `• Nomor : ${bot.phoneMasked || "-"}`,
          `• Pesan diterima : ${Number(bot.messagesReceived || 0)}`,
          `• Dibuat : ${this.formatDate(bot.createdAt)}`,
          `• Terhubung : ${this.formatDateTime(bot.connectedAt)}`,
          `• Update : ${this.formatDateTime(bot.updatedAt)}`,
          "",
          `Total Userbot pada akun: *${info.botCount}*`
        ].join("\n");
        break;

      case "amg_menu_api":
        reply = [
          "🔑 *API & QUOTA*",
          "",
          `• Status API : ${apiStatus}`,
          `• Plan : ${info.plan}`,
          `• Terpakai : ${info.unlimited ? "UNLIMITED" : info.quotaUsed}`,
          `• Limit : ${info.unlimited ? "UNLIMITED" : `${info.quotaLimit || 0}/hari`}`,
          `• Sisa quota : ${info.unlimited ? "UNLIMITED" : info.quotaRemaining}`,
          `• Reset quota : ${info.unlimited ? quotaReset : `${quotaReset} WIB`}`,
          "",
          "_API key tidak pernah ditampilkan melalui WhatsApp._"
        ].join("\n");
        break;

      case "amg_menu_activity":
        reply = [
          "📊 *AKTIVITAS AKUN*",
          "",
          `• Total task : ${info.taskCount}`,
          `• Task selesai : ${info.completedTasks}`,
          `• Request API : ${info.requestCount}`,
          `• Userbot aktif/tersimpan : ${info.botCount}`,
          `• Pesan diterima bot ini : ${Number(bot.messagesReceived || 0)}`,
          "",
          `Update: ${this.formatDateTime()} WIB`
        ].join("\n");
        break;

      case "amg_menu_help":
        reply = [
          "📚 *BANTUAN USERBOT*",
          "",
          "Ketik *.menu* kapan saja untuk membuka menu utama.",
          "",
          "Command Task AM:",
          "• *.am email@example.com* — request melalui /api/v1/request",
          "• *.verif https://...* — proses melalui /api/v1/linkmagic", 
          "",
          "Menu yang tersedia:",
          "• Informasi Akun",
          "• Informasi Bot",
          "• API & Quota",
          "• Aktivitas",
          "• Bantuan",
          "",
          "Pilihan menu akan dibalas langsung oleh bot dengan fitur reply WhatsApp."
        ].join("\n");
        break;

      default:
        return false;
    }

    await sock.sendMessage(jid, { text: reply }, { quoted: message });
    console.log(`[WhatsApp:${bot.id}] menu selection ${selectedId} dilayani`);
    return true;
  }

  async createTelegram(userId, name, token) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Format token Telegram tidak valid.");
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!result.ok) throw new Error("Token Telegram ditolak oleh Telegram.");
    const now = new Date().toISOString();
    const bot = { id: id("bot"), userId, platform: "telegram", name: name || result.result.first_name, username: result.result.username, status: "online", messagesReceived: 0, createdAt: now, updatedAt: now };
    const bots = read("bots.json"); bots.push(bot); write("bots.json", bots);
    const secrets = read("bot-secrets.json"); secrets[bot.id] = encrypt(token); write("bot-secrets.json", secrets);
    this.startTelegram(bot.id).catch(error => this.update(bot.id, { status: "error", error: error.message }));
    return this.publicBot(bot);
  }

  async startTelegram(botId) {
    const secret = read("bot-secrets.json")[botId];
    if (!secret || this.instances.has(botId)) return;
    const token = decrypt(secret), controller = new AbortController();
    this.instances.set(botId, { platform: "telegram", close: () => controller.abort() });
    this.update(botId, { status: "online", error: null });
    let offset = 0;
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`, { signal: controller.signal });
        const data = await response.json();
        if (!data.ok) throw new Error(data.description || "Telegram polling gagal.");
        if (data.result.length) {
          offset = data.result[data.result.length - 1].update_id + 1;
          const bot = read("bots.json").find(item => item.id === botId);
          this.update(botId, { status: "online", messagesReceived: (bot?.messagesReceived || 0) + data.result.length, lastMessageAt: new Date().toISOString() });
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        this.update(botId, { status: "error", error: error.message });
        await sleep(5000);
      }
    }
  }

  normalizePhone(rawNumber) {
    let phone = String(rawNumber || "").replace(/\D/g, "");
    if (phone.startsWith("00")) phone = phone.slice(2);
    if (phone.startsWith("0")) phone = `62${phone.slice(1)}`;
    if (!/^\d{8,15}$/.test(phone)) throw new Error("Nomor wajib 8-15 digit termasuk kode negara, tanpa tanda +.");
    return phone;
  }

  async createWhatsApp(userId, name, rawNumber) {
    const phone = this.normalizePhone(rawNumber);
    const now = new Date().toISOString();
    const bot = {
      id: id("bot"),
      userId,
      platform: "whatsapp",
      name: name || `WhatsApp ${phone.slice(-4)}`,
      phoneMasked: `${phone.slice(0, 3)}••••${phone.slice(-3)}`,
      status: "pairing",
      messagesReceived: 0,
      createdAt: now,
      updatedAt: now
    };
    const bots = read("bots.json"); bots.push(bot); write("bots.json", bots);
    try {
      return await this.startWhatsApp(bot.id, phone);
    } catch (error) {
      await this.remove(bot.id, userId);
      throw error;
    }
  }

  async startWhatsApp(botId, pairingPhone) {
    if (!read("bots.json").some(bot => bot.id === botId)) throw new Error("Bot tidak ditemukan.");
    if (this.instances.has(botId)) return this.publicBot(this.update(botId, {}));

    this.clearRestart(botId);
    const B = await this.loadBaileys();
    const sessionPath = path.join(SESSION_ROOT, botId);
    const { state, saveCreds } = await B.useMultiFileAuthState(sessionPath);
    const version = await this.latestWaVersion(B);
    const registeredAtStart = Boolean(state.creds.registered);
    const groupCache = new NodeCache({ stdTTL: 300, useClones: false });
    // Commands may arrive from the primary phone as fromMe=true because this
    // Baileys socket is a linked companion of the same WhatsApp account.
    // Keep a short-lived ID cache so the same command is never executed twice
    // when WhatsApp replays/synchronizes an upsert.
    const commandCache = new NodeCache({ stdTTL: 180, checkperiod: 60, useClones: false });
    const socketStartedAt = Date.now();

    const socketConfig = {
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || "silent" }),
      // WhatsApp currently terminates fresh Baileys sessions with 428 when
      // WIN32/DARWIN Desktop webSubPlatform is advertised. Ubuntu/Chrome keeps
      // the connection on WEB_BROWSER and still allows syncFullHistory.
      browser: B.Browsers.ubuntu("Chrome"),
      syncFullHistory: true,
      cachedGroupMetadata: async jid => groupCache.get(jid),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000
    };
    if (version) socketConfig.version = version;

    const sock = B.default(socketConfig);
    const instanceId = crypto.randomUUID();
    const instance = {
      id: instanceId,
      platform: "whatsapp",
      manual: false,
      close: () => {
        instance.manual = true;
        try { sock.end(undefined); } catch (_) {}
      }
    };
    this.instances.set(botId, instance);

    console.log(`[WhatsApp:${botId}] socket ${registeredAtStart ? "restore" : "pairing"}, WA Web ${version ? version.join(".") : "default"}`);

    let credsSaveQueue = Promise.resolve();
    const queueCredsSave = () => {
      credsSaveQueue = credsSaveQueue.then(async () => {
        const current = this.instances.get(botId);
        if (instance.manual || (current && current.id !== instanceId)) return;
        await saveCreds();
      }).catch(error => console.error(`[WhatsApp:${botId}] gagal menyimpan session:`, error.message));
      return credsSaveQueue;
    };

    sock.ev.on("creds.update", () => {
      queueCredsSave();
      if (state.creds.registered) {
        this.update(botId, {
          status: "connecting",
          pairingCode: null,
          error: null,
          pairingAcceptedAt: new Date().toISOString()
        });
      }
    });

    sock.ev.on("groups.update", async ([event]) => {
      try { groupCache.set(event.id, await sock.groupMetadata(event.id)); } catch (_) {}
    });
    sock.ev.on("group-participants.update", async event => {
      try { groupCache.set(event.id, await sock.groupMetadata(event.id)); } catch (_) {}
    });
    sock.ev.on("messages.upsert", async event => {
      for (const message of event.messages || []) {
        if (!message?.message || !message?.key?.remoteJid) continue;

        const currentBot = read("bots.json").find(item => item.id === botId);
        if (!currentBot) continue;

        const text = this.incomingText(B, message);
        const selectedId = this.selectedMenuId(B, message);
        const isKnownCommand = /^\.(?:menu|am|verif)(?:\s|$)/i.test(text);
        const isKnownSelection = Boolean(selectedId?.startsWith("amg_menu_"));

        // Ignore normal outgoing messages from this linked account. We only
        // allow our explicit commands/selections through, so replies sent by
        // the bot itself (also fromMe=true) cannot create a response loop.
        if (!isKnownCommand && !isKnownSelection) continue;

        // `notify` is the normal online event. A command sent from the primary
        // phone can also be synchronized to a linked companion in another
        // upsert type, so accept it only when the message is fresh. This avoids
        // executing old commands from history after a restart.
        const rawTimestamp = Number(message.messageTimestamp || 0);
        const messageTime = rawTimestamp > 1e12 ? rawTimestamp : rawTimestamp * 1000;
        const freshEnough = !messageTime || messageTime >= socketStartedAt - 15000;
        if (event.type !== "notify" && !freshEnough) continue;

        const messageId = String(message.key.id || "");
        if (messageId && commandCache.has(messageId)) continue;
        if (messageId) commandCache.set(messageId, true);

        const commandName = isKnownSelection
          ? "single_select"
          : (text.match(/^\.([a-z0-9_-]+)/i)?.[1] || "unknown").toLowerCase();
        console.log(`[WhatsApp:${botId}] command received: ${commandName}; type=${event.type || "unknown"}; fromMe=${Boolean(message.key.fromMe)}; jid=${message.key.remoteJid}`);

        let handled = false;
        try {
          if (isKnownSelection) {
            handled = await this.handleWhatsAppMenuSelection(B, sock, currentBot, message, selectedId);
          } else if (text.toLowerCase() === ".menu") {
            await this.sendWhatsAppMenu(B, sock, currentBot, message);
            handled = true;
          } else {
            handled = await this.handleWhatsAppTaskCommand(sock, currentBot, message, text);
          }
        } catch (error) {
          console.error(`[WhatsApp:${botId}] command/menu error:`, error.message);
          try {
            await sock.sendMessage(
              message.key.remoteJid,
              { text: "⚠️ Command gagal diproses. Silakan coba lagi beberapa saat." },
              { quoted: message }
            );
          } catch (replyError) {
            console.error(`[WhatsApp:${botId}] gagal mengirim error reply:`, replyError.message);
          }
        }

        if (handled) {
          const bot = read("bots.json").find(item => item.id === botId);
          this.update(botId, {
            messagesReceived: (bot?.messagesReceived || 0) + 1,
            lastMessageAt: new Date().toISOString()
          });
        }
      }
    });

    sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
      const current = this.instances.get(botId);
      if (instance.manual) return;
      if (current && current.id !== instanceId) return;

      if (connection === "open") {
        this.clearRestart(botId);
        this.update(botId, {
          status: "online",
          pairingCode: null,
          error: null,
          connectedAt: new Date().toISOString()
        });
        console.log(`[WhatsApp:${botId}] connection opened; command listener ready`);
        // Keep the linked socket passive. This also avoids the companion being
        // treated as an actively-open desktop client for notification routing.
        try { await sock.sendPresenceUpdate("unavailable"); } catch (_) {}
        return;
      }

      if (connection !== "close") return;
      if (current?.id === instanceId) this.instances.delete(botId);

      await credsSaveQueue.catch(() => {});
      const latestInstance = this.instances.get(botId);
      if (instance.manual || (latestInstance && latestInstance.id !== instanceId)) return;

      const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.data?.statusCode;
      const reason = lastDisconnect?.error?.message || lastDisconnect?.error?.output?.payload?.message || "Connection closed";
      const registeredNow = Boolean(state.creds.registered);
      const loggedOut = statusCode === B.DisconnectReason.loggedOut;
      const restartRequired = statusCode === B.DisconnectReason.restartRequired || Number(statusCode) === 515;

      console.warn(`[WhatsApp:${botId}] koneksi tertutup (${statusCode || "unknown"}): ${reason}; registered=${registeredNow}`);

      if (loggedOut) {
        this.update(botId, {
          status: "logged_out",
          pairingCode: null,
          error: "Sesi keluar dari WhatsApp. Hapus bot lalu lakukan pairing ulang."
        });
        return;
      }

      // Baileys/WhatsApp intentionally sends 515 after successful companion pairing.
      // The same saved auth state must be loaded into a fresh socket. Do not mark it
      // as a pairing failure merely because this socket started as unregistered.
      if (restartRequired) {
        this.update(botId, {
          status: "reconnecting",
          pairingCode: null,
          error: null,
          lastDisconnectCode: 515,
          pairingAcceptedAt: registeredNow ? new Date().toISOString() : undefined
        });
        console.log(`[WhatsApp:${botId}] 515 restartRequired diterima, restart otomatis...`);
        this.scheduleWhatsAppRestart(botId, 900);
        return;
      }

      if (registeredNow || registeredAtStart) {
        this.update(botId, {
          status: "reconnecting",
          pairingCode: null,
          error: null,
          lastDisconnectCode: statusCode || null
        });
        this.scheduleWhatsAppRestart(botId, 2500);
        return;
      }

      this.update(botId, {
        status: "error",
        error: `Koneksi WhatsApp terputus (${statusCode || "unknown"}) sebelum pairing selesai.`
      });
    });

    if (!sock.authState.creds.registered && pairingPhone) {
      try {
        // Official Baileys pairing-code flow: create socket first, wait for the
        // socket update that indicates WhatsApp Web has generated the pairing
        // reference, then request the code. Calling requestPairingCode too early
        // can make WhatsApp terminate the handshake (428).
        const pairingCode = await new Promise((resolve, reject) => {
          let done = false;
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            reject(new Error("Timeout menunggu socket WhatsApp siap membuat pairing code."));
          }, 30000);

          const handler = async (update) => {
            try {
              if (update.connection === "close") {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(update.lastDisconnect?.error || new Error("Socket WhatsApp tertutup."));
                return;
              }

              if (!done && update.qr) {
                done = true;
                clearTimeout(timer);
                try {
                  resolve(await sock.requestPairingCode(pairingPhone));
                } catch (error) {
                  reject(error);
                }
              }
            } catch (error) {
              if (!done) {
                done = true;
                clearTimeout(timer);
                reject(error);
              }
            }
          };

          sock.ev.on("connection.update", handler);
        });

        await queueCredsSave();
        const cleanCode = String(pairingCode || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
        if (cleanCode.length !== 8) throw new Error("WhatsApp tidak memberikan pairing code yang valid.");
        return this.publicBot(this.update(botId, {
          status: "pairing",
          pairingCode: cleanCode,
          pairingCreatedAt: new Date().toISOString(),
          error: null
        }));
      } catch (error) {
        instance.manual = true;
        try { sock.end(undefined); } catch (_) {}
        if (this.instances.get(botId)?.id === instanceId) this.instances.delete(botId);
        const code = error?.output?.statusCode || error?.data?.statusCode || "unknown";
        console.error(`[WhatsApp:${botId}] pairing handshake gagal (${code}):`, error.message);
        if (Number(code) === 428) {
          throw new Error("WhatsApp menutup koneksi awal (428). Socket sudah memakai mode Web Browser; tunggu beberapa detik lalu coba lagi.");
        }
        throw new Error(`Pairing code gagal dibuat (kode ${code}). Coba lagi beberapa saat.`);
      }
    }

    return this.publicBot(this.update(botId, {
      status: state.creds.registered ? "connecting" : "pairing",
      error: null
    }));
  }

  async reconnect(botId, userId) {
    const bot = this.findOwned(botId, userId);
    if (!bot) throw new Error("Bot tidak ditemukan.");
    this.clearRestart(botId);
    const instance = this.instances.get(botId);
    if (instance) instance.close();
    this.instances.delete(botId);

    if (bot.platform === "telegram") {
      await this.startTelegram(botId);
      return this.publicBot(this.update(botId, {}));
    }
    if (bot.status === "logged_out") throw new Error("Sesi WhatsApp sudah keluar. Hapus bot lalu buat pairing baru.");
    await sleep(150);
    return this.startWhatsApp(botId);
  }

  async renewPairingCode(botId, userId, rawNumber) {
    const bot = this.findOwned(botId, userId);
    if (!bot || bot.platform !== "whatsapp") throw new Error("Bot WhatsApp tidak ditemukan.");
    const phone = this.normalizePhone(rawNumber);

    this.clearRestart(botId);
    const instance = this.instances.get(botId);
    if (instance) instance.close();
    this.instances.delete(botId);

    // Give the old socket a brief moment to stop emitting credential writes before
    // removing its auth directory and starting a completely fresh pairing attempt.
    await sleep(200);
    fs.rmSync(path.join(SESSION_ROOT, botId), { recursive: true, force: true });
    this.update(botId, {
      status: "pairing",
      pairingCode: null,
      error: null,
      pairingAcceptedAt: null,
      connectedAt: null,
      lastDisconnectCode: null
    });
    return this.startWhatsApp(botId, phone);
  }

  async remove(botId, userId) {
    const bot = this.findOwned(botId, userId);
    if (!bot) return false;
    this.clearRestart(botId);
    const instance = this.instances.get(botId);
    if (instance) instance.close();
    this.instances.delete(botId);
    await sleep(100);
    write("bots.json", read("bots.json").filter(item => item.id !== botId));
    const secrets = read("bot-secrets.json"); delete secrets[botId]; write("bot-secrets.json", secrets);
    fs.rmSync(path.join(SESSION_ROOT, botId), { recursive: true, force: true });
    return true;
  }

  cleanupOrphanSessions() {
    const active = new Set(read("bots.json").map(bot => bot.id));
    if (!fs.existsSync(SESSION_ROOT)) return;
    for (const session of fs.readdirSync(SESSION_ROOT)) {
      if (!active.has(session)) {
        fs.rmSync(path.join(SESSION_ROOT, session), { recursive: true, force: true });
        console.log(`[BotManager] removed orphan session ${session}`);
      }
    }
  }

  async restore() {
    this.cleanupOrphanSessions();
    for (const bot of read("bots.json")) {
      if (bot.platform === "telegram") this.startTelegram(bot.id).catch(() => {});
      if (bot.platform === "whatsapp" && bot.status !== "logged_out" && fs.existsSync(path.join(SESSION_ROOT, bot.id))) {
        this.startWhatsApp(bot.id).catch(error => this.update(bot.id, { status: "error", error: error.message }));
      }
    }
  }
}

module.exports = new BotManager();
