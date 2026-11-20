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
 * registerCampaigns: conserva los contratos y reglas existentes.
 * Dependencias: runtime.app, runtime.io, runtime.persistence, runtime.sessions, services.allCallAttempts, services.archiveCurrentCampaign, services.dispatchCampaignCalls, services.emitCampaignState, services.emitState, services.saveSoon.
 * Se construye una vez por proceso.
 */
export function registerCampaigns(runtime, services) {
runtime.app.post("/api/session/:code/campaign/start", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  let contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  if (!contacts.length) return res.status(400).json({ ok: false, error: "contacts requeridos" });

  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).send("Sesion no encontrada");
  const currentCampaign = ensureCampaign(session);
  if (currentCampaign.status === "running" || Object.keys(currentCampaign.assignments || {}).length) {
    return res.status(409).json({ ok: false, error: "Ya hay una campana en curso. Pausala o detenla antes de iniciar otra." });
  }
  if (contacts.length > 10000) {
    return res.status(413).json({ ok: false, error: "La campana admite hasta 10000 contactos." });
  }
  try {
    const history = await runtime.persistence.getCallAttempts(code);
    contacts = uncalledContacts(contacts, services.allCallAttempts());
    const blockedPhones = new Set(services.globalBlockedNumbers().map(entry => phoneKey(entry.phone)));
    contacts = contacts.filter(contact => !blockedPhones.has(phoneKey(contact.phone)));
  } catch {
    return res.status(503).json({ok:false,error:"No se pudo comprobar el historial en MySQL."});
  }
  if (!contacts.length) return res.status(409).json({ok:false,error:"Todos los teléfonos seleccionados ya fueron llamados, están bloqueados globalmente o están duplicados."});
  if (ensureCampaign(session).status === "running" || Object.keys(ensureCampaign(session).assignments || {}).length) {
    return res.status(409).json({ok:false,error:"Ya se inició una campaña mientras se consultaba el historial."});
  }
  services.archiveCurrentCampaign(session);
  syncPendingContacts(session, currentCampaign);
  startCampaign(session, contacts, {
    listName: req.body?.listName,
    maxAttempts: req.body?.maxAttempts ?? 1
  });

const startedCampaign = ensureCampaign(session);

startedCampaign.reportRunId = nanoid(12);

startedCampaign.reportDate = new Date()
  .toLocaleDateString("en-CA", {
    timeZone: "America/Lima"
  });

startedCampaign.reportRubro = String(
  req.body?.listName || "Principal"
);

  if (String(req.body?.listName || "").trim() === "Pendientes del turno") {
    markPendingCampaignStarted(session, contacts);
  }
  session.updatedAt = Date.now();
  try { await runtime.persistence.save(runtime.sessions); }
  catch { return res.status(503).json({ok:false,error:"No se pudo guardar la campaña en MySQL."}); }
  services.emitCampaignState(code);
  const dispatched = services.dispatchCampaignCalls(code);

  return res.json({
    ok: true,
    code,
    dispatched: dispatched.length,
    campaign: { ...getCampaignSnapshot(session), turn: getShiftSnapshot(session) }
  });
});

runtime.app.post("/api/session/:code/campaign/pause", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  pauseCampaign(session);
  try { await runtime.persistence.save(runtime.sessions); }
  catch { services.emitCampaignState(code); return res.status(503).json({ok:false,error:"Campaña pausada, pero falta confirmar el guardado en MySQL."}); }
  services.emitCampaignState(code);
  return res.json({ ok: true, code, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/campaign/resume", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  resumeCampaign(session);
  try { await runtime.persistence.save(runtime.sessions); }
  catch { pauseCampaign(session); return res.status(503).json({ok:false,error:"No se confirmó la continuación en MySQL."}); }
  services.emitCampaignState(code);
  const dispatched = services.dispatchCampaignCalls(code);
  return res.json({ ok: true, code, dispatched: dispatched.length, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/campaign/dispatch", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const dispatched = services.dispatchCampaignCalls(code);
  services.saveSoon();
  services.emitCampaignState(code);
  return res.json({ ok: true, code, dispatched: dispatched.length, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/campaign/stop", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  pauseCampaign(session);
  const activeAssignments = Object.values(ensureCampaign(session).assignments || {});
  for (const assignment of activeAssignments) skipActiveContact(session, assignment.workerId);
  ensureCampaign(session).status = "completed";
  ensureCampaign(session).completedAt = new Date().toISOString();
  for (const assignment of activeAssignments) {
    if (assignment.workerSocketId) {
      runtime.io.to(assignment.workerSocketId).emit("call:action", {
        action: "hangup",
        from: "dashboard",
        contactId: assignment.contactId,
        commandId: nanoid()
      });
    }
  }
  services.saveSoon();
  services.emitCampaignState(code);
  services.emitState(code);
  return res.json({ ok: true, code, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/campaign/skip", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  if (!code) return res.status(400).json({ ok: false, error: "Code requerido" });
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const requestedWorkerId = String(req.body?.workerId || "").trim();
  const campaignBeforeSkip = ensureCampaign(session);
  const assignmentBeforeSkip = requestedWorkerId
    ? campaignBeforeSkip.assignments?.[requestedWorkerId]
    : Object.values(campaignBeforeSkip.assignments || {})[0];
  const skipped = skipActiveContact(session, requestedWorkerId);
  if (assignmentBeforeSkip?.workerSocketId) {
    runtime.io.to(assignmentBeforeSkip.workerSocketId).emit("call:action", {
      action: "hangup",
      from: "dashboard",
      contactId: assignmentBeforeSkip.contactId,
      commandId: nanoid()
    });
  }
  services.saveSoon();
  services.emitCampaignState(code);
  if (ensureCampaign(session).status === "running") services.dispatchCampaignCalls(code);
  return res.json({ ok: true, code, skipped, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/campaign/result", (req, res) => {
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

  const session = runtime.sessions.get(code);
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
    runtime.io.to(hangupWorkerSocketId).emit("call:action", { action: "hangup", from: "dashboard", contactId });
  }

  services.saveSoon();
  services.emitCampaignState(code);
  if (ensureCampaign(session).status === "running") {
    services.dispatchCampaignCalls(code);
  }
  return res.json({ ok: true, code, contact: updated, campaign: getCampaignSnapshot(session) });
});

runtime.app.post("/api/session/:code/campaign/callback", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const contactId = String(req.body?.contactId || "").trim();
  if (!code || !contactId) {
    return res.status(400).json({ ok: false, error: "code y contactId son requeridos" });
  }

  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });

  const contact = markContactResult(session, contactId, "requiere_asesor", {
    callbackReason: req.body?.callbackReason,
    assignedAdvisor: req.body?.assignedAdvisor,
    transcriptSummary: req.body?.transcriptSummary
  });
  if (!contact) return res.status(404).json({ ok: false, error: "Contacto no encontrado" });

  services.saveSoon();
  services.emitCampaignState(code);
  if (ensureCampaign(session).status === "running") {
    services.dispatchCampaignCalls(code);
  }
  return res.json({ ok: true, code, contact, campaign: getCampaignSnapshot(session) });
});
}
