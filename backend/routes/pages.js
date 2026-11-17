import path from "path";

/**
 * registerPages: conserva los contratos y reglas existentes.
 * Dependencias: runtime.__dirname, runtime.app, runtime.auth.
 * Se construye una vez por proceso.
 */
export function registerPages(runtime, services) {
runtime.app.get(["/", "/index.html", "/admin.html", "/llamadas", "/contactos", "/reportes", "/bloqueos", "/mensajes", "/reservas", "/nucleo-red", "/usuarios"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user) return res.redirect("/login");
  if (req.path === "/") return res.redirect("/llamadas");
  if (["/admin.html", "/nucleo-red", "/usuarios"].includes(req.path.toLowerCase()) && req.user.role !== "ADMINISTRADOR") return res.sendStatus(403);
  res.sendFile(runtime.paths.dashboardPage);
});

runtime.app.get("/legacy", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user) return res.redirect("/login");
  res.sendFile(runtime.paths.dashboardPage);
});

runtime.app.get("/login", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.user) return res.redirect("/llamadas");
  res.sendFile(runtime.paths.loginPage);
});

runtime.app.get("/legacy/admin", runtime.auth.requireAdmin, (_, res) => res.sendFile(runtime.paths.dashboardPage));
}
