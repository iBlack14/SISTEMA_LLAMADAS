import { nanoid } from "nanoid";
import compression from "compression";
import { selectPendingReportContacts } from "../services/reports/report-selection.js";
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
 * registerReports: conserva los contratos y reglas existentes.
 * Dependencias: runtime.app, runtime.persistence, runtime.sessions, services.annualBlock, services.archiveCurrentCampaign, services.blockedCallMessage, services.dispatchCampaignCalls, services.emitCampaignState, services.emitState, services.hasDashboardAccess, services.reportData.
 * Se construye una vez por proceso.
 */
export function registerReports(runtime, services) {
// Se registra antes de las rutas de reportes: la compresión global de estáticos
// se instala después y no alcanza a estas respuestas JSON grandes.
runtime.app.use(
  ["/api/reports/all", "/api/session/:code/reports/daily"],
  compression({ threshold: 1024 })
);
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
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");

  if ((date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) ||
      (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) ||
      (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) ||
      Boolean(from) !== Boolean(to) ||
      (from && to && from > to) ||
      (date && (from || to))) {
    return res.status(400).json({
      ok: false,
      error: "Fecha invalida"
    });
  }

  return res.json({
    ok: true,
    reports: services.reportData(session, from && to ? { from, to } : date)
  });
});

// Marcas del calendario: solo fecha y conteo, sin hidratar reportes completos.
runtime.app.get("/api/session/:code/reports/calendar", (req, res) => {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  const year = String(req.query.year || "");
  if (year && !/^\d{4}$/.test(year)) return res.status(400).json({ ok: false, error: "Año invalido" });
  return res.json({ ok: true, dates: services.calendarReportDates(session, year) });
});

// Vista de administrador: consolida los reportes de todas las cuentas.
runtime.app.get("/api/reports/all", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const requestStartedAt = performance.now();
  const date = String(req.query.date || "");
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const userId = String(req.query.userId || "");
  if ((date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) ||
      (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) ||
      (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) ||
      Boolean(from) !== Boolean(to) ||
      (from && to && from > to) ||
      (date && (from || to))) {
    return res.status(400).json({ ok: false, error: "Fecha invalida" });
  }
  try {
    const usersQueryStartedAt = performance.now();
    const [users] = await runtime.auth.pool.query(
      "SELECT id,username FROM auth_users ORDER BY username");
    const usersQueryMs = performance.now() - usersQueryStartedAt;
    const names = new Map(users.map(user => [String(user.id), user.username]));
    if (userId && !names.has(userId)) {
      return res.status(400).json({ ok: false, error: "El usuario seleccionado no existe." });
    }
    const reports = [];
    const reportBuildStartedAt = performance.now();
    const reportContext = services.createReportContext();
    for (const [code, session] of runtime.sessions) {
      const ownerId = String(session.ownerUserId || "");
      if (!ownerId || (userId && ownerId !== userId)) continue;
      for (const report of services.reportData(session, from && to ? { from, to } : date, reportContext)) {
        reports.push({
          ...report,
          id: `${code}-${report.id}`,
          sessionCode: code,
          ownerUserId: ownerId,
          owner: names.get(ownerId) || `Usuario ${ownerId}`
        });
      }
    }
    reports.sort((a, b) => String(b.date).localeCompare(String(a.date)) ||
      String(a.owner).localeCompare(String(b.owner), "es") ||
      String(a.rubro).localeCompare(String(b.rubro), "es"));
    const reportBuildMs = performance.now() - reportBuildStartedAt;
    const totalMs = performance.now() - requestStartedAt;
    res.setHeader("Server-Timing", `users;dur=${usersQueryMs.toFixed(1)}, reports;dur=${reportBuildMs.toFixed(1)}, total;dur=${totalMs.toFixed(1)}`);
    return res.json({ ok: true, reports, users: users.map(user => ({ id: String(user.id), username: user.username })), storage: runtime.persistence.status() });
  } catch {
    return res.status(503).json({ ok: false, error: "No se pudieron cargar los reportes de todos los usuarios." });
  }
});

// Marcas del calendario de todas las cuentas, sin el costo de reportData completo.
runtime.app.get("/api/reports/calendar", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const year = String(req.query.year || "");
  const userId = String(req.query.userId || "");
  if (year && !/^\d{4}$/.test(year)) return res.status(400).json({ ok: false, error: "Año invalido" });
  if (userId && !/^\d+$/.test(userId)) return res.status(400).json({ ok: false, error: "Usuario invalido" });
  try {
    const dates = {};
    for (const [code, session] of runtime.sessions) {
      if (!session.ownerUserId || (userId && String(session.ownerUserId) !== userId)) continue;
      const partial = services.calendarReportDates(session, year);
      for (const [date, count] of Object.entries(partial)) {
        dates[date] = (dates[date] || 0) + count;
      }
    }
    return res.json({ ok: true, dates });
  } catch {
    return res.status(503).json({ ok: false, error: "No se pudieron cargar las fechas del calendario." });
  }
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
      services.isGloballyBlocked(contact.phone) ||
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

    try { await runtime.persistence.save(runtime.sessions, [code]); }
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
