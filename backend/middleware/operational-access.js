

/**
 * registerSessionAccess: conserva los contratos y reglas existentes.
 * Dependencias: runtime.app, runtime.auth, runtime.historyGate, services.requireDashboardAccess.
 * Se construye una vez por proceso.
 */
export function registerSessionAccess(runtime, services) {
runtime.app.use(["/api/fetch-url", "/api/server-info", "/api/twilio/configure"], runtime.auth.requireUser, runtime.auth.csrf);

runtime.app.use(["/api/session/:code", "/api/pairing/:code", "/api/pairing-qr/:code.svg"], runtime.auth.requireUser, runtime.auth.csrf,
  async (req, res, next) => {
    try {
      req.operationalAccess = await runtime.auth.canAccess(req.user, String(req.params.code || "").toUpperCase().trim());
      if (!req.operationalAccess) return res.status(403).json({ ok: false, error: "No tienes acceso a esta sesión operativa." });
      res.setHeader("Cache-Control", "no-store");
      next();
    } catch { res.status(503).json({ ok: false, error: "No se pudo validar el acceso." }); }
  });

runtime.app.use("/api/session/:code", services.requireDashboardAccess);
}
