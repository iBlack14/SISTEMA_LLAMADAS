import path from "path";

/**
 * registerNetwork: conserva los contratos y reglas existentes.
 * Dependencias: runtime.__dirname, runtime.app, runtime.auth, runtime.network.
 * Se construye una vez por proceso.
 */
export function registerNetwork(runtime, services) {
runtime.app.get("/api/network/access", (req, res) => res.json({ ok: true, role: req.user.role }));

runtime.app.get("/api/network", runtime.auth.requireAdmin, async (_, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json({ ok: true, ...await runtime.network.snapshot() }); }
  catch { res.status(503).json({ ok: false, error: "No se pudo consultar Núcleo de Red." }); }
});

runtime.app.get("/api/network/activity", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const raw = String(req.query.equipment || "");
  if (!/^(?:[1-9]|10)(?:,(?:[1-9]|10))*$/.test(raw) || raw.split(",").length > 10) {
    return res.status(400).json({ ok: false, error: "Selecciona equipos del 1 al 10." });
  }
  const numbers = [...new Set(raw.split(",").map(Number))];
  try {
    const snapshot = await runtime.network.snapshot({ detailNumbers: numbers });
    res.json({ ok: true, equipment: snapshot.equipment.filter(item => numbers.includes(item.number)) });
  } catch { res.status(503).json({ ok: false, error: "No se pudo consultar la actividad." }); }
});

runtime.app.get("/api/network/equipment/:number", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1 || number > 10) return res.status(404).json({ ok: false, error: "Equipo no encontrado." });
  try {
    const snapshot = await runtime.network.snapshot({ detailNumbers: [number] });
    res.json({ ok: true, generatedAt: snapshot.generatedAt, equipment: snapshot.equipment[number - 1] });
  } catch { res.status(503).json({ ok: false, error: "No se pudo consultar el equipo." }); }
});

runtime.app.get("/nucleo-red", runtime.auth.requireAdmin, (_, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(runtime.paths.adminPage);
});

runtime.app.get("/usuarios", runtime.auth.requireAdmin, (_, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(runtime.paths.adminPage);
});
}
