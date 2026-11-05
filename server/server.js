import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import fs from "fs";
import os from "os";
import dgram from "dgram";
import net from "net";
import dns from "dns/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import { bindDeviceToPairingSlot, clearDeviceFromPairingSlots, dedupePairingSlotDevices } from "./pairing-lifecycle.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import dotenv from "dotenv";
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import { SessionPersistence } from "./persistence.js";
import {
  ensureCampaign,
  getCampaignSnapshot,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  assignNextContact,
  assignSpecificContact,
  ensureCampaignContact,
  updateActiveCallState,
  markContactResult,
  skipActiveContact,
  holdActiveContact,
  resumeHeldContact,
  getActiveContact,
  getContactByWorker,
  getActiveAttemptId,
  setWorkerPaused,
  isWorkerPaused,
  resetCampaignForShift,
  resetCampaignOperation,
  switchWorkerList
} from "./campaign-manager.js";
import {
  ensureShiftManagement,
  syncPendingContacts,
  finalizeCurrentTurn,
  finalizeCurrentSession,
  markPendingCampaignStarted,
  getShiftSnapshot
} from "./shift-manager.js";
const persistence = new SessionPersistence(process.env.SESSIONS_FILE || path.join(__dirname, "sessions.json"));

const app = express();
app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : false);
const server = http.createServer(app);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "https://llamada.viacomunicativa.com,https://lm.viacomunicativa.com,http://localhost:3000";
const corsOptions = {
  origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean),
  methods: ["GET", "POST", "OPTIONS"],
  credentials: false
};
app.use(cors(corsOptions));

const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: Number(process.env.SOCKET_PING_TIMEOUT_MS || 20000),
  pingInterval: Number(process.env.SOCKET_PING_INTERVAL_MS || 25000),
  connectTimeout: 45000,
  maxHttpBufferSize: Number(process.env.SOCKET_MAX_HTTP_BUFFER_SIZE || 1048576)
});


app.use((req, res, next) => {
  const allowedOrigin = CORS_ORIGIN;
  if (allowedOrigin === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    const allowed = allowedOrigin.split(",").map(s => s.trim()).filter(Boolean);
    const origin = req.headers.origin || "";
    if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Dashboard-Token, ngrok-skip-browser-warning");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


app.use(express.json({ limit: process.env.MAX_JSON_SIZE || "256kb" }));
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=()");
  next();
});

function createRateLimiter({ windowMs = 60000, max = 60 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: "Demasiadas solicitudes. Intenta nuevamente en unos segundos." });
    }
    next();
  };
}

// Reloading the grid fetches every visible QR, so several newly-created slots
// legitimately generate more than 30 requests in one minute.
const pairingRateLimit = createRateLimiter({ windowMs: 60000, max: 180 });
const remoteFetchRateLimit = createRateLimiter({ windowMs: 60000, max: 10 });

server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 65000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

let sessions = new Map();

async function bootstrap() {
  sessions = await persistence.load();
  // Socket IDs and live calls cannot survive a backend restart. Return every
  // interrupted assignment to the retry queue so campaigns never stay stuck.
  for (const [code, loadedSession] of sessions.entries()) {
    const session = normalizeSessionShape(loadedSession);
    sessions.set(code, session);
    const campaign = ensureCampaign(session);
    for (const workerId of Object.keys(campaign.assignments || {})) {
      skipActiveContact(session, workerId);
    }
    session.callState = "idle";
  }
  await persistence.save(sessions);
  console.log(`[PERSISTENCE] Loaded ${sessions.size} sessions.`);

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  server.listen(port, host, () => {
    console.log(`Call bridge running on http://localhost:${port}`);
  });
}

function saveSoon() {
  persistence.save(sessions);
}

function createPhoneWorker({ socketId = null, id = "", deviceId = "", name = "", deviceName = "", linkedAt, connected = false, callState = "idle", ...rest } = {}) {
  return {
    ...rest,
    socketId,
    id: deviceId || id || "android-worker",
    name: deviceName || name || "Android bridge",
    linkedAt: linkedAt || new Date().toISOString(),
    connected: Boolean(connected),
    callState: callState || "idle"
  };
}

function createPairingSlot(index = 0, slot = {}) {
  return {
    id: String(slot.id || nanoid(8)),
    token: String(slot.token || nanoid(20)),
    label: `EQUIPO ${index + 1}`,
    deviceId: String(slot.deviceId || ""),
    deviceName: String(slot.deviceName || ""),
    linkedAt: slot.linkedAt || null
  };
}

function getPairingSlotByToken(session, token) {
  return (session.pairingSlots || []).find((slot) => slot.token === token) || null;
}

function normalizeSessionShape(session = {}) {
  const normalized = {
    dashboardSocketId: null,
    dashboardClientId: "",
    phoneSocketId: null,
    activePhoneSocketId: null,
    callState: "idle",
    lastNumber: "",
    lastCompanyName: "",
    lastContactName: "",
    lastImageUrl: "",
    pairingToken: nanoid(20),
    dashboardToken: nanoid(32),
    phoneDevice: null,
    phoneWorkers: [],
    pairingSlots: [],
    micMuted: true,
    isSpeakerOn: false,
    pbx: {
      activeChannelId: "",
      activeBridgeId: "",
      externalMediaChannelId: "",
      externalMediaHost: "",
      externalMediaPort: 0,
      lastPlaybackId: "",
      endpoint: "",
      callerId: "",
      appArgs: "",
      lastTtsMedia: "",
      updatedAt: 0
    },
    workerCursor: 0,
    updatedAt: Date.now(),
    ...session
  };

  if (!Array.isArray(normalized.phoneWorkers)) normalized.phoneWorkers = [];
  normalized.phoneWorkers = normalized.phoneWorkers.map((worker) => createPhoneWorker(worker));

  // Keep one canonical record per physical device. Prefer the connected copy
  // when older persisted data contains a disconnected duplicate.
  const workersById = new Map();
  for (const worker of normalized.phoneWorkers) {
    const key = String(worker.id || worker.socketId || "");
    const existing = workersById.get(key);
    if (!existing || (!existing.connected && worker.connected)) workersById.set(key, worker);
  }
  dedupePairingSlotDevices(normalized);
  normalized.phoneWorkers = [...workersById.values()];

  const savedSlots = Array.isArray(normalized.pairingSlots) ? normalized.pairingSlots : [];
  normalized.pairingSlots = savedSlots.map((slot, index) => createPairingSlot(index, slot));
  while (normalized.pairingSlots.length < 3) {
    normalized.pairingSlots.push(createPairingSlot(normalized.pairingSlots.length));
  }

  for (const worker of normalized.phoneWorkers) {
    let slot = normalized.pairingSlots.find((item) => item.id === worker.pairingSlotId || item.deviceId === worker.id);
    if (!slot) slot = normalized.pairingSlots.find((item) => !item.deviceId);
    if (slot) {
      slot.deviceId ||= worker.id;
      slot.deviceName ||= worker.name;
      slot.linkedAt ||= worker.linkedAt || new Date().toISOString();
      worker.pairingSlotId = slot.id;
    }
  }

  if (!normalized.phoneWorkers.length && normalized.phoneDevice) {
    normalized.phoneWorkers.push(createPhoneWorker({
      deviceId: normalized.phoneDevice.id,
      deviceName: normalized.phoneDevice.name,
      linkedAt: normalized.phoneDevice.linkedAt,
      connected: Boolean(normalized.phoneSocketId),
      socketId: normalized.phoneSocketId || null
    }));
  }

  ensureShiftManagement(normalized);

  return normalized;
}

function getConnectedPhoneWorkers(session) {
  return (session.phoneWorkers || []).filter((worker) => worker.connected && worker.socketId);
}

function getPhoneWorkerBySocketId(session, socketId) {
  return (session.phoneWorkers || []).find((worker) => worker.socketId === socketId) || null;
}

