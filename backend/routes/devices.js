import { nanoid } from "nanoid";
import QRCode from "qrcode";
import { bindDeviceToPairingSlot, clearDeviceFromPairingSlots, dedupePairingSlotDevices } from "../services/calls/pairing-lifecycle.js";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks } from "../services/campaigns/contact-book.js";
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
} from "../services/campaigns/campaign-manager.js";

/**
 * registerDevices: conserva los contratos y reglas existentes.
 * Dependencias: runtime.app, runtime.io, runtime.pairingRateLimit, runtime.sessions, services.annualBlock, services.blockedCallMessage, services.createPairingSlot, services.dispatchCampaignCalls, services.emitCampaignState, services.emitState, services.getAndroidApiBaseUrl, services.getOrCreateSession, services.getPairingLink, services.getPairingSlotByToken, services.hasDashboardAccess, services.isGloballyBlocked, services.refreshGlobalCallRestrictions, services.saveSoon, services.sendPersistedDial, services.syncSessionPhoneState, services.upsertPhoneWorker.
 * Se construye una vez por proceso.
 */
export function registerDevices(runtime, services) {
runtime.app.get("/api/pairing/:code", runtime.pairingRateLimit, (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = runtime.sessions.has(code) ? services.getOrCreateSession(code) : null;
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  if (!services.hasDashboardAccess(req, session)) return res.status(401).json({ ok: false, error: "Acceso del dashboard no autorizado" });
  const pairingSlots = (session.pairingSlots || []).map((slot) => ({
    id: slot.id,
    label: slot.label,
    link: services.getPairingLink(req, code, slot.token),
    deviceId: slot.deviceId || "",
    deviceName: slot.deviceName || "",
    linkedAt: slot.linkedAt || null,
    connected: Boolean((session.phoneWorkers || []).some((worker) => worker.pairingSlotId === slot.id && worker.connected && worker.socketId))
  }));
  const link = pairingSlots[0]?.link || services.getPairingLink(req, code, session.pairingToken);

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

runtime.app.post("/api/session/:code/pairing-slots", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = runtime.sessions.has(code) ? services.getOrCreateSession(code) : null;
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  if ((session.pairingSlots || []).length >= 20) {
    return res.status(409).json({ ok: false, error: "Se permiten hasta 20 codigos QR por sesion" });
  }
  const slot = services.createPairingSlot(session.pairingSlots.length);
  session.pairingSlots.push(slot);
  session.updatedAt = Date.now();
  services.saveSoon();
  services.emitState(code);
  return res.json({ ok: true, code, slotId: slot.id });
});

runtime.app.post("/api/pairing/token/:code", runtime.pairingRateLimit, (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = runtime.sessions.has(code) ? services.getOrCreateSession(code) : null;
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  if (!services.hasDashboardAccess(req, session)) return res.status(401).json({ ok: false, error: "Acceso no autorizado" });
  // Generate fresh pairing token (rotated)
  session.pairingToken = nanoid(20);
  session.updatedAt = Date.now();
  services.saveSoon();
  services.emitState(code);
  return res.json({ ok: true, code, token: session.pairingToken });
});

runtime.app.delete("/api/session/:code/pairing-slots/:slotId", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const slotId = String(req.params.slotId || "").trim();
  const session = runtime.sessions.has(code) ? services.getOrCreateSession(code) : null;
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const index = (session.pairingSlots || []).findIndex((slot) => slot.id === slotId);
  if (index < 0) return res.status(404).json({ ok: false, error: "Codigo QR no encontrado" });
  if (session.pairingSlots[index].deviceId) {
    return res.status(409).json({ ok: false, error: "Este QR tiene un telefono vinculado. Cierra primero la sesion de ese telefono." });
  }

  session.pairingSlots.splice(index, 1);
  session.pairingSlots.forEach((slot, slotIndex) => { slot.label = `EQUIPO ${slotIndex + 1}`; });
  session.updatedAt = Date.now();
  services.saveSoon();
  services.emitState(code);
  return res.json({ ok: true, code, slotId });
});

runtime.app.post("/api/session/:code/workers/:workerId/pause", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no encontrado" });
  const paused = Boolean(req.body?.paused);
  setWorkerPaused(session, workerId, paused);
  services.saveSoon();
  services.emitCampaignState(code);
  services.emitState(code);
  if (!paused) services.dispatchCampaignCalls(code);
  return res.json({ ok: true, code, workerId, paused, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/workers/:workerId/hangup", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no conectado" });
  const contact = getContactByWorker(session, workerId);
  runtime.io.to(worker.socketId).emit("call:action", {
    action: "hangup",
    from: "dashboard",
    contactId: contact?.id || "",
    commandId: nanoid()
  });
  return res.json({ ok: true, code, workerId, contactId: contact?.id || null });
});

