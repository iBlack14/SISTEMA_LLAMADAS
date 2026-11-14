import path from "path";

/**
 * registerPages: conserva los contratos y reglas existentes.
 * Dependencias: runtime.__dirname, runtime.app, runtime.auth.
 * Se construye una vez por proceso.
 */
export function registerPages(runtime, services) {
runtime.app.get(["/", "/index.html", "/admin.html"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user) return res.redirect("/login");
  if (req.path.toLowerCase() === "/admin.html") return runtime.auth.requireAdmin(req, res, () => res.redirect("/nucleo-red"));
  res.sendFile(runtime.paths.dashboardPage);
});

runtime.app.get("/legacy", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user) return res.redirect("/login");
  res.sendFile(runtime.paths.dashboardPage);
});

// Cada sección del panel tiene su propia URL; el cliente elige la vista por ruta.
runtime.app.get(["/llamadas", "/contactos", "/reportes", "/bloqueos", "/mensajes"], (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.user) return res.redirect("/login");
  res.sendFile(runtime.paths.dashboardPage);
});

runtime.app.get("/login", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.user) return res.redirect(req.user.role === "ADMINISTRADOR" ? "/nucleo-red" : "/");
  res.sendFile(runtime.paths.loginPage);
});

runtime.app.get("/legacy/admin", runtime.auth.requireAdmin, (_, res) => res.sendFile(runtime.paths.adminPage));
}