function upsertPhoneWorker(session, { socketId, deviceId, deviceName }) {
  const workers = session.phoneWorkers || (session.phoneWorkers = []);
  // Primary match: deviceId. Secondary match: socketId.
  const existingIndex = workers.findIndex((worker) => (deviceId && worker.id === deviceId) || (socketId && worker.socketId === socketId));
  
  if (existingIndex !== -1) {
    const existing = workers[existingIndex];
    existing.socketId = socketId;
    existing.id = deviceId || existing.id;
    existing.name = deviceName || existing.name;
    existing.connected = Boolean(socketId);
    existing.linkedAt = existing.linkedAt || new Date().toISOString();
    existing.callState = existing.callState || "idle";
    // Remove stale duplicates left by older versions while retaining the
    // canonical object and its campaign-related state.
    for (let index = workers.length - 1; index >= 0; index -= 1) {
      if (index !== existingIndex && workers[index].id === existing.id) workers.splice(index, 1);
    }
    return existing;
  }

  const worker = createPhoneWorker({
    socketId,
    deviceId,
    deviceName,
    connected: Boolean(socketId)
  });
  workers.push(worker);
  return worker;
}

function removePhoneWorker(session, socketId) {
  const workers = session.phoneWorkers || [];
  const index = workers.findIndex((worker) => worker.socketId === socketId);
  if (index === -1) return null;

  const [worker] = workers.splice(index, 1);
  return worker;
}

function selectPhoneWorker(session, preferredSocketId = "") {
  const workers = getConnectedPhoneWorkers(session);
  if (!workers.length) return null;

  if (preferredSocketId) {
    const preferred = workers.find((worker) => worker.socketId === preferredSocketId);
    if (preferred) return preferred;
  }

  const idleWorkers = workers.filter((worker) => (worker.callState || "idle") === "idle");
  const candidates = idleWorkers.length ? idleWorkers : workers;
  const start = Number(session.workerCursor || 0) % candidates.length;
  const chosen = candidates[start] || candidates[0];
  session.workerCursor = (start + 1) % candidates.length;
  return chosen;
}

function getActivePhoneWorker(session) {
  return selectPhoneWorker(session, session.activePhoneSocketId || session.phoneSocketId || "");
}

function syncSessionPhoneState(session) {
  const connectedWorkers = getConnectedPhoneWorkers(session);
  const statePriority = { in_call: 5, ringing: 4, dialing: 3, ended: 2, failed: 2, idle: 1, available: 1 };
  const busiestWorker = [...connectedWorkers].sort((a, b) =>
    (statePriority[String(b.callState || "idle")] || 0) - (statePriority[String(a.callState || "idle")] || 0)
  )[0] || null;
  const existingActive = connectedWorkers.find((worker) => worker.socketId === session.activePhoneSocketId) || null;
  const activeWorker = busiestWorker && (statePriority[String(busiestWorker.callState || "idle")] || 0) > 1
    ? busiestWorker
    : existingActive || connectedWorkers[0] || null;
  session.phoneSocketId = activeWorker?.socketId || null;
  session.activePhoneSocketId = activeWorker?.socketId || null;
  session.callState = busiestWorker?.callState || "idle";
  session.phoneDevice = activeWorker
    ? {
        id: activeWorker.id,
        name: activeWorker.name,
        linkedAt: activeWorker.linkedAt
      }
    : connectedWorkers[0]
      ? {
          id: connectedWorkers[0].id,
          name: connectedWorkers[0].name,
          linkedAt: connectedWorkers[0].linkedAt
        }
    : null;
}

function emitCampaignState(code) {
  const session = sessions.get(code);
  if (!session) return;
  const campaign = ensureCampaign(session);
  syncPendingContacts(session, campaign);
  io.to(code).emit("campaign:state", { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) });
}

function disconnectAllSessionPhones(session, reason = "turn_finished") {
  const sockets = [];
  for (const worker of session.phoneWorkers || []) {
    if (!worker.socketId) continue;
    const phoneSocket = io.sockets.sockets.get(worker.socketId);
    if (phoneSocket) sockets.push(phoneSocket);
    if (["dialing", "ringing", "in_call"].includes(String(worker.callState || ""))) {
      io.to(worker.socketId).emit("call:action", { action: "hangup", from: "dashboard", commandId: nanoid() });
    }
    io.to(worker.socketId).emit("session:force_logout", { reason });
  }
  for (const slot of session.pairingSlots || []) {
    slot.deviceId = "";
    slot.deviceName = "";
    slot.linkedAt = null;
  }
  session.phoneWorkers = [];
  session.phoneDevice = null;
  session.phoneSocketId = null;
  session.activePhoneSocketId = null;
  session.callState = "idle";
  // Android waits briefly for its logout acknowledgement before clearing
  // credentials. Keep the socket alive long enough to finish that handshake.
  setTimeout(() => sockets.forEach((phoneSocket) => {
    if (phoneSocket.connected) phoneSocket.disconnect(true);
  }), 2200);
}

function hasPersistentCampaignData(session) {
  const campaign = ensureCampaign(session);
  return campaign.contacts.length > 0 || campaign.history.length > 0 || campaign.callbacks.length > 0;
}

function detachSocketFromCurrentSession(socket) {
  const previousCode = socket.data.code;
  const previousRole = socket.data.role;
  if (!previousCode || !previousRole) return;

  const previousSession = sessions.get(previousCode);
  if (!previousSession) {
    socket.data.code = null;
    socket.data.role = null;
    return;
  }

  if (previousRole === "dashboard" && previousSession.dashboardSocketId === socket.id) {
    previousSession.dashboardSocketId = null;
  }

  if (previousRole === "phone") {
    const removed = removePhoneWorker(previousSession, socket.id);
    if (previousSession.activePhoneSocketId === socket.id) {
      previousSession.activePhoneSocketId = null;
    }
    syncSessionPhoneState(previousSession);

    if (removed && previousSession.callState !== "idle" && !previousSession.phoneSocketId) {
      previousSession.callState = "idle";
    }
  }

  previousSession.updatedAt = Date.now();
  socket.leave(previousCode);

  if (!previousSession.dashboardSocketId && !getConnectedPhoneWorkers(previousSession).length && !hasPersistentCampaignData(previousSession)) {
    sessions.delete(previousCode);
  } else {
    emitState(previousCode);
    emitCampaignState(previousCode);
  }

  saveSoon();
  socket.data.code = null;
  socket.data.role = null;
}

function dispatchNextCampaignCallLegacy(code) {
  const session = sessions.get(code);
  if (!session) return null;

  const campaign = ensureCampaign(session);
  if (campaign.status !== "running" || campaign.activeContactId) {
    emitCampaignState(code);
    return null;
  }

  // Seleccionar worker para saber si vamos directo o por PBX
  const worker = getActivePhoneWorker(session);
  const next = assignNextContact(session, worker || {});
  session.updatedAt = Date.now();
  saveSoon();

  if (!next) {
    emitCampaignState(code);
    return null;
  }

  session.callState = "dialing";
  session.lastNumber = next.phone;
  session.lastContactName = next.name;
  session.lastCompanyName = next.name;
  
  if (worker) {
    console.log(`[CAMPAIGN] Marcado directo a ${next.phone} vía worker ${worker.name}`);
    io.to(worker.socketId).emit("call:action", {
      action: "dial",
      phoneNumber: next.phone,
      contactId: next.id,
      companyName: next.name,
      contactName: next.name,
      callId: getActiveAttemptId(session, worker.id),
      commandId: nanoid()
    });
    saveSoon();
    emitState(code);
    emitCampaignState(code);
  } else {
    console.log(`[CAMPAIGN] Omitido ${next.phone} (No hay worker)`);
    session.callState = "ended";
    markContactResult(session, next.id, "failed", { callbackReason: "Sin celular vinculado" });
    saveSoon();
    emitState(code);
    emitCampaignState(code);
  }

  emitState(code);
  emitCampaignState(code);
  return next;
}

