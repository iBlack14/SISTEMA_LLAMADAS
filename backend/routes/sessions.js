import { nanoid } from "nanoid";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks, phoneKey } from "../services/campaigns/contact-book.js";
import { collectUsedBaseFingerprints, mergeImportedContactBatches } from "../services/contacts/import-contact-book.js";
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
  if (!["add", "edit", "delete", "delete-all"].includes(action) || (action !== "delete-all" && typeof phone !== "string") ||
      ((action === "add" || action === "edit") && (typeof name !== "string" || !name.trim() || name.trim().length > 120))) {
    return res.status(400).json({ok:false,error:"Datos del contacto inválidos"});
  }
  try {
    await runtime.historyGate.serialize(code, async () => {
      const previous = session.messageContacts || [];
      if (action === "add") {
        if (previous.some(item => item.phone === phone)) throw Object.assign(new Error("Contacto ya existe"),{status:409});
        session.messageContacts = [...previous, { name: name.trim(), phone, createdAt: new Date().toISOString() }];
      } else if (action === "delete") {
        if (!previous.some(item => item.phone === phone)) throw Object.assign(new Error("Contacto no encontrado"),{status:404});
        session.messageContacts = previous.filter(item => item.phone !== phone);
      } else if (action === "delete-all") {
        session.messageContacts = [];
      } else {
        if (!previous.some(item => item.phone === phone)) throw Object.assign(new Error("Contacto no encontrado"),{status:404});
        session.messageContacts = previous.map(item => item.phone === phone ? {...item,name:name.trim(),updatedAt:new Date().toISOString()} : item);
      }
      try { await runtime.persistence.save(runtime.sessions, [code]); }
      catch (error) { session.messageContacts = previous; throw error; }
    });
    if (session.dashboardSocketId) runtime.io.to(session.dashboardSocketId).emit("messages:contacts", {contacts:session.messageContacts});
    res.json({ok:true,contacts:session.messageContacts});
  } catch (error) {
    res.status(error.status || 503).json({ok:false,error:error.status ? error.message : "No se pudo guardar el contacto."});
  }
});
runtime.app.get("/api/session/:code/contact-book", async (req, res) => {
  const startedAt = Date.now();
  const code = String(req.params.code).toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ok:false,error:"Sesión no encontrada"});
  try {
    const progress = await runtime.persistence.getContactProgress(code);
    const book = session.contactBook ? withProgress(session.contactBook, progress, services.annualBlocks()) : null;
    const totalMs = Date.now() - startedAt;
    const source = runtime.persistence.contactBookStorageEnabled ? "normalized-mysql" : "sessions.data";
    const attempts = [...progress.values()].reduce((total, row) => total + row.count, 0);
    console.info(`[CONTACT_BOOK] GET session=${code.slice(-2)} source=${source} revision=${session.contactBookRevision || 0} lists=${session.contactBook?.lists?.length || 0} contacts=${session.contactBook?.contacts?.length || 0} attempts=${attempts} totalMs=${totalMs}`);
    res.json({ok:true,revision:session.contactBookRevision || 0, book});
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
    const previousContacts = session.contactBook?.contacts?.length || 0;
    const previousLists = session.contactBook?.lists?.length || 0;
    const revision = await runtime.historyGate.serialize(code, async () => {
      if (Number(req.body?.revision) !== Number(session.contactBookRevision || 0)) {
        throw Object.assign(new Error("La base cambió. Recarga antes de editar."),{conflict:true});
      }
      session.contactBook = book;
      session.contactBookRevision = Number(session.contactBookRevision || 0) + 1;
      session.updatedAt = Date.now();
      runtime.persistence.markContactBookDirty(code);
      await runtime.persistence.save(runtime.sessions, [code]);
      console.info(`[CONTACT_BOOK] PUT session=${code.slice(-2)} revision=${session.contactBookRevision} contacts=${previousContacts}->${book.contacts.length} lists=${previousLists}->${book.lists.length} persisted=mysql`);
      return session.contactBookRevision;
    });
    if (runtime.io) runtime.io.to(code).emit("contact-book:changed", { revision });
    res.json({ok:true,revision});
  } catch (error) {
    res.status(error.conflict ? 409 : 503).json({ok:false,error:error.conflict ? error.message : "No se confirmó el guardado en MySQL. Recarga antes de continuar."});
  }
});

