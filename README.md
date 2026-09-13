# AM Generator

Express + EJS portal with user dashboard, admin dashboard, API key management, task workflow, JSON persistence, developer documentation, collapsible navigation, and GitHub OAuth login.

## API Reference

Three API endpoints are exposed under `/api/v1`:

- `GET /api/v1/checkstatus` — check API key status and quota
- `POST /api/v1/request` — request a link to an email
- `POST /api/v1/linkmagic` — process an input magic link

All endpoints require an active API key using `Authorization: Bearer YOUR_API_KEY` or `x-api-key`.

## Dynamic Docs Base URL

The `/docs` page no longer hardcodes `http://localhost:3000`. The base URL is generated from the current request origin, so the examples automatically follow the website domain and protocol.

No `BASE_URL`, `APP_URL`, or similar `.env` variable is required for Docs.

When deploying behind a reverse proxy, forward the original host and protocol normally (`Host` / `X-Forwarded-Proto`). Express proxy trust is enabled in `server.js`.

## GitHub Login / Signup

The Login and Signup pages now use the GitHub OAuth web application flow. Google is intentionally marked **Coming Soon**.

Create or open your GitHub OAuth App and configure:

- **Homepage URL:** `https://YOUR-DOMAIN`
- **Authorization callback URL:** `https://YOUR-DOMAIN/auth/github/callback`

Then provide these server-side secrets:

```env
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
```

Do not put the GitHub client secret in EJS, browser JavaScript, or public JSON. It must remain server-side. The callback URL itself is built automatically from the current website origin.

The app requests `read:user user:email`, reads the authenticated GitHub profile and a verified email, and then creates or links the local AM Generator account. GitHub access tokens are not written to `data/users.json`.

## JSON Data Storage

Runtime data is stored in `data/*.json`:

- `users.json`
- `api-keys.json`
- `requests.json`
- `tasks.json`
- `bots.json`
- `activity.json`
- `artifacts.json`
- `settings.json`

The data layer creates missing files automatically and writes updates to the same runtime data directory. The Admin Dashboard now shows the actual data directory and row counts.

Important: the JSON files inside a downloaded source ZIP are only a source snapshot; they cannot automatically contain users from another running server. If the production host uses an ephemeral/read-only filesystem (common on serverless platforms), local JSON files are not suitable as permanent production storage. Use a persistent disk/volume or migrate the storage layer to a real database for production persistence.

`DATA_DIR` is optional and is only needed if your hosting provider gives you a specific persistent mounted folder. On a normal persistent Node.js host, no extra setting is required.

## API Key Navigation

Creating or revoking a key from **Profile → API Key** returns to `/profile#api` instead of redirecting to Dashboard.

## Userbot

The three hardcoded dummy Userbots were removed. **Create Bot** now supports Telegram and WhatsApp. WhatsApp uses the official `@whiskeysockets/baileys` package with pairing by phone number, while Telegram uses a BotFather token.

## Run