function dispatchCampaignCalls(code, onlyWorkerId = "") {
  const session = sessions.get(code);
  if (!session) return [];
  const campaign = ensureCampaign(session);
  if (campaign.status !== "running") return [];

  const dispatched = [];
  const connectedWorkers = getConnectedPhoneWorkers(session);
  const connectedWorkerIds = new Set(connectedWorkers.map((worker) => String(worker.id)));
  for (const contact of campaign.contacts || []) {
    if (contact.targetWorkerId && !connectedWorkerIds.has(String(contact.targetWorkerId))
        && ["pending", "retry_pending"].includes(String(contact.status))) {
      contact.targetWorkerId = "";
    }
  }
  const workers = connectedWorkers.filter((worker) =>
    (!onlyWorkerId || worker.id === onlyWorkerId)
    &&
    !isWorkerPaused(session, worker.id)
    // Android may keep `ended` as its last reported state after hanging up.
    // That phone is available for a new outbound call.
    && ["idle", "ended", "failed", "available"].includes(String(worker.callState || "idle"))
    && !campaign.assignments?.[worker.id]
  );

  for (const worker of workers) {
    const next = assignNextContact(session, worker);
    if (!next) continue;
    worker.callState = "dialing";
    worker.activeContactId = next.id;
    worker.lastCompanyName = next.name;
    worker.lastNumber = next.phone;
    session.callState = "dialing";
    session.lastNumber = next.phone;
    session.lastContactName = next.name;
    session.lastCompanyName = next.name;
    io.to(worker.socketId).emit("call:action", {
      action: "dial",
      phoneNumber: next.phone,
      contactId: next.id,
      companyName: next.name,
      contactName: next.name,
      callId: getActiveAttemptId(session, worker.id),
      commandId: nanoid()
    });
    dispatched.push({ workerId: worker.id, contactId: next.id });
  }

  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);
  emitCampaignState(code);
  return dispatched;
}

function dispatchNextCampaignCall(code) {
  return dispatchCampaignCalls(code)[0] || null;
}

function getOrCreateSession(code) {
  if (!sessions.has(code)) {
    sessions.set(code, normalizeSessionShape());
    saveSoon();
  }

  const session = sessions.get(code);
  const normalized = normalizeSessionShape(session);
  ensureCampaign(normalized);
  sessions.set(code, normalized);
  return normalized;
}

function getPeer(session, role) {
  syncSessionPhoneState(session);
  if (role === "dashboard") return session.activePhoneSocketId || session.phoneSocketId;
  if (role === "phone") return session.dashboardSocketId;
  return null;
}

function emitState(code) {
  const session = sessions.get(code);
  if (!session) return;
  syncSessionPhoneState(session);
  const campaign = ensureCampaign(session);
  syncPendingContacts(session, campaign);
  const phoneWorkers = (session.phoneWorkers || []).map((worker) => {
    const assignment = campaign.assignments?.[worker.id] || null;
    const contact = assignment ? campaign.contacts.find((item) => item.id === assignment.contactId) : null;
    return {
      id: worker.id,
      name: worker.name,
      linkedAt: worker.linkedAt,
      connected: Boolean(worker.connected && worker.socketId),
      callState: worker.callState || "idle",
      paused: campaign.pausedWorkerIds.includes(String(worker.id)),
      active: Boolean(assignment),
      activeContactId: contact?.id || null,
      companyName: contact?.name || worker.lastCompanyName || "",
      phoneNumber: contact?.phone || worker.lastNumber || "",
      attempt: contact?.attempts || 0,
      answeredAt: contact?.answeredAt || null,
      durationSeconds: contact?.durationSeconds || 0,
      speakerOn: Boolean(worker.speakerOn),
      lastError: worker.lastError || "",
      lineLabel: worker.lineLabel || ""
    };
  });

  io.to(code).emit("state:changed", {
    connected: {
      dashboard: Boolean(session.dashboardSocketId),
      phone: Boolean(session.phoneSocketId),
      phoneCount: phoneWorkers.filter((worker) => worker.connected).length,
      linking: Boolean(session.phoneDevice) && !session.phoneSocketId
    },
    phoneDevice: session.phoneDevice,
    phoneWorkers,
    callState: session.callState,
    lastNumber: session.lastNumber,
    lastCompanyName: session.lastCompanyName,
    lastContactName: session.lastContactName,
    lastImageUrl: session.lastImageUrl,
    micMuted: session.micMuted,
    isSpeakerOn: session.isSpeakerOn,
    shiftManagement: getShiftSnapshot(session),
    updatedAt: session.updatedAt
  });
}



