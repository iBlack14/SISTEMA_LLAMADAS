import express from "express";

export function registerStatic(runtime) {
  const { app, auth, paths, instanceIdentity } = runtime;
  app.use("/panel", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(req.user ? "/" : "/login");
  });
  app.get("/features/admin/network/network.html", auth.requireAdmin, (_, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(paths.adminPage);
  });
  const staticOptions = { setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache, must-revalidate");
  } };
  app.use("/shared", express.static(paths.sharedRoot, staticOptions));
  app.use(express.static(paths.frontendRoot, staticOptions));
  app.get("/health", (_, res) => res.json({ ok: true, application: "voip-vc", instance: instanceIdentity }));
}
