import { nanoid } from "nanoid";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks, phoneKey } from "../services/campaigns/contact-book.js";
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
import {
  ensureShiftManagement,
  syncPendingContacts,
  finalizeCurrentTurn,
  finalizeCurrentSession,
  markPendingCampaignStarted,
  getShiftSnapshot
} from "../services/campaigns/shift-manager.js";

/**
 * registerSessions: conserva los contratos y reglas existentes.
 * Dependencias: runtime.app, runtime.historyGate, runtime.persistence, runtime.sessions, services.allCallAttempts, services.archiveCurrentCampaign, services.createPairingSlot, services.disconnectAllSessionPhones, services.emitCampaignState, services.emitState, services.syncSessionPhoneState.
 * Se construye una vez por proceso.
 */
export function registerSessions(runtime, services) {
runtime.app.post("/api/session/:code/message-contacts/update", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ok:false,error:"Sesión no encontrada"});
  const {action, phone, name} = req.body || {};
  if (!["edit", "delete"].includes(action) || typeof phone !== "string" ||
      (action === "edit" && (typeof name !== "string" || !name.trim() || name.trim().length > 120))) {
    return res.status(400).json({ok:false,error:"Datos del contacto inválidos"});
  }
  try {
    await runtime.historyGate.serialize(code, async () => {
      const previous = session.messageContacts || [];
      if (!previous.some(item => item.phone === phone)) throw Object.assign(new Error("Contacto no encontrado"),{status:404});
      session.messageContacts = action === "delete" ? previous.filter(item => item.phone !== phone)
        : previous.map(item => item.phone === phone ? {...item,name:name.trim(),updatedAt:new Date().toISOString()} : item);
      try { await runtime.persistence.save(runtime.sessions); }
      catch (error) { session.messageContacts = previous; throw error; }
    });
    if (session.dashboardSocketId) runtime.io.to(session.dashboardSocketId).emit("messages:contacts", {contacts:session.messageContacts});
    res.json({ok:true,contacts:session.messageContacts});
  } catch (error) {
    res.status(error.status || 503).json({ok:false,error:error.status ? error.message : "No se pudo guardar el contacto."});
  }
});
runtime.app.get("/api/session/:code/contact-book", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ok:false,error:"Sesión no encontrada"});
  try {
    const attempts = await runtime.persistence.getCallAttempts(code);
    res.json({ok:true,revision:session.contactBookRevision || 0,
      book:session.contactBook ? withProgress(session.contactBook,attempts,services.allCallAttempts()) : null});
  } catch { res.status(503).json({ok:false,error:"No se pudo cargar la base desde MySQL."}); }
});

runtime.app.put("/api/session/:code/contact-book", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ok:false,error:"Sesión no encontrada"});
  let book;
  try { book = normalizeBook(req.body?.book); }
  catch (error) { return res.status(400).json({ok:false,error:error.message}); }
  try {
    const revision = await runtime.historyGate.serialize(code, async () => {
      if (Number(req.body?.revision) !== Number(session.contactBookRevision || 0)) {
        throw Object.assign(new Error("La base cambió. Recarga antes de editar."),{conflict:true});
      }
      session.contactBook = book;
      session.contactBookRevision = Number(session.contactBookRevision || 0) + 1;
      session.updatedAt = Date.now();
      await runtime.persistence.save(runtime.sessions);
      return session.contactBookRevision;
    });
    res.json({ok:true,revision});
  } catch (error) {
    res.status(error.conflict ? 409 : 503).json({ok:false,error:error.conflict ? error.message : "No se confirmó el guardado en MySQL. Recarga antes de continuar."});
  }
});

runtime.app.get("/api/session/:code/workers", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  services.syncSessionPhoneState(session);

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

runtime.app.get("/api/session/:code/campaign", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });

  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  return res.json({
    ok: true,
    code,
    campaign: { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) }
  });
});

runtime.app.get("/api/session/:code/turn", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  syncPendingContacts(session, ensureCampaign(session));
  return res.json({ ok: true, code, turn: getShiftSnapshot(session) });
});

runtime.app.get("/api/session/:code/turns/:turnId/report", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const turnId = String(req.params.turnId || "").trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const management = ensureShiftManagement(session);
  const turn = management.history.find((item) => item.id === turnId);
  if (!turn) return res.status(404).json({ ok: false, error: "Turno no encontrado" });
  return res.json({ ok: true, code, turn });
});

runtime.app.post("/api/session/:code/turn/finalize", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const campaign = ensureCampaign(session);
  services.archiveCurrentCampaign(session);
  const finalizedTurn = finalizeCurrentTurn(session, campaign);
  if (!finalizedTurn) return res.status(409).json({ ok: false, error: "No hay un turno activo para finalizar" });
  services.disconnectAllSessionPhones(session, "turn_finished");
  resetCampaignForShift(session);
  session.updatedAt = Date.now();
  try { await runtime.persistence.save(runtime.sessions); }
  catch { return res.status(503).json({ok:false,error:"No se confirmó el cierre de turno en MySQL."}); }
  services.emitState(code);
  services.emitCampaignState(code);
  return res.json({
    ok: true,
    code,
    finalizedTurn,
    campaign: { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) }
  });
});

runtime.app.post("/api/session/:code/session/finalize", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const campaign = ensureCampaign(session);
  services.archiveCurrentCampaign(session);
  const finalizedSession = finalizeCurrentSession(session);
  resetCampaignOperation(session);
  services.disconnectAllSessionPhones(session, "session_restarted");
  session.pairingSlots = Array.from({ length: 3 }, (_, index) => services.createPairingSlot(index));
  session.pairingToken = nanoid(20);
  session.updatedAt = Date.now();
  try { await runtime.persistence.save(runtime.sessions); }
  catch { return res.status(503).json({ok:false,error:"No se confirmó el cierre de sesión en MySQL."}); }
  services.emitState(code);
  services.emitCampaignState(code);
  return res.json({
    ok: true,
    code,
    finalizedSession,
    campaign: { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) }
  });
});
}