function parseEnvUrlCandidates(rawValue) {
  const raw = String(rawValue || "").trim().replace(/^=+/, "");
  if (!raw) return [];
  return raw
    .split(",")
    .map(s => s.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .filter((v) => /^https?:\/\//i.test(v));
}

function getRequestBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function getHostName(urlValue) {
  try {
    return new URL(urlValue).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isLocalNetworkHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return isLoopbackHost(normalized)
    || /^10\./.test(normalized)
    || /^192\.168\./.test(normalized)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized);
}

function isLikelyVirtualInterface(name) {
  const value = String(name || "").toLowerCase();
  return ["vethernet", "virtual", "vmware", "hyper-v", "loopback", "docker", "wsl"].some((part) => value.includes(part));
}

function rankLanAddress(address, interfaceName) {
  const ip = String(address || "").trim();
  const iface = String(interfaceName || "").trim().toLowerCase();

  let score = 0;
  if (/^192\.168\./.test(ip)) score += 50;
  else if (/^10\./.test(ip)) score += 40;
  else if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) score += 30;

  if (iface.includes("wi-fi") || iface.includes("wifi") || iface.includes("wlan")) score += 15;
  if (iface === "ethernet" || iface.includes("ethernet")) score += 12;
  if (isLikelyVirtualInterface(iface)) score -= 100;

  return score;
}

function getFirstLanAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== "IPv4") continue;
      candidates.push({
        name,
        address: entry.address,
        score: rankLanAddress(entry.address, name)
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || "";
}

function getLocalLanBaseUrl(req) {
  const envCandidates = parseEnvUrlCandidates(process.env.LOCAL_LAN_BASE_URL);
  if (envCandidates.length) return envCandidates[0];

  const reqBase = getRequestBaseUrl(req);
  const reqUrl = new URL(reqBase);
  if (!isLoopbackHost(reqUrl.hostname)) return reqBase;

  const lanAddress = getFirstLanAddress();
  if (!lanAddress) return "";
  const port = reqUrl.port ? `:${reqUrl.port}` : "";
  return `${reqUrl.protocol}//${lanAddress}${port}`;
}

function pickConfiguredBase(req, envName) {
  const reqBase = getRequestBaseUrl(req);
  const reqHost = String(req.get("host") || "").toLowerCase();
  const candidates = parseEnvUrlCandidates(process.env[envName]);
  if (!candidates.length) return "";

  const byHost = candidates.find((candidate) => {
    try {
      return new URL(candidate).host.toLowerCase() === reqHost;
    } catch {
      return false;
    }
  });

  return byHost || candidates[0] || "";
}

function getAndroidApiBaseUrl(req) {
  const reqBase = getRequestBaseUrl(req);
  if (isLocalNetworkHost(getHostName(reqBase))) {
    return getLocalLanBaseUrl(req) || reqBase;
  }

  const publicBase = pickConfiguredBase(req, "PUBLIC_BASE_URL");
  if (publicBase) return publicBase;

  const localLanBase = getLocalLanBaseUrl(req);
  if (localLanBase) return localLanBase;

  if (reqBase) return reqBase;

  return "https://lm.viacomunicativa.com";
}

function getWebBaseUrl(req) {
  const reqBase = getRequestBaseUrl(req);
  if (isLocalNetworkHost(getHostName(reqBase))) {
    return getLocalLanBaseUrl(req) || reqBase;
  }

  const publicWebBase = pickConfiguredBase(req, "PUBLIC_WEB_BASE_URL");
  if (publicWebBase) return publicWebBase;

  if (reqBase) return reqBase;

  return "https://llamada.viacomunicativa.com";
}

function getPairingLink(req, code, token) {
  const webBase = getWebBaseUrl(req);
  const apiBase = getAndroidApiBaseUrl(req);
  return `${webBase}/pairing?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}&apiBase=${encodeURIComponent(apiBase)}`;
}

io.on("connection", (socket) => {
  socket.on("session:create", ({ dashboardClientId } = {}) => {
    detachSocketFromCurrentSession(socket);
    let code;
    do code = nanoid(6).toUpperCase(); while (sessions.has(code));
    const session = getOrCreateSession(code);
    session.updatedAt = Date.now();

    // Auto-join as dashboard so state:changed fires without a manual join click
    socket.data.code = code;
    socket.data.role = "dashboard";
    socket.data.dashboardClientId = String(dashboardClientId || "").trim();
    socket.join(code);
    session.dashboardSocketId = socket.id;
    session.dashboardClientId = socket.data.dashboardClientId;

    socket.emit("session:created", { code, dashboardToken: session.dashboardToken });
    emitState(code);
    emitCampaignState(code);
  });


  socket.on("session:join", ({ code, role, token, deviceName, deviceId, dashboardClientId }) => {
    if (!code || !role) return;

    const normalizedCode = String(code).toUpperCase().trim();
    if (!/^[A-Z0-9_-]{6}$/.test(normalizedCode) || !["dashboard", "phone"].includes(role)) {
      socket.emit("session:error", { message: "Codigo o rol de sesion invalido." });
      return;
    }
    const session = sessions.has(normalizedCode) ? getOrCreateSession(normalizedCode) : null;
    if (!session) {
      socket.emit("session:error", { message: "Sesión no encontrada. Crea una sesión nueva." });
      return;
    }
    const normalizedToken = token ? String(token).trim() : "";

    const pairingSlot = role === "phone" ? getPairingSlotByToken(session, normalizedToken) : null;
    if (role === "phone" && !pairingSlot && normalizedToken !== session.pairingToken) {
      socket.emit("session:error", { message: "Token de vinculacion invalido." });
      return;
    }
    if (role === "phone" && pairingSlot?.deviceId && pairingSlot.deviceId !== String(deviceId || "")) {
      socket.emit("session:error", { message: "Este QR ya esta vinculado a otro telefono." });
      return;
    }
    if (role === "dashboard" && normalizedToken !== session.dashboardToken) {
      socket.emit("session:error", { message: "Token privado del dashboard inválido o ausente." });
      return;
    }

    if (role === "dashboard") {
      const requestedClientId = String(dashboardClientId || "").trim();
      const activeDashboard = session.dashboardSocketId
        ? io.sockets.sockets.get(session.dashboardSocketId)
        : null;
      const activeClientId = String(session.dashboardClientId || activeDashboard?.data?.dashboardClientId || "").trim();
      if (activeDashboard?.connected && activeDashboard.id !== socket.id
        && (!requestedClientId || !activeClientId || requestedClientId !== activeClientId)) {
        socket.emit("session:error", {
          reason: "dashboard_in_use",
          message: "Esta sesión ya está abierta por otro operador. Se creará una sesión independiente."
        });
        return;
      }
    }

    detachSocketFromCurrentSession(socket);

    socket.data.code = normalizedCode;
    socket.data.role = role;
    socket.join(normalizedCode);

    if (role === "dashboard") {
      session.dashboardSocketId = socket.id;
      session.dashboardClientId = String(dashboardClientId || "").trim();
      socket.data.dashboardClientId = session.dashboardClientId;
    }
    if (role === "phone") {
      const worker = upsertPhoneWorker(session, {
        socketId: socket.id,
        deviceId: deviceId || "web-phone",
        deviceName: deviceName || "Android bridge"
      });
      if (pairingSlot) {
        bindDeviceToPairingSlot(session, pairingSlot, {
          deviceId: deviceId || worker.id,
          deviceName: deviceName || worker.name
        });
        worker.pairingSlotId = pairingSlot.id;
        socket.data.pairingSlotId = pairingSlot.id;
      }
      session.activePhoneSocketId ||= worker.socketId;
      syncSessionPhoneState(session);
      saveSoon();
    }

    session.updatedAt = Date.now();
    socket.emit("session:joined", { code: normalizedCode, role });
    emitState(normalizedCode);
    emitCampaignState(normalizedCode);

    // If a phone joined and a campaign is running but idle, kickstart it
    if (role === "phone") {
        const campaign = ensureCampaign(session);
        if (campaign.status === "running") {
            setTimeout(() => dispatchCampaignCalls(normalizedCode), 1000);
        }
    }
  });

  socket.on("call:action", ({ action, phoneNumber, companyName, contactName, imageUrl, commandId, contactId, workerId }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "dashboard") return;

    const session = sessions.get(code);
    if (!session) return;

  if (action === "dial") {
      session.lastNumber = phoneNumber || "";
      session.lastCompanyName = companyName || "";
      session.lastContactName = contactName || "";
      session.lastImageUrl = imageUrl || "";

      const worker = workerId
        ? getConnectedPhoneWorkers(session).find((item) => item.id === workerId)
        : getActivePhoneWorker(session);
      if (contactId) {
        const campaign = ensureCampaign(session);
        campaign.activeContactId = contactId;
        if (worker) campaign.activeWorkerSocketId = worker.socketId;
      }
      session.updatedAt = Date.now();
      saveSoon();
      
      if (worker) {
        console.log(`[MANUAL] Marcado directo a ${phoneNumber} vía worker ${worker.name}`);
        io.to(worker.socketId).emit("call:action", {
          action: "dial",
          phoneNumber: phoneNumber || "",
          companyName: companyName || "",
          contactName: contactName || "",
          imageUrl: imageUrl || "",
          contactId: contactId || "",
          callId: getActiveAttemptId(session, worker.id),
          commandId: commandId || nanoid()
        });
        saveSoon();
        emitState(code);
      } else {
        console.log(`[MANUAL] Intento fallido para ${phoneNumber} (No hay worker activo)`);
        session.callState = "failed";
        saveSoon();
        emitState(code);
      }
    }

    if (action === "hangup") {
      const worker = workerId
        ? getConnectedPhoneWorkers(session).find((item) => item.id === workerId)
        : getActivePhoneWorker(session);
      if (worker) {
        io.to(worker.socketId).emit("call:action", { 
          action: "hangup", 
          from: "dashboard", 
          contactId 
        });
      }
      session.callState = "ended";
      saveSoon();
    }

    if (action === "mute" || action === "unmute" || action === "speaker_on" || action === "speaker_off" || action === "answer") {
      const worker = workerId
        ? getConnectedPhoneWorkers(session).find((item) => item.id === workerId)
        : getActivePhoneWorker(session);
      if (worker) {
        io.to(worker.socketId).emit("call:action", { 
          action, 
          commandId,
          contactId 
        });
      }
    }

    session.updatedAt = Date.now();
    emitState(code);
    emitCampaignState(code);
  });

  socket.on("phone:status", ({ callState, phoneNumber, contactName, companyName, contactId, callId, micMuted, speakerOn, lineLabel, lastError, externalIncoming, terminalConfirmed }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    const worker = getPhoneWorkerBySocketId(session, socket.id);
    const isExternalIncoming = Boolean(externalIncoming);
    if (worker) {
      worker.callState = callState || worker.callState || "idle";
      worker.speakerOn = Boolean(speakerOn);
      worker.connected = true;
      if (lineLabel) worker.lineLabel = String(lineLabel).trim();
      if (lastError) worker.lastError = String(lastError).trim();
      session.activePhoneSocketId = socket.id;
      worker.externalIncoming = isExternalIncoming;
    }
    session.callState = callState || session.callState;
    if (typeof phoneNumber === "string" && phoneNumber.trim()) {
      session.lastNumber = phoneNumber.trim();
    }
    if (typeof contactName === "string" && contactName.trim()) {
      session.lastContactName = contactName.trim();
    }
    if (typeof companyName === "string" && companyName.trim()) {
      session.lastCompanyName = companyName.trim();
    }
    session.micMuted = Boolean(micMuted);
    session.isSpeakerOn = Boolean(speakerOn);
    session.updatedAt = Date.now();
    let updatedContact = null;
    if (isExternalIncoming && worker) {
      if (["ringing", "dialing", "in_call"].includes(String(callState || ""))) {
        holdActiveContact(session, worker.id);
      } else if (["idle", "ended", "failed"].includes(String(callState || ""))) {
        resumeHeldContact(session, worker.id);
      }
    } else {
      const reconciledState = terminalConfirmed && callState === "idle" ? "ended" : callState;
      updatedContact = updateActiveCallState(session, reconciledState, worker || {}, { lastError, contactId, callId });
    }
    if (worker && updatedContact) {
      worker.activeContactId = ["dialing", "ringing", "in_call"].includes(updatedContact.status) ? updatedContact.id : null;
      worker.lastCompanyName = updatedContact.name || worker.lastCompanyName || "";
      worker.lastNumber = updatedContact.phone || worker.lastNumber || "";
    }
    syncSessionPhoneState(session);
    saveSoon();
    emitState(code);
    emitCampaignState(code);

    const campaign = ensureCampaign(session);
    if (["ended", "failed"].includes(String(callState || "")) && campaign.status === "running") {
      setTimeout(() => dispatchCampaignCalls(code, worker?.id || ""), 1200);
    }
  });

  socket.on("phone:command_ack", ({ commandId, action, ok, message }) => {
    const code = socket.data.code;
    const role = socket.data.role;
    if (!code || role !== "phone") return;

    const session = sessions.get(code);
    if (!session) return;

    const peerId = getPeer(session, "phone");
    if (!peerId) return;

    io.to(peerId).emit("phone:command_ack", {
      commandId: commandId || "",
      action: action || "",
      ok: Boolean(ok),
      message: message || "",
      at: new Date().toISOString()
    });
  });

  // ── Audio relay (binary PCM frames, 16kHz mono PCM16) ───────────────────
  // Phone mic → dashboard speaker
  socket.on("audio:phone", (data) => {
    const { code, role } = socket.data;
    if (!code || role !== "phone") return;
    const session = sessions.get(code);
    if (!session) return;
    session.activePhoneSocketId = socket.id;
    const worker = getPhoneWorkerBySocketId(session, socket.id);
    syncSessionPhoneState(session);
    const liveWorkers = getConnectedPhoneWorkers(session).filter((item) => ["dialing", "ringing", "in_call"].includes(String(item.callState || "")));
    if (!worker || liveWorkers.length !== 1 || liveWorkers[0].id !== worker.id) return;
    const peerId = getPeer(session, "phone");  // gets dashboardSocketId
    if (peerId) io.to(peerId).emit("audio:phone", data);
  });

  // Dashboard mic → phone speaker
  socket.on("audio:dashboard", (data) => {
    const { code, role } = socket.data;
    if (!code || role !== "dashboard") return;
    const session = sessions.get(code);
    if (!session) return;
    const liveWorkers = getConnectedPhoneWorkers(session).filter((item) => ["dialing", "ringing", "in_call"].includes(String(item.callState || "")));
    if (liveWorkers.length === 1) io.to(liveWorkers[0].socketId).emit("audio:dashboard", data);
  });

  socket.on("session:logout", (acknowledge) => {
    const { code, role } = socket.data;
    if (!code || role !== "phone") return;
    const session = sessions.get(code);
    if (!session) return;
    const worker = (session.phoneWorkers || []).find((item) => item.socketId === socket.id);
    clearDeviceFromPairingSlots(session, worker?.id);
    socket.data.explicitLogout = true;
    session.updatedAt = Date.now();
    saveSoon();
    emitState(code);
    emitCampaignState(code);
    if (typeof acknowledge === "function") acknowledge({ ok: true });
  });


  socket.on("disconnect", () => {
    const { code, role } = socket.data;
    if (!code || !role) return;

    const session = sessions.get(code);
    if (!session) return;

    if (role === "dashboard" && session.dashboardSocketId === socket.id) session.dashboardSocketId = null;
    if (role === "phone") {
      const removed = removePhoneWorker(session, socket.id);
      if (session.activePhoneSocketId === socket.id) {
        session.activePhoneSocketId = null;
      }
      
      // If the disconnecting worker was in a call, cleanup campaign
      if (removed) {
          updateActiveCallState(session, "ended", removed);
      }

      syncSessionPhoneState(session);
      // Let the dashboard keep the call window open during micro-cuts.
      // The user can manually click 'Cortar' if the phone never reconnects.
      /*
      if (removed && session.callState !== "idle" && !session.phoneSocketId) {
        session.callState = "idle";
        const dash = session.dashboardSocketId;
        if (dash) io.to(dash).emit("state:changed", { ...session, connected: { dashboard: true, phone: false, phoneCount: 0 } });
      }
      */
    }

    session.updatedAt = Date.now();

    if (!session.dashboardSocketId && !getConnectedPhoneWorkers(session).length && !hasPersistentCampaignData(session)) {
      sessions.delete(code);
      saveSoon();
      return;
    }

    emitState(code);
    emitCampaignState(code);
  });
});