runtime.app.post("/api/session/:code/workers/:workerId/start-independent", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no conectado" });
  let submittedContacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  if (!submittedContacts.length && session.contactBook?.contacts?.length) {
    const slot = (session.pairingSlots || []).find((s) => s.deviceId === workerId);
    const assignedList = session.contactBook?.preferences?.pairingListAssignments?.[slot?.id] || "";
    if (assignedList) {
      submittedContacts = session.contactBook.contacts.filter((c) => (c.list || "Principal") === assignedList);
    }
  }
  console.info(`[CALL_REQUEST] start-independent session=${code.slice(-2)} worker=${worker.id} contacts=${submittedContacts.length}`);
  const campaign = ensureCampaign(session);
  // Preparar la lista del equipo y reasignar contactos pendientes al nuevo equipo para continuar la lista.
  for (const input of submittedContacts) {
    if (!input || typeof input !== "object") continue;
    const existing = campaign.contacts.find((contact) => contact.id === String(input.id || "").trim());
    // Si el contacto está actualmente en llamada activa en OTRO teléfono, no interrumpirlo
    const isMidCallElsewhere = existing?.assignedWorkerId && existing.assignedWorkerId !== workerId && ["dialing", "ringing", "in_call"].includes(existing.status);
    if (isMidCallElsewhere) continue;
    ensureCampaignContact(session, { ...input, targetWorkerId: workerId });
  }
  campaign.status = "running";
  setWorkerPaused(session, workerId, false);
  resumeHeldContact(session, workerId);
  const dispatched = services.dispatchCampaignCalls(code, workerId);
  console.info(`[CALL_REQUEST] start-independent result session=${code.slice(-2)} worker=${worker.id} dispatched=${dispatched.length}`);
  return res.json({ ok: true, code, workerId, dispatched: dispatched.length, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/workers/:workerId/switch-list", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const currentList = String(req.body?.currentList || "").trim();
  const nextList = String(req.body?.nextList || "").trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no conectado" });

  const switched = switchWorkerList(session, workerId, currentList, nextList);
  if (!switched.ok) return res.status(409).json(switched);
  if (switched.activeContact) {
    runtime.io.to(worker.socketId).emit("call:action", {
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
  services.saveSoon();
  services.emitState(code);
  services.emitCampaignState(code);
  if (ensureCampaign(session).status === "running") {
    setTimeout(() => services.dispatchCampaignCalls(code, workerId), 1500);
  }
  return res.json({ ok: true, code, workerId, currentList, nextList, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/workers/:workerId/call-contact", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const contactId = String(req.body?.contactId || req.body?.contact?.id || "").trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "El equipo asignado no esta conectado" });
  const campaign = ensureCampaign(session);
  const requested = ensureCampaignContact(session, { ...(req.body?.contact || {}), id: contactId, targetWorkerId: workerId });
  if (!requested) return res.status(400).json({ ok: false, error: "El contacto o su numero no son validos" });
  if (requested.targetWorkerId && requested.targetWorkerId !== workerId) {
    return res.status(409).json({ ok: false, error: "El contacto pertenece a otro equipo" });
  }

  const manualRetry = req.body?.manualRetry === true;
  if (services.isGloballyBlocked(requested.phone)) {
    return res.status(409).json({ ok: false, error: "Número en la lista de bloqueos. Desbloquéalo antes de llamar.", reason: "numero_bloqueado" });
  }
  const block = services.annualBlock(requested.phone);
  if (block && (!manualRetry || block.permanent)) {
    return res.status(409).json({ok:false,error:services.blockedCallMessage(block),reason:"numero_llamado_anteriormente",nextAllowedAt:block.nextAllowedAt});
  }
  const held = holdActiveContact(session, workerId);
  if (held) {
    runtime.io.to(worker.socketId).emit("call:action", { action: "hangup", from: "dashboard", contactId: held.id, commandId: nanoid() });
  }
  setWorkerPaused(session, workerId, false);
  const contact = assignSpecificContact(session, worker, contactId);
  if (!contact) return res.status(409).json({ ok: false, error: "No se pudo asignar el contacto al equipo" });

  console.info(`[CALL_REQUEST] manual session=${code.slice(-2)} worker=${worker.id} contactPresent=${Boolean(contact.id)} manualRetry=${manualRetry}`);

  worker.callState = "dialing";
  worker.activeContactId = contact.id;
  worker.lastCompanyName = contact.name;
  worker.lastNumber = contact.phone;
  services.sendPersistedDial(code, worker.socketId, {
    action: "dial",
    phoneNumber: contact.phone,
    contactId: contact.id,
    companyName: contact.name,
    contactName: contact.name,
    callId: getActiveAttemptId(session, worker.id),
    commandId: nanoid()
  });
  session.updatedAt = Date.now();
  services.saveSoon();
  services.emitState(code);
  services.emitCampaignState(code);
  services.refreshGlobalCallRestrictions(code);
  return res.json({ ok: true, code, workerId, contactId: contact.id, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/workers/:workerId/stop-independent", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId && item.connected && item.socketId);
  if (!worker) return res.status(404).json({ ok: false, error: "Telefono no conectado" });
  const held = holdActiveContact(session, workerId);
  setWorkerPaused(session, workerId, true);
  runtime.io.to(worker.socketId).emit("call:action", { action: "hangup", from: "dashboard", contactId: held?.id || "", commandId: nanoid() });
  worker.callState = "idle";
  worker.lastNumber = held?.phone || worker.lastNumber || "";
  worker.lastCompanyName = held?.name || worker.lastCompanyName || "";
  services.saveSoon();
  services.emitCampaignState(code);
  services.emitState(code);
  return res.json({ ok: true, code, workerId, heldContact: held ? { id: held.id, name: held.name, phone: held.phone } : null, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/workers/:workerId/disconnect", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const workerId = String(req.params.workerId || "").trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const worker = (session.phoneWorkers || []).find((item) => item.id === workerId) || null;
  const pairingSlot = (session.pairingSlots || []).find((slot) => slot.id === worker?.pairingSlotId || slot.deviceId === workerId);
  if (!worker && !pairingSlot) return res.status(404).json({ ok: false, error: "Telefono o vinculacion no encontrados" });

  const phoneSocket = worker?.socketId ? runtime.io.sockets.sockets.get(worker.socketId) : null;
  const heldContact = worker ? holdActiveContact(session, workerId) : null;
  clearDeviceFromPairingSlots(session, workerId);
  if (worker?.socketId && ["dialing", "ringing", "in_call"].includes(String(worker.callState || ""))) {
    runtime.io.to(worker.socketId).emit("call:action", { action: "hangup", from: "dashboard", commandId: nanoid() });
  }
  if (worker?.socketId) runtime.io.to(worker.socketId).emit("session:force_logout", { reason: "dashboard_request" });

  // Remove it from the authoritative dashboard state immediately. The later
  // Socket.IO disconnect is only transport cleanup and must not keep the QR
  // or its list assignment occupied.
  if (worker) session.phoneWorkers = (session.phoneWorkers || []).filter((item) => item.id !== workerId);
  services.syncSessionPhoneState(session);

  session.updatedAt = Date.now();
  services.saveSoon();
  services.emitState(code);
  services.emitCampaignState(code);

  setTimeout(() => {
    if (phoneSocket?.connected) phoneSocket.disconnect(true);
  }, 2200);

  return res.json({ ok: true, code, workerId, heldContact: heldContact ? { id: heldContact.id, name: heldContact.name, phone: heldContact.phone } : null, campaign: getCampaignSnapshot(session) });
});

const qrSvgCache = new Map();

runtime.app.get("/api/pairing-qr/:code.svg", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).send("Code requerido");

  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).send("Sesion no encontrada");
  if (!services.hasDashboardAccess(req, session)) return res.status(401).send("Acceso no autorizado");
  const requestedSlotId = String(req.query.slot || "").trim();
  const slot = requestedSlotId
    ? (session.pairingSlots || []).find((item) => item.id === requestedSlotId)
    : (session.pairingSlots || [])[0];
  if (requestedSlotId && !slot) return res.status(404).send("Codigo QR no encontrado");
  const link = services.getPairingLink(req, code, slot?.token || session.pairingToken);

  try {
    let svg = qrSvgCache.get(link);
    if (!svg) {
      svg = await QRCode.toString(link, {
        type: "svg",
        errorCorrectionLevel: "L",
        margin: 1,
        width: 320
      });
      if (qrSvgCache.size > 300) qrSvgCache.clear();
      qrSvgCache.set(link, svg);
    }

    res.setHeader("Content-Type", "image/svg+xml");
    // Pairing links contain rotating per-slot tokens. Do not let browsers or
    // reverse proxies keep a QR image after the session token has changed.
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    return res.send(svg);
  } catch {
    return res.status(500).send("No se pudo generar QR");
  }
});

runtime.app.post("/api/android/pair", runtime.pairingRateLimit, (req, res) => {
  const code = String(req.body?.code || "").toUpperCase().trim();
  const token = String(req.body?.token || "").trim();
  const deviceId = String(req.body?.deviceId || "").trim();
  const deviceName = String(req.body?.deviceName || "").trim() || "Android bridge";

  if (!code || !token || !deviceId) {
    return res.status(400).json({ ok: false, error: "code, token y deviceId son requeridos" });
  }

  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  let pairingSlot = services.getPairingSlotByToken(session, token);
  if (!pairingSlot && session.pairingToken !== token) return res.status(401).json({ ok: false, error: "Token invalido" });
  if (!pairingSlot && session.pairingToken === token) {
    pairingSlot = (session.pairingSlots || []).find((slot) => !slot.deviceId) || null;
  }
  if (pairingSlot?.deviceId && pairingSlot.deviceId !== deviceId) {
    return res.status(409).json({ ok: false, error: "Este QR ya fue utilizado por otro telefono" });
  }

  const worker = services.upsertPhoneWorker(session, {
    socketId: null,
    deviceId,
    deviceName
  });
  if (pairingSlot) {
    bindDeviceToPairingSlot(session, pairingSlot, { deviceId, deviceName }, runtime.io);
    worker.pairingSlotId = pairingSlot.id;
  }
  services.syncSessionPhoneState(session);
  session.updatedAt = Date.now();
  services.saveSoon();
  services.emitState(code);

  const baseUrl = services.getAndroidApiBaseUrl(req);
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
}