1. Copy `.env.example` to `.env` if needed.
2. Fill required server secrets.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000` for local development.

The supplied AM service remains under `services/AlightMotionAuth.js`. Use only credentials and links you are authorized to process, and keep API credentials out of public client-side code.

## Create Bot

- WhatsApp memakai `@whiskeysockets/baileys` dengan pairing code. Nomor harus memakai kode negara dan hanya berisi angka, misalnya `62812...`.
- Telegram memakai token dari `@BotFather`; token divalidasi lalu disimpan dalam bentuk terenkripsi.
- Metadata tersimpan di `data/bots.json`, sedangkan session WhatsApp tersimpan per bot di `data/bot-sessions/`.
- Bot milik setiap pengguna dipisahkan berdasarkan akun dan session dipulihkan saat server restart.

Gunakan Node.js 20 atau lebih baru dan hosting dengan filesystem persisten agar session tidak hilang saat restart atau redeploy.

Pairing nomor WhatsApp sekarang menangani `DisconnectReason.restartRequired` (`515`) secara otomatis. Sesudah kode diterima di WhatsApp, Baileys dapat menutup socket pertama dengan 515 agar koneksi direstart. AM Generator menyimpan auth state, menandai status **Menghubungkan ulang**, membuat socket baru dengan session yang sama, lalu mengubah bot menjadi **Online** ketika koneksi terbuka. Jangan membuat kode baru saat status sedang `connecting`/`reconnecting`; tunggu proses restart selesai. Jika WhatsApp benar-benar menolak kode atau session menjadi `logged_out`, baru lakukan pairing ulang.


### WhatsApp pairing 428 compatibility
Untuk pairing baru, socket memakai `Browsers.ubuntu("Chrome")` dengan `syncFullHistory: true`.
Ini sengaja tidak memakai `Browsers.macOS("Desktop")`/`Browsers.windows("Desktop")` karena
WhatsApp saat ini dapat memutus koneksi fresh session dengan status 428 ketika Baileys
mengiklankan sub-platform DARWIN/WIN32. Setelah pairing diterima, handler 515
`restartRequired` tetap melakukan restart otomatis menggunakan auth state yang sama.


### WhatsApp `.menu` single-select
Perintah `.menu` sekarang mengirim satu pesan interaktif Native Flow `single_select`.
Pesan tersebut me-reply pesan `.menu` asli, menampilkan sapaan, informasi pengirim WhatsApp,
ringkasan akun AM Generator milik pemilik bot (email dimasking), status API/quota, jumlah bot,
task, dan request API. API key tidak pernah dikirim ke WhatsApp.

Pilihan single-select:
- Informasi Akun
- Informasi Bot
- API & Quota
- Aktivitas
- Bantuan

Balasan pilihan menggunakan quoted reply WhatsApp normal (`{ quoted: message }`), bukan
mengirim view-once/contacts sebagai pesan tambahan.


### WhatsApp AM Task
Perintah `.am email` sekarang langsung memakai endpoint yang sama dengan halaman Dokumentasi: `POST /api/v1/request`. Bot menggunakan API Key aktif milik pemilik bot melalui request internal ke website, sehingga validasi API Key, quota, audit request, dan pengiriman link mengikuti flow Docs. Setelah endpoint berhasil, task disimpan ke `tasks.json` dan hanya mereferensikan `apiKeyId` (secret API Key tidak disimpan ke task).


## WhatsApp Task AM v12

- `.am email@example.com` membutuhkan API Key aktif milik akun website pemilik bot.
- Request `.am` dikirim langsung ke endpoint Docs `/api/v1/request`; endpoint tersebut yang memvalidasi API Key dan quota.
- API Key dipilih otomatis dari akun website dan hanya `apiKeyId` yang direferensikan pada task.
- Task dari WhatsApp disimpan di `tasks.json`, sehingga muncul pada dashboard Task milik user yang sama.
- `.verif https://...` diarahkan ke alur **LinkMagic** melalui endpoint docs `/api/v1/linkmagic`.
- `.verif` menggunakan endpoint Docs `/api/v1/linkmagic` dari `BotManager.js`; `AlightMotionAuth.js` tetap tidak diubah.
- Semua balasan command menggunakan quoted reply WhatsApp.


### Admin API unlimited (v13)
API key yang dibuat oleh akun dengan role `admin` otomatis memakai plan `admin` dan `unlimited: true`. Admin tidak mengonsumsi quota harian, tidak memiliki waktu reset quota, dan API `/checkstatus`, Profile, serta WhatsApp Userbot menampilkan `UNLIMITED`. API key admin lama juga diperlakukan unlimited berdasarkan role pemiliknya.

### v14 - WhatsApp self-command + pairing modal fix
- Command `.menu`, `.am`, `.verif`, dan pilihan single-select sekarang tetap diproses ketika pesan berasal dari nomor WhatsApp pemilik sendiri (`fromMe=true`). Ini penting karena Baileys berjalan sebagai linked companion device.
- Bot hanya memproses command yang dikenal sehingga balasan bot sendiri tidak memicu loop.
- Dedupe message ID + freshness guard mencegah command lama dari history dijalankan ulang saat socket restart.
- Console menampilkan command yang diterima (nama command, tipe upsert, fromMe, dan JID) tanpa mencetak isi email/link command.
- Saat pairing aktif, halaman memeriksa status sekitar setiap 850 ms. Begitu backend berstatus `online`, modal pairing menampilkan sukses lalu tertutup otomatis.
