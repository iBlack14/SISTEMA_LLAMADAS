

/**
 * createRateLimiter: conserva los contratos y reglas existentes.
 * Dependencias: .
 * Se construye una vez por proceso.
 */
export function createRateLimiter(runtime, services) {
function createRateLimiter({ windowMs = 60000, max = 60 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: "Demasiadas solicitudes. Intenta nuevamente en unos segundos." });
    }
    next();
  };
}
return { createRateLimiter };
}
