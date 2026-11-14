import { nanoid } from "nanoid";
import { bindDeviceToPairingSlot, clearDeviceFromPairingSlots, dedupePairingSlotDevices } from "../services/calls/pairing-lifecycle.js";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks, phoneKey } from "../services/campaigns/contact-book.js";
import { normalizeMessageContacts, upsertMessageContact } from "../services/messaging/message-contacts.js";
import {
  ensureShiftManagement,
  syncPendingContacts,
  finalizeCurrentTurn,
  finalizeCurrentSession,
  markPendingCampaignStarted,
  getShiftSnapshot
} from "../services/campaigns/shift-manager.js";

/**
 * createSessionShape: conserva los contratos y reglas existentes.
 * Dependencias: .
 * Se construye una vez por proceso.
 */
export function createSessionShape(runtime, services) {
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
    blockedNumbers: [],
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
  const blockedByPhone = new Map();
  for (const entry of Array.isArray(normalized.blockedNumbers) ? normalized.blockedNumbers : []) {
    const phone = String(entry?.phone || entry?.number || "").trim();
    const key = phoneKey(phone);
    if (!/^\d{6,15}$/.test(key)) continue;
    const name = String(entry?.name || "").trim().slice(0, 120) || phone;
    blockedByPhone.set(key, { name, phone });
  }
  normalized.blockedNumbers = [...blockedByPhone.values()];
  normalized.messageContacts = normalizeMessageContacts(normalized.messageContacts);

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
return { createPhoneWorker, createPairingSlot, getPairingSlotByToken, normalizeSessionShape };
}
