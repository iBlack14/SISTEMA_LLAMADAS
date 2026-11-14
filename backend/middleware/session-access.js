

/**
 * createSessionAccess: conserva los contratos y reglas existentes.
 * Dependencias: runtime.sessions.
 * Se construye una vez por proceso.
 */
export function createSessionAccess(runtime, services) {
function hasDashboardAccess(req, session) {
  const token = String(req.headers["x-dashboard-token"] || req.query.dashboardToken || "").trim();
  return Boolean(req.user && req.operationalAccess && session?.dashboardToken && token === session.dashboardToken);
}

function requireDashboardAccess(req, res, next) {
  const code = String(req.params.code || "").toUpperCase().trim();
  const session = runtime.sessions.get(code);
  if (!session) return res.status(404).json({ ok: false, error: "Sesion no encontrada" });
  if (!hasDashboardAccess(req, session)) return res.status(401).json({ ok: false, error: "Acceso del dashboard no autorizado" });
  req.dashboardSession = session;
  next();
}
return { hasDashboardAccess, requireDashboardAccess };
}
