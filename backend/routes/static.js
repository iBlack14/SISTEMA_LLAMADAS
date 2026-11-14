import express from "express";
import { registerLegacyAssets } from "./legacy-assets.js";

export function registerStatic(runtime) {
  const { app, auth, paths, instanceIdentity } = runtime;
  app.use("/panel", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(req.user ? "/" : "/login");
  });
  app.get("/features/admin/network/network.html", auth.requireAdmin, (_, res) => res.redirect("/nucleo-red"));
  registerLegacyAssets(runtime);
  app.use("/shared", express.static(paths.sharedRoot));
  app.use(express.static(paths.frontendRoot));
  app.use(express.static(paths.legacyAssetsRoot));
  app.get("/health", (_, res) => res.json({ ok: true, application: "voip-vc", instance: instanceIdentity }));
}