function hasDashboardAccess(req, session) {
  const token = String(req.headers["x-dashboard-token"] || req.query.dashboardToken || "").trim();
  return Boolean(session?.dashboardToken && token === session.dashboardToken);
}

function requireDashboardAccess(req, res, next) {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  if (!hasDashboardAccess(req, session)) return res.status(401).json({ ok: false, error: "Acceso del dashboard no autorizado" });
  req.dashboardSession = session;
  next();
}

app.get("/api/pairing/:code", pairingRateLimit, (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = sessions.has(code) ? getOrCreateSession(code) : null;
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  if (!hasDashboardAccess(req, session)) return res.status(401).json({ ok: false, error: "Acceso del dashboard no autorizado" });
  const pairingSlots = (session.pairingSlots || []).map((slot) => ({
    id: slot.id,
    label: slot.label,
    link: getPairingLink(req, code, slot.token),
    deviceId: slot.deviceId || "",
    deviceName: slot.deviceName || "",
    linkedAt: slot.linkedAt || null,
    connected: Boolean((session.phoneWorkers || []).some((worker) => worker.pairingSlotId === slot.id && worker.connected && worker.socketId))
  }));
  const link = pairingSlots[0]?.link || getPairingLink(req, code, session.pairingToken);

  return res.json({
    ok: true,
    code,
    token: session.pairingToken,
    link,
    pairingSlots,
    phoneDevice: session.phoneDevice,
    workers: (session.phoneWorkers || []).map((worker) => ({
      id: worker.id,
      name: worker.name,
      linkedAt: worker.linkedAt,
      connected: Boolean(worker.connected && worker.socketId),
      callState: worker.callState || "idle",
      active: worker.socketId === session.activePhoneSocketId
    }))
  });
});

app.use("/api/session/:code", requireDashboardAccess);

app.post("/api/session/:code/pairing-slots", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = sessions.has(code) ? getOrCreateSession(code) : null;
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  if ((session.pairingSlots || []).length >= 20) {
    return res.status(409).json({ ok: false, error: "Se permiten hasta 20 codigos QR por sesion" });
  }
  const slot = createPairingSlot(session.pairingSlots.length);
  session.pairingSlots.push(slot);
  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);
  return res.json({ ok: true, code, slotId: slot.id });
});

app.delete("/api/session/:code/pairing-slots/:slotId", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const slotId = String(req.params.slotId || "").trim();
  const session = sessions.has(code) ? getOrCreateSession(code) : null;
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const index = (session.pairingSlots || []).findIndex((slot) => slot.id === slotId);
  if (index < 0) return res.status(404).json({ ok: false, error: "Codigo QR no encontrado" });
  if (session.pairingSlots[index].deviceId) {
    return res.status(409).json({ ok: false, error: "Este QR tiene un telefono vinculado. Cierra primero la sesion de ese telefono." });
  }

  session.pairingSlots.splice(index, 1);
  session.pairingSlots.forEach((slot, slotIndex) => { slot.label = `EQUIPO ${slotIndex + 1}`; });
  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);
  return res.json({ ok: true, code, slotId });
});

