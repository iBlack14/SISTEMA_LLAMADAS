import { nanoid } from "nanoid";
import { selectPendingReportContacts } from "../services/reports/report-selection.js";
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

/**
 * registerReports: conserva los contratos y reglas existentes.
 * Dependencias: runtime.app, runtime.persistence, runtime.sessions, services.annualBlock, services.archiveCurrentCampaign, services.blockedCallMessage, services.dispatchCampaignCalls, services.emitCampaignState, services.emitState, services.hasDashboardAccess, services.reportData.
 * Se construye una vez por proceso.
 */
export function registerReports(runtime, services) {
runtime.app.get("/api/session/:code/reports/attempts", async (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  if (!services.hasDashboardAccess(req, session)) return res.status(403).json({ ok: false, error: "Acceso no autorizado" });
  const from = String(req.query.from || ""), to = String(req.query.to || "");
  const valid = value => !value || (value.length === 10 &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0,10) === value);
  if (!valid(from) || !valid(to) || (from && to && from > to)) {
    return res.status(400).json({ ok: false, error: "Rango de fechas inválido" });
  }
  try {
    const rows = await runtime.persistence.getCallAttempts(code, { from, to, phone: String(req.query.phone || "") });
    return res.json({ ok: true, rows, storage: runtime.persistence.status() });
  } catch (error) {
    return res.status(503).json({ ok: false, error: "No se pudo consultar el historial guardado. Intenta nuevamente.", storage: runtime.persistence.status() });
  }
});

runtime.app.get("/api/session/:code/reports/daily", (req, res) => {
  const code = String(req.params.code || "")
    .toUpperCase().trim();

  const session = runtime.sessions.get(code);

  if (!session) {
    return res.status(404).json({
      ok: false,
      error: "Sesion no encontrada"
    });
  }

  const date = String(req.query.date || "");

  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      ok: false,
      error: "Fecha invalida"
    });
  }

  return res.json({
    ok: true,
    reports: services.reportData(session, date)
  });
});

runtime.app.post(
  "/api/session/:code/reports/:id/continue",
  async (req, res) => {
    const code = String(req.params.code || "")
      .toUpperCase().trim();

    const session = runtime.sessions.get(code);

    if (!session) {
      return res.status(404).json({
        ok: false,
        error: "Sesion no encontrada"
      });
    }

    const report = services.reportData(session).find(
      r => r.id === req.params.id
    );

    if (!report) {
      return res.status(404).json({
        ok: false,
        error: "Reporte no encontrado"
      });
    }

    const current = ensureCampaign(session);

    if (
      current.status === "running" ||
      Object.keys(current.assignments || {}).length
    ) {
      return res.status(409).json({
        ok: false,
        error: "Hay una campaña en curso"
      });
    }

    const manualRetry = req.body?.manualRetry === true;
    const selection = selectPendingReportContacts(report, req.body?.contactIds, { allowManualRetry: manualRetry });
    if (selection.error) return res.status(selection.status).json({ ok: false, error: selection.error });
    const pending = selection.contacts;
    try {
      await runtime.persistence.getCallAttempts(code);
    } catch {
      return res.status(503).json({ ok: false, error: "No se pudo comprobar el historial en MySQL." });
    }
    const latestCampaign = ensureCampaign(session);
    if (latestCampaign.status === "running" || Object.keys(latestCampaign.assignments || {}).length) {
      return res.status(409).json({ ok: false, error: "Hay una campaña en curso" });
    }
    const restricted = pending.find(contact =>
      (session.blockedNumbers || []).some(entry => phoneKey(entry.phone) === phoneKey(contact.phone)) ||
      (manualRetry ? services.annualBlock(contact.phone)?.permanent : services.annualBlock(contact.phone)));
    if (restricted) {
      const block = services.annualBlock(restricted.phone);
      return res.status(409).json({ ok: false, error: block ? services.blockedCallMessage(block) : "Uno de los números seleccionados está en la lista de bloqueos." });
    }

    if (!pending.length) {
      return res.status(409).json({
        ok: false,
        error: "No hay pendientes validos"
      });
    }

    services.archiveCurrentCampaign(session);

    startCampaign(
      session,
      pending.map(c => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        list: c.list || report.rubro
      })),
      {
        listName: report.rubro,
        maxAttempts: manualRetry ? 1 : 2
      }
    );

    const started = ensureCampaign(session);

    started.reportRunId = nanoid(12);
    started.reportDate = new Date()
      .toLocaleDateString("en-CA", {
        timeZone: "America/Lima"
      });
    started.reportRubro = report.rubro;
    if (manualRetry) started.manualReportRetry = {
      reportId: report.id,
      contactIds: pending.map(contact => String(contact.id)),
      requestedBy: req.user.id,
      requestedAt: new Date().toISOString()
    };

    try { await runtime.persistence.save(runtime.sessions); }
    catch { return res.status(503).json({ ok: false, error: "No se pudo guardar la selección en MySQL." }); }
    services.emitState(code);
    services.emitCampaignState(code);

    const dispatched = services.dispatchCampaignCalls(code);

    return res.json({
      ok: true,
      queued: pending.length,
      dispatched: dispatched.length
    });
  }
);
}
