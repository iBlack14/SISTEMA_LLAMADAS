import express from "express";
import compression from "compression";

export function registerStatic(runtime) {
  const { app, auth, paths, instanceIdentity } = runtime;

  // Compresión gzip/deflate para respuestas HTTP (CSS, JS, JSON, HTML)
  app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    }
  }));

  app.use("/panel", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(req.user ? "/" : "/login");
  });
  app.get("/features/admin/network/network.html", auth.requireAdmin, (_, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(paths.adminPage);
  });
  const staticOptions = {
    maxAge: "1d",
    setHeaders(res, filePath) {
      if (/\.(?:html)$/.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      } else if (/\.(?:js|css|png|jpg|jpeg|svg|ico|woff2?)$/.test(filePath)) {
        // Recursos estáticos versionados: cacheable por el navegador
        res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      }
    }
  };
  app.use("/shared", express.static(paths.sharedRoot, staticOptions));
  app.use(express.static(paths.frontendRoot, staticOptions));
  app.get("/health", (_, res) => res.json({ ok: true, application: "voip-vc", instance: instanceIdentity }));
}