app.get("/api/session/:code/workers", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  syncSessionPhoneState(session);

  return res.json({
    ok: true,
    code,
    activePhoneSocketId: session.activePhoneSocketId,
    workers: (session.phoneWorkers || []).map((worker) => ({
      id: worker.id,
      name: worker.name,
      linkedAt: worker.linkedAt,
      connected: Boolean(worker.connected && worker.socketId),
      callState: worker.callState || "idle",
      active: worker.socketId === session.activePhoneSocketId
    }))
  });
});

app.get("/api/session/:code/campaign", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  return res.json({
    ok: true,
    code,
    campaign: { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) }
  });
});

app.get("/api/session/:code/turn", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  syncPendingContacts(session, ensureCampaign(session));
  return res.json({ ok: true, code, turn: getShiftSnapshot(session) });
});

app.get("/api/session/:code/turns/:turnId/report", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const turnId = String(req.params.turnId || "").trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const management = ensureShiftManagement(session);
  const turn = management.history.find((item) => item.id === turnId);
  if (!turn) return res.status(404).json({ ok: false, error: "Turno no encontrado" });
  return res.json({ ok: true, code, turn });
});

app.post("/api/session/:code/turn/finalize", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const campaign = ensureCampaign(session);
  const finalizedTurn = finalizeCurrentTurn(session, campaign);
  if (!finalizedTurn) return res.status(409).json({ ok: false, error: "No hay un turno activo para finalizar" });
  disconnectAllSessionPhones(session, "turn_finished");
  resetCampaignForShift(session);
  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);
  emitCampaignState(code);
  return res.json({
    ok: true,
    code,
    finalizedTurn,
    campaign: { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) }
  });
});

app.post("/api/session/:code/session/finalize", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const campaign = ensureCampaign(session);
  const finalizedSession = finalizeCurrentSession(session);
  resetCampaignOperation(session);
  disconnectAllSessionPhones(session, "session_restarted");
  session.pairingSlots = Array.from({ length: 3 }, (_, index) => createPairingSlot(index));
  session.pairingToken = nanoid(20);
  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);
  emitCampaignState(code);
  return res.json({
    ok: true,
    code,
    finalizedSession,
    campaign: { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) }
  });
});



app.post("/api/session/:code/campaign/start", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  if (!contacts.length) return res.status(400).json({ ok: false, error: "contacts requeridos" });

  const session = sessions.get(code);
  if (!session) return res.status(404).send("Sesion no encontrada");
  const currentCampaign = ensureCampaign(session);
  if (currentCampaign.status === "running" || Object.keys(currentCampaign.assignments || {}).length) {
    return res.status(409).json({ ok: false, error: "Ya hay una campana en curso. Pausala o detenla antes de iniciar otra." });
  }
  if (contacts.length > 10000) {
    return res.status(413).json({ ok: false, error: "La campana admite hasta 10000 contactos." });
  }
  syncPendingContacts(session, currentCampaign);
  startCampaign(session, contacts, {
    listName: req.body?.listName,
    maxAttempts: Math.min(5, Math.max(1, Number(req.body?.maxAttempts || 2)))
  });
  if (String(req.body?.listName || "").trim() === "Pendientes del turno") {
    markPendingCampaignStarted(session, contacts);
  }
  session.updatedAt = Date.now();
  saveSoon();
  emitCampaignState(code);
  const dispatched = dispatchCampaignCalls(code);

  return res.json({
    ok: true,
    code,
    dispatched: dispatched.length,
    campaign: { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) }
  });
});

