// Extracción de server/server.js, líneas 127–156: se conservan exactamente
// las políticas y valores existentes; solo cambia su ubicación y se inyectan dependencias.
import express from "express";

/**
 * registerHttpMiddleware: conserva los contratos y reglas existentes.
 * Dependencias: runtime.CORS_ORIGIN, runtime.app, runtime.auth, runtime.disconnectAuthSockets.
 * Se construye una vez por proceso.
 */
export function registerHttpMiddleware(runtime, services) {
runtime.app.use((req, res, next) => {
  const allowedOrigin = runtime.CORS_ORIGIN;
  if (allowedOrigin === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    const allowed = allowedOrigin.split(",").map(s => s.trim()).filter(Boolean);
    const origin = req.headers.origin || "";
    if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Dashboard-Token, ngrok-skip-browser-warning");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

runtime.app.use("/api/auth/login", express.json({ limit: "4kb" }));

runtime.app.use(express.json({ limit: process.env.MAX_JSON_SIZE || "20mb" }));

runtime.app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=()");
  next();
});

runtime.app.use(runtime.auth.middleware());

runtime.auth.routes(runtime.app, runtime.disconnectAuthSockets);

runtime.app.use("/api/admin", runtime.auth.requireAdmin, runtime.auth.csrf);
}