runtime.app.post("/api/session/:code/contact-book/import", async (req, res) => {
  const code = String(req.params.code).toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ok:false,error:"Sesión no encontrada"});
  const batches = req.body?.batches;
  if (!Array.isArray(batches) || !batches.length || batches.length > 50) {
    return res.status(400).json({ok:false,error:"Selecciona una o más bases válidas."});
  }
  try {
    const result = await runtime.historyGate.serialize(code, async () => {
      if (Number(req.body?.revision) !== Number(session.contactBookRevision || 0)) {
        throw Object.assign(new Error("La base cambió. Recarga antes de importar."),{status:409,conflict:true});
      }
      const merged = mergeImportedContactBatches(session.contactBook, batches, {
        annualBlocks: services.annualBlocks(),
        globallyBlocked: services.globalBlockedNumbers(),
        usedBases: collectUsedBaseFingerprints(runtime.sessions, code)
      });
      const totalAdded = merged.batches.reduce((sum, batch) => sum + batch.added, 0);
      if (!totalAdded) {
        const called = merged.batches.reduce((sum, batch) => sum + batch.skippedCalled, 0);
        const blocked = merged.batches.reduce((sum, batch) => sum + batch.skippedBlocked, 0);
        const error = new Error(`No hay números nuevos para importar. ${called} ya fueron llamados y ${blocked} están bloqueados.`);
        error.status = 422;
        throw error;
      }
      const book = normalizeBook(merged.book);
      session.contactBook = book;
      session.contactBookRevision = Number(session.contactBookRevision || 0) + 1;
      session.updatedAt = Date.now();
      runtime.persistence.markContactBookDirty(code);
      await runtime.persistence.save(runtime.sessions, [code]);
      return { revision: session.contactBookRevision, batches: merged.batches, total: book.contacts.length };
    });
    if (runtime.io) runtime.io.to(code).emit("contact-book:changed", { revision: result.revision });
    return res.json({ok:true,...result});
  } catch (error) {
    const status = error.status || (error.conflict ? 409 : 503);
    return res.status(status).json({ok:false,conflict:Boolean(error.conflict),error:error.message || "No se pudo importar la base."});
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

runtime.app.get("/api/session/:code/turns/:turnId/report", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const turnId = String(req.params.turnId || "").trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const management = ensureShiftManagement(session);
  const turn = management.history.find((item) => item.id === turnId);
  if (!turn) return res.status(404).json({ ok: false, error: "Turno no encontrado" });
  let turnForResponse = turn;
  if (turn._unfinishedContactsLoaded === false) {
    try {
      turnForResponse = {
        ...turn,
        unfinishedContacts: await runtime.persistence.getShiftUnfinishedContacts(code, turnId)
      };
    } catch {
      return res.status(503).json({ ok: false, error: "No se pudo consultar el detalle del turno." });
    }
  }
  const { _unfinishedContactsLoaded, unfinishedContactCount, ...visibleTurn } = turnForResponse;
  return res.json({ ok: true, code, turn: visibleTurn });
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
  try { await runtime.persistence.save(runtime.sessions, [code]); }
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
  // Rotate tokens on existing slots so old QR codes stop working, but
  // preserve the slot IDs so the dashboard does not need a page reload.
  const existingSlots = Array.isArray(session.pairingSlots) ? session.pairingSlots : [];
  while (existingSlots.length < 3) existingSlots.push(services.createPairingSlot(existingSlots.length));
  session.pairingSlots = existingSlots.slice(0, Math.max(existingSlots.length, 3)).map((slot, index) =>
    services.createPairingSlot(index, { ...slot, deviceId: "", deviceName: "", linkedAt: null, token: nanoid(20) })
  );
  session.pairingToken = nanoid(20);
  session.updatedAt = Date.now();
  try { await runtime.persistence.save(runtime.sessions, [code]); }
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