app.post("/api/session/:code/campaign/pause", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  pauseCampaign(session);
  saveSoon();
  emitCampaignState(code);
  return res.json({ ok: true, code, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/resume", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  resumeCampaign(session);
  saveSoon();
  emitCampaignState(code);
  const dispatched = dispatchCampaignCalls(code);
  return res.json({ ok: true, code, dispatched: dispatched.length, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/dispatch", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const dispatched = dispatchCampaignCalls(code);
  saveSoon();
  emitCampaignState(code);
  return res.json({ ok: true, code, dispatched: dispatched.length, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/stop", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  pauseCampaign(session);
  const activeAssignments = Object.values(ensureCampaign(session).assignments || {});
  for (const assignment of activeAssignments) skipActiveContact(session, assignment.workerId);
  ensureCampaign(session).status = "completed";
  ensureCampaign(session).completedAt = new Date().toISOString();
  for (const assignment of activeAssignments) {
    if (assignment.workerSocketId) {
      io.to(assignment.workerSocketId).emit("call:action", {
        action: "hangup",
        from: "dashboard",
        contactId: assignment.contactId,
        commandId: nanoid()
      });
    }
  }
  saveSoon();
  emitCampaignState(code);
  emitState(code);
  return res.json({ ok: true, code, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/workers/:workerId/pause", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no encontrado" });
  const paused = Boolean(req.body?.paused);
  setWorkerPaused(session, workerId, paused);
  saveSoon();
  emitCampaignState(code);
  emitState(code);
  if (!paused) dispatchCampaignCalls(code);
  return res.json({ ok: true, code, workerId, paused, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/workers/:workerId/hangup", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no conectado" });
  const contact = getContactByWorker(session, workerId);
  io.to(worker.socketId).emit("call:action", {
    action: "hangup",
    from: "dashboard",
    contactId: contact?.id || "",
    commandId: nanoid()
  });
  return res.json({ ok: true, code, workerId, contactId: contact?.id || null });
});

app.post("/api/session/:code/workers/:workerId/start-independent", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no conectado" });
  const campaign = ensureCampaign(session);
  campaign.status = "running";
  setWorkerPaused(session, workerId, false);
  resumeHeldContact(session, workerId);
  const dispatched = dispatchCampaignCalls(code, workerId);
  return res.json({ ok: true, code, workerId, dispatched: dispatched.length, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/workers/:workerId/switch-list", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const currentList = String(req.body?.currentList || "").trim();
  const nextList = String(req.body?.nextList || "").trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no conectado" });

  const switched = switchWorkerList(session, workerId, currentList, nextList);
  if (!switched.ok) return res.status(409).json(switched);
  if (switched.activeContact) {
    io.to(worker.socketId).emit("call:action", {
      action: "hangup",
      from: "dashboard",
      contactId: switched.activeContact.id,
      commandId: nanoid()
    });
  }
  worker.callState = "idle";
  worker.activeContactId = null;
  worker.lastCompanyName = "";
  worker.lastNumber = "";
  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);
  emitCampaignState(code);
  if (ensureCampaign(session).status === "running") {
    setTimeout(() => dispatchCampaignCalls(code, workerId), 1500);
  }
  return res.json({ ok: true, code, workerId, currentList, nextList, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/workers/:workerId/call-contact", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const contactId = String(req.body?.contactId || req.body?.contact?.id || "").trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "El equipo asignado no esta conectado" });
  const campaign = ensureCampaign(session);
  const requested = ensureCampaignContact(session, { ...(req.body?.contact || {}), id: contactId, targetWorkerId: workerId });
  if (!requested) return res.status(400).json({ ok: false, error: "El contacto o su numero no son validos" });
  if (requested.targetWorkerId && requested.targetWorkerId !== workerId) {
    return res.status(409).json({ ok: false, error: "El contacto pertenece a otro equipo" });
  }

  const held = holdActiveContact(session, workerId);
  if (held) {
    io.to(worker.socketId).emit("call:action", { action: "hangup", from: "dashboard", contactId: held.id, commandId: nanoid() });
  }
  setWorkerPaused(session, workerId, false);
  const contact = assignSpecificContact(session, worker, contactId);
  if (!contact) return res.status(409).json({ ok: false, error: "No se pudo asignar el contacto al equipo" });

  worker.callState = "dialing";
  worker.activeContactId = contact.id;
  worker.lastCompanyName = contact.name;
  worker.lastNumber = contact.phone;
  io.to(worker.socketId).emit("call:action", {
    action: "dial",
    phoneNumber: contact.phone,
    contactId: contact.id,
    companyName: contact.name,
    contactName: contact.name,
    callId: getActiveAttemptId(session, worker.id),
    commandId: nanoid()
  });
  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);
  emitCampaignState(code);
  return res.json({ ok: true, code, workerId, contactId: contact.id, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/workers/:workerId/stop-independent", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no conectado" });
  const held = holdActiveContact(session, workerId);
  setWorkerPaused(session, workerId, true);
  io.to(worker.socketId).emit("call:action", { action: "hangup", from: "dashboard", contactId: held?.id || "", commandId: nanoid() });
  worker.callState = "idle";
  worker.lastNumber = held?.phone || worker.lastNumber || "";
  worker.lastCompanyName = held?.name || worker.lastCompanyName || "";
  saveSoon();
  emitCampaignState(code);
  emitState(code);
  return res.json({ ok: true, code, workerId, heldContact: held ? { id: held.id, name: held.name, phone: held.phone } : null, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/workers/:workerId/disconnect", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId) || null;
  const pairingSlot = (session.pairingSlots || []).find((slot) => slot.id === worker?.pairingSlotId || slot.deviceId === workerId);
  if (!worker && !pairingSlot) return res.status(404).json({ ok: false, error: "Telefono o vinculacion no encontrados" });

  const phoneSocket = worker?.socketId ? io.sockets.sockets.get(worker.socketId) : null;
  const heldContact = worker ? holdActiveContact(session, workerId) : null;
  clearDeviceFromPairingSlots(session, workerId);
  if (worker?.socketId && ["dialing", "ringing", "in_call"].includes(String(worker.callState || ""))) {
    io.to(worker.socketId).emit("call:action", { action: "hangup", from: "dashboard", commandId: nanoid() });
  }
  if (worker?.socketId) io.to(worker.socketId).emit("session:force_logout", { reason: "dashboard_request" });

  // Remove it from the authoritative dashboard state immediately. The later
  // Socket.IO disconnect is only transport cleanup and must not keep the QR
  // or its list assignment occupied.
  if (worker) session.phoneWorkers = (session.phoneWorkers || []).filter((item) => item.id !== workerId);
  syncSessionPhoneState(session);

  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);
  emitCampaignState(code);

  setTimeout(() => {
    if (phoneSocket?.connected) phoneSocket.disconnect(true);
  }, 2200);

  return res.json({ ok: true, code, workerId, heldContact: heldContact ? { id: heldContact.id, name: heldContact.name, phone: heldContact.phone } : null, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/skip", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const requestedWorkerId = String(req.body?.workerId || "").trim();
  const campaignBeforeSkip = ensureCampaign(session);
  const assignmentBeforeSkip = requestedWorkerId
    ? campaignBeforeSkip.assignments?.[requestedWorkerId]
    : Object.values(campaignBeforeSkip.assignments || {})[0];
  const skipped = skipActiveContact(session, requestedWorkerId);
  if (assignmentBeforeSkip?.workerSocketId) {
    io.to(assignmentBeforeSkip.workerSocketId).emit("call:action", {
      action: "hangup",
      from: "dashboard",
      contactId: assignmentBeforeSkip.contactId,
      commandId: nanoid()
    });
  }
  saveSoon();
  emitCampaignState(code);
  if (ensureCampaign(session).status === "running") dispatchCampaignCalls(code);
  return res.json({ ok: true, code, skipped, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/result", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const contactId = String(req.body?.contactId || "").trim();
  const result = String(req.body?.result || "").trim();
  if (!code || !contactId || !result) {
    return res.status(400).json({ ok: false, error: "code, contactId y result son requeridos" });
  }
  const allowedResults = new Set(["contesto", "interesado", "no_interesado", "requiere_asesor", "sin_respuesta", "no_contactado", "numero_incorrecto", "reintentar", "agendado"]);
  if (!allowedResults.has(result)) {
    return res.status(400).json({ ok: false, error: "Resultado de llamada invalido" });
  }

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const campaignBeforeResult = ensureCampaign(session);
  const assignmentBeforeResult = Object.values(campaignBeforeResult.assignments || {})
    .find((assignment) => assignment.contactId === contactId);
  const hangupWorkerSocketId = assignmentBeforeResult?.workerSocketId || null;
  const updated = markContactResult(session, contactId, result, {
    callbackReason: req.body?.callbackReason,
    assignedAdvisor: req.body?.assignedAdvisor,
    transcriptSummary: req.body?.transcriptSummary
  });
  if (!updated) return res.status(404).json({ ok: false, error: "Contacto no encontrado" });

  if (hangupWorkerSocketId && ["agendado", "interesado", "no_interesado", "requiere_asesor", "sin_respuesta", "numero_incorrecto"].includes(updated.result)) {
    io.to(hangupWorkerSocketId).emit("call:action", { action: "hangup", from: "dashboard", contactId });
  }

  saveSoon();
  emitCampaignState(code);
  if (ensureCampaign(session).status === "running") {
    dispatchCampaignCalls(code);
  }
  return res.json({ ok: true, code, contact: updated, campaign: getCampaignSnapshot(session) });
});

app.post("/api/session/:code/campaign/callback", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const contactId = String(req.body?.contactId || "").trim();
  if (!code || !contactId) {
    return res.status(400).json({ ok: false, error: "code y contactId son requeridos" });
  }

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const contact = markContactResult(session, contactId, "requiere_asesor", {
    callbackReason: req.body?.callbackReason,
    assignedAdvisor: req.body?.assignedAdvisor,
    transcriptSummary: req.body?.transcriptSummary
  });
  if (!contact) return res.status(404).json({ ok: false, error: "Contacto no encontrado" });

  saveSoon();
  emitCampaignState(code);
  if (ensureCampaign(session).status === "running") {
    dispatchCampaignCalls(code);
  }
  return res.json({ ok: true, code, contact, campaign: getCampaignSnapshot(session) });
});

app.get("/api/pairing-qr/:code.svg", pairingRateLimit, async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).send("Code requerido");

  const session = sessions.get(code);
  if (!session) return res.status(404).send("Sesion no encontrada");
  if (!hasDashboardAccess(req, session)) return res.status(401).send("Acceso no autorizado");
  const requestedSlotId = String(req.query.slot || "").trim();
  const slot = requestedSlotId
    ? (session.pairingSlots || []).find((item) => item.id === requestedSlotId)
    : (session.pairingSlots || [])[0];
  if (requestedSlotId && !slot) return res.status(404).send("Codigo QR no encontrado");
  const link = getPairingLink(req, code, slot?.token || session.pairingToken);

  try {
    const svg = await QRCode.toString(link, {
      type: "svg",
      errorCorrectionLevel: "L",
      margin: 1,
      width: 320
    });

    res.setHeader("Content-Type", "image/svg+xml");
    return res.send(svg);
  } catch {
    return res.status(500).send("No se pudo generar QR");
  }
});

app.get("/api/server-info", (req, res) => {
  const requestBase = getRequestBaseUrl(req);
  const androidApiBase = getAndroidApiBaseUrl(req);
  const webBase = getWebBaseUrl(req);
  const requestHost = getHostName(requestBase);
  const usingPublicBase = Boolean(pickConfiguredBase(req, "PUBLIC_BASE_URL"));
  const usingPublicWebBase = Boolean(pickConfiguredBase(req, "PUBLIC_WEB_BASE_URL"));
  const usingLocalLanBase = Boolean(parseEnvUrlCandidates(process.env.LOCAL_LAN_BASE_URL).length);

  return res.json({
    ok: true,
    requestBase,
    androidApiBase,
    webBase,
    isLocalhostRequest: isLoopbackHost(requestHost),
    usingPublicBase,
    usingPublicWebBase,
    usingLocalLanBase
  });
});





app.post("/api/android/pair", pairingRateLimit, (req, res) => {
  const code = String(req.body?.code || "").toUpperCase().trim();
  const token = String(req.body?.token || "").trim();
  const deviceId = String(req.body?.deviceId || "").trim();
  const deviceName = String(req.body?.deviceName || "").trim() || "Android bridge";

  if (!code || !token || !deviceId) {
    return res.status(400).json({ ok: false, error: "code, token y deviceId son requeridos" });
  }

  const session = sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  let pairingSlot = getPairingSlotByToken(session, token);
  if (!pairingSlot && session.pairingToken !== token) return res.status(401).json({ ok: false, error: "Token invalido" });
  if (!pairingSlot && session.pairingToken === token) {
    pairingSlot = (session.pairingSlots || []).find((slot) => !slot.deviceId) || null;
  }
  if (pairingSlot?.deviceId && pairingSlot.deviceId !== deviceId) {
    return res.status(409).json({ ok: false, error: "Este QR ya fue utilizado por otro telefono" });
  }

  const worker = upsertPhoneWorker(session, {
    socketId: null,
    deviceId,
    deviceName
  });
  if (pairingSlot) {
    bindDeviceToPairingSlot(session, pairingSlot, { deviceId, deviceName });
    worker.pairingSlotId = pairingSlot.id;
  }
  syncSessionPhoneState(session);
  session.updatedAt = Date.now();
  saveSoon();
  emitState(code);

  const baseUrl = getAndroidApiBaseUrl(req);
  return res.json({
    ok: true,
    code,
    workers: (session.phoneWorkers || []).map((worker) => ({
      id: worker.id,
      name: worker.name,
      linkedAt: worker.linkedAt,
      connected: Boolean(worker.connected && worker.socketId)
    })),
    socket: {
      url: baseUrl,
      role: "phone",
      token
    }
  });
});

// ── APK download ────────────────────────────────────────────────────────
const APK_PATHS = [
  path.join(__dirname, "../android-app/app/build/outputs/apk/release/Phone-VC-release.apk"),
  path.join(__dirname, "../android-app/app/build/outputs/apk/debug/Phone-VC-debug.apk"),
  path.join(__dirname, "../android-app/app/build/intermediates/apk/debug/app-debug.apk")
];

const APK_SEARCH_DIRS = [
  path.join(__dirname, "../android-app/app/build/outputs/apk"),
  path.join(__dirname, "../android-app/releases")
];

function walkDirForApk(dir, out) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDirForApk(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".apk")) {
      out.push(full);
    }
  }
}

function parseApkVersion(fileName) {
  const base = fileName.replace(/\.apk$/i, "");
  const semver = base.match(/(\d+\.\d+\.\d+(?:[-+._]?[a-zA-Z0-9]+)*)/);
  if (semver) return semver[1].replace(/_/g, ".");

  const vTag = base.match(/(?:^|[-_])v(\d+(?:[._]\d+)*)/i);
  if (vTag) return `v${vTag[1].replace(/_/g, ".")}`;

  if (/release/i.test(base)) return "release";
  if (/debug/i.test(base)) return "debug";
  return "custom";
}

function getAvailableApks() {
  const found = [];
  for (const dir of APK_SEARCH_DIRS) {
    walkDirForApk(dir, found);
  }
  for (const p of APK_PATHS) {
    if (fs.existsSync(p)) found.push(p);
  }

  const unique = [...new Set(found.map(p => path.resolve(p)))];
  const versions = unique
    .filter(p => fs.existsSync(p))
    .map((p) => {
      const stat = fs.statSync(p);
      const file = path.basename(p);
      const version = parseApkVersion(file);
      const type = /release/i.test(file) ? "release" : (/debug/i.test(file) ? "debug" : "custom");
      return {
        id: Buffer.from(p).toString("base64url"),
        name: file,
        version,
        type,
        size: stat.size,
        sizeKb: Math.round(stat.size / 1024),
        modified: stat.mtime,
        fullPath: p
      };
    })
    .sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

  return versions;
}

function getApkById(id) {
  if (!id) return null;
  const versions = getAvailableApks();
  return versions.find(v => v.id === id) || null;
}

app.get("/api/apk/versions", (_, res) => {
  const versions = getAvailableApks();
  if (!versions.length) {
    return res.json({ ok: false, versions: [], error: "APK no encontrada. Compila el proyecto Android primero." });
  }
  return res.json({
    ok: true,
    latestId: versions[0].id,
    versions: versions.map(v => ({
      id: v.id,
      name: v.name,
      version: v.version,
      type: v.type,
      size: v.size,
      sizeKb: v.sizeKb,
      modified: v.modified
    }))
  });
});

app.get("/api/apk/info", (_, res) => {
  const versions = getAvailableApks();
  if (!versions.length) {
    return res.json({ ok: false, error: "APK no encontrada. Compila el proyecto Android primero." });
  }
  const top = versions[0];
  return res.json({
    ok: true,
    id: top.id,
    name: top.name,
    version: top.version,
    size: top.size,
    sizeKb: top.sizeKb,
    type: top.type,
    modified: top.modified
  });
});

app.get("/api/apk/download", (_, res) => {
  const versions = getAvailableApks();
  if (!versions.length) {
    return res.status(404).json({ ok: false, error: "APK no encontrada." });
  }
  const latest = versions[0];
  res.setHeader("Content-Disposition", `attachment; filename="${latest.name}"`);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  return res.sendFile(path.resolve(latest.fullPath));
});

app.get("/api/apk/download/:id", (req, res) => {
  const apk = getApkById(String(req.params.id || "").trim());
  if (!apk) return res.status(404).json({ ok: false, error: "Versión APK no encontrada." });
  res.setHeader("Content-Disposition", `attachment; filename="${apk.name}"`);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  return res.sendFile(path.resolve(apk.fullPath));
});

// ── URL proxy for contact import ─────────────────────────────────────────
function isPrivateNetworkAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc")
      || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)
      || normalized.startsWith("ff") || normalized.startsWith("::ffff:127.")
      || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

async function validatePublicImportUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl || "")); }
  catch { throw Object.assign(new Error("URL invalida."), { statusCode: 400 }); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw Object.assign(new Error("Solo se permiten URLs HTTP o HTTPS."), { statusCode: 400 });
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw Object.assign(new Error("No se permiten direcciones locales o internas."), { statusCode: 400 });
  }
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateNetworkAddress(entry.address))) {
    throw Object.assign(new Error("La URL apunta a una red privada o no permitida."), { statusCode: 400 });
  }
  return parsed.toString();
}

