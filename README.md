# VOIP VC - Call Bridge System

**Production-ready real-time call bridge system connecting cellular devices to web dashboards via Socket.IO**

---

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Development](#development)
- [Production Deployment](#production-deployment)
- [Android APK](#android-apk)
- [API Reference](#api-reference)
- [Testing](#testing)
- [Performance & Optimization](#performance--optimization)

---

## 🚀 Quick Start

### Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | 20+ LTS |
| MySQL / MariaDB | 8.0+ / 10.6+ |
| Android Studio | (optional, for APK builds) |

### Local Development

```powershell
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your database credentials

# 3. Start the server
npm start

# 4. Open in browser
# http://127.0.0.1:3000/login
```

### Create First Account

```powershell
npm run auth:user:add -- admin ADMINISTRADOR
```

The password is requested twice without being displayed on screen.

---

## 🏗️ Architecture

```
SISTEMA_LLAMADAS/
├── backend/          # Node.js + Express + Socket.IO server
├── frontend/         # Vanilla JS modular (no build required)
├── android-app/      # Android APK bridge (Kotlin)
├── docs/             # Architecture documentation
├── infrastructure/   # VPS deployment configs
└── README.md
```

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Backend | Node.js 20+ | REST API + WebSocket server |
| Database | MySQL 8.0+ | Session persistence, call history |
| Frontend | Vanilla JS | Dashboard + phone bridge UI |
| Mobile | Kotlin + Socket.IO | Android device bridge |
| Real-time | Socket.IO 4.8+ | Bidirectional communication |

---

## 🔧 Development

### Environment Variables

```env
# Local Development
DB_HOST=localhost
DB_PORT=3306
DB_NAME=your_database
DB_USER=your_user
DB_PASSWORD=your_password
PORT=3000
```

**Auto-configured (local profile):**
- `HOST=127.0.0.1`
- `TRUST_PROXY=0`
- `CORS_ORIGIN=http://127.0.0.1:3000,http://localhost:3000`
- `AUTH_LOCAL_ISOLATED=1`

### Available Features

- **Network Monitor**: Admin panel at `/nucleo-red` with 10 virtual devices
- **APK Build**: Android project with auto-model download
- **QR Pairing**: Session tokens and device binding
- **Call Management**: Dial, hangup, call state tracking
- **Campaign System**: Contact lists, dispatch, reporting

### Testing

```powershell
npm test                    # Run all tests
npm run test:contracts      # HTTP contracts and socket events
npm run test:network       # Network monitor tests
npm run test:auth          # Authentication tests
```

---

## 🚀 Production Deployment

### Profile: Easypanel / VPS

For production, use `APP_ENV=easypanel` or the VPS profile. Supports:

- Multiple users and accounts
- Remote MySQL access
- Public domains with HTTPS
- Multiple Android device profiles
- Scalability and rate limiting

### Quick Deploy (Render)

1. Push repo to GitHub
2. Create **Web Service** from repo on Render
3. Render auto-detects `render.yaml` or use:
   - Build: `npm install`
   - Start: `npm run start`
4. Configure:
   - `PUBLIC_BASE_URL=https://TU-APP.onrender.com`
5. Test:
   - `https://TU-APP.onrender.com/` (dashboard)
   - `https://TU-APP.onrender.com/phone` (phone bridge)
   - `https://TU-APP.onrender.com/health`

### VPS Deployment (Ubuntu 22.04+)

```bash
# Install dependencies
sudo apt update && sudo apt install -y nodejs npm nginx mysql-server

# Deploy
sudo mkdir -p /opt/voip-vc
sudo chown -R $USER:$USER /opt/voip-vc
cd /opt/voip-vc
npm ci --omit=dev
cp .env.example .env
# Edit .env with production credentials

# Install service
sudo cp infrastructure/vps/voip-vc.service /etc/systemd/system/
sudo systemctl enable voip-vc
sudo systemctl start voip-vc

# Configure Nginx
sudo cp infrastructure/vps/nginx.voip-vc.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/nginx.voip-vc.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**Production environment:**
```env
PORT=3000
HOST=0.0.0.0
PUBLIC_BASE_URL=https://api.tudominio.com
PUBLIC_WEB_BASE_URL=https://api.tudominio.com
CORS_ORIGIN=https://api.tudominio.com
TRUST_PROXY=1
DB_HOST=mysql-internal-host
DB_PORT=3306
DB_NAME=production_db
DB_USER=production_user
DB_PASSWORD=secure_password
```

### Separate Domains

If separating frontend and backend:

**Backend:**
```env
PUBLIC_BASE_URL=https://api.tudominio.com
PUBLIC_WEB_BASE_URL=https://app.tudominio.com
CORS_ORIGIN=https://app.tudominio.com,https://api.tudominio.com
```

**Frontend URLs:**
- Dashboard: `https://app.tudominio.com/?apiBase=https://api.tudominio.com`
- Phone: `https://app.tudominio.com/phone?apiBase=https://api.tudominio.com`

---

## 📱 Android APK

### Build Instructions

1. Copy `android-app/.env.example` to `android-app/.env`
2. Configure URLs:
   - `ANDROID_DEV_BASE_URL=http://127.0.0.1:3000` (USB dev)
   - `ANDROID_PROD_BASE_URL=https://api.tudominio.com`
3. Open `android-app/` in Android Studio
4. Wait for Gradle sync
5. Build → Build APK(s)

### APK Features

- QR scan for pairing (`code` + `token`)
- Socket.IO connection as `role=phone`
- Audio bridge (AudioRecord/AudioTrack)
- Voicemail detection (Shizuku/Vosk)
- Call state synchronization
- Speaker/mic control

---

## 🔌 API Reference

### Session Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/session/:code/campaign/start` | Start campaign with contacts |
| POST | `/api/session/:code/campaign/pause` | Pause active campaign |
| POST | `/api/session/:code/campaign/resume` | Resume paused campaign |
| POST | `/api/session/:code/campaign/stop` | Stop campaign |
| GET | `/api/session/:code/contact-book` | Get contact book |
| PUT | `/api/session/:code/contact-book` | Update contact book |

### Device Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/pairing/:code` | Get pairing info |
| POST | `/api/pairing/token/:code` | Generate pairing token |
| POST | `/api/android/pair` | Android device pairing |
| GET | `/api/pairing-qr/:code.svg` | Generate QR code |

### Network Monitor

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/network` | Get network snapshot |
| POST | `/api/network/reconnect` | Reconnect all devices |
| POST | `/api/network/equipment/:number/reconnect` | Reconnect specific device |

### Reports

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/session/:code/reports/daily` | Get daily reports |
| GET | `/api/session/:code/reports/attempts` | Get call attempts |
| POST | `/api/session/:code/reports/:id/continue` | Continue from report |

---

## 🧪 Testing

```powershell
npm test                    # All tests
npm run test:contracts     # HTTP contracts and socket events
npm run test:network       # Network monitor tests
npm run test:auth          # Authentication tests
```

**Coverage:** HTTP contracts, socket events, campaign management, report metrics, user auth, network monitor.

---

## ⚡ Performance & Optimization

### Binlog Optimization (Nov 2025)

Technical audit identified and fixed **5 critical optimizations**:

| # | Fix | File | Impact |
|---|-----|------|--------|
| 1 | `historyGate.commit()` saves only affected session | `call-history-gate.js:38` | Eliminates 20MB writes per event |
| 2 | `ON DUPLICATE KEY UPDATE` with change detection | `persistence.js:258-262` | Eliminates redundant binlog entries |
| 3 | `sendPersistedDial` saves only dialed session | `dispatcher.js:40` | Eliminates writes before each dial |
| 4 | `syncPendingContacts` with `_syncPendingSkip` | `shift-manager.js:104-163` | Eliminates rebuild on state emit |
| 5 | `allCallAttempts` with session-based caching | `restrictions.js:1-20` | Eliminates O(n) computation |

**Result:** Binlog growth reduced from ~36 GB/hour to < 10 MB/hour under normal load.

**Full audit plan:** `.kilo\plans\1795120535465-technical-audit-call-system.md`

### Performance Metrics

| Metric | Target | Pre-fix |
|--------|--------|---------|
| Persistence latency p99 | < 100ms | ~500ms |
| Event loop lag | < 10ms | ~200ms |
| Binlog growth rate | < 10 MB/hour | ~36 GB/hour |

---

## 📄 License & Credits

**Project:** VOIP VC Call Bridge System  
**Version:** 0.1.0  
**Node.js:** >= 20.0.0  
**MySQL:** 8.0+ / MariaDB 10.6+

---

**Note:** The local XAMPP profile is for development and testing only. For production, use `APP_ENV=easypanel` or the VPS profile.