app.get("/api/fetch-url", remoteFetchRateLimit, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "url requerida" });
  try {
    const safeUrl = await validatePublicImportUrl(url);
    const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
    const fetchFn = fetch || globalThis.fetch;
    const r = await fetchFn(safeUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VOIP VC/1.0)" },
      signal: AbortSignal.timeout(Number(process.env.FETCH_TIMEOUT_MS || 10000)),
      redirect: "error",
      size: 2 * 1024 * 1024
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: `HTTP ${r.status} al obtener la URL` });
    const contentType = String(r.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("text/csv")) {
      return res.status(415).json({ ok: false, error: "La URL no devuelve HTML, texto o CSV." });
    }
    const html = await r.text();
    return res.json({ ok: true, html });
  } catch (e) {
    return res.status(Number(e.statusCode || 502)).json({ ok: false, error: e.message });
  }
});

app.get("/api/twilio/status", async (req, res) => {
  return res.status(501).json({
    ok: false,
    error: "Twilio deshabilitado en este despliegue."
  });
});

app.post("/api/twilio/configure", async (req, res) => {
  return res.status(501).json({
    ok: false,
    error: "Twilio deshabilitado en este despliegue."
  });
});

app.post("/api/twilio/webhook/voice", express.urlencoded({ extended: false }), (req, res) => {
  return res.status(501).type("text/plain").send("Twilio deshabilitado en este despliegue.");
});

app.use(express.static(path.join(__dirname, "../web")));
app.get("/health", (_, res) => res.json({ ok: true }));

bootstrap().catch(err => {
  console.error("Fallo critico al iniciar el servidor:", err);
  process.exit(1);
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal}: guardando sesiones...`);
  try { await persistence.save(sessions); }
  catch (error) { console.error("No se pudieron guardar las sesiones al cerrar:", error); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));
