import path from "path";

/**
 * registerNetwork: conserva los contratos y reglas existentes.
 * Dependencias: runtime.__dirname, runtime.app, runtime.auth, runtime.network.
 * Se construye una vez por proceso.
 */
export function registerNetwork(runtime, services) {
runtime.app.get("/api/network/access", (req, res) => res.json({ ok: true, role: req.user.role }));

runtime.app.get("/api/users/lists", runtime.auth.requireAdmin, async (_, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const [rows] = await runtime.auth.pool.query(`SELECT u.id AS user_id,u.username,u.role,u.active,w.session_code
      FROM auth_users u LEFT JOIN auth_user_workspaces w ON w.user_id=u.id
      ORDER BY u.username`);
    const users = rows.map(row => ({ id: row.user_id, username: row.username,
      role: row.role, active: Boolean(Number(row.active)), lists: [] }));
    for (const row of rows) {
      if (!row.session_code) continue;
      const session = runtime.sessions.get(row.session_code);
      const book = session?.contactBook;
      if (!book) continue;
      const user = users.find(item => String(item.id) === String(row.user_id));
      const names = [...new Set([...(book.lists || []), ...(book.contacts || []).map(contact => contact.list || "Principal")])];
      user.lists = names.map(name => ({ name, count: (book.contacts || []).filter(contact => (contact.list || "Principal") === name).length }));
    }
    res.json({ ok: true, users });
  } catch {
    res.status(503).json({ ok: false, error: "No se pudieron cargar las listas de los usuarios." });
  }
});

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

async function attemptReconnectEquipment(number) {
  const row = runtime.network.registry.find(item => item.position === number);
  let deviceId = row?.device_id || null;
  let sessionCode = row?.session_code || null;

  if (!deviceId) {
    const candidates = [...runtime.network.candidates().values()];
    const candidate = candidates[number - 1];
    if (candidate) {
      deviceId = candidate.slot?.deviceId;
      sessionCode = candidate.code;
    }
  }

  const session = sessionCode ? runtime.sessions.get(sessionCode) : null;
  const worker = (session?.phoneWorkers || []).find(w => w.id === deviceId);

  if (sessionCode) {
    runtime.io.to(sessionCode).emit("phone:reconnect_request", {
      number,
      deviceId,
      code: sessionCode,
      timestamp: Date.now()
    });
  }

  runtime.io.emit("phone:reconnect", {
    number,
    deviceId,
    code: sessionCode,
    timestamp: Date.now()
  });

  if (worker?.socketId && runtime.network.isSocketConnected(worker.socketId)) {
    runtime.io.to(worker.socketId).emit("session:reconnect_request", {
      number,
      deviceId,
      code: sessionCode
    });
    worker.connected = true;
    services.syncSessionPhoneState?.(session);
  }

  if (deviceId && /^(android-test-|TEST-|SIM-)/.test(deviceId)) {
    runtime.network.observe(sessionCode || "TEST01", worker || { id: deviceId, socketId: "sim-" + number }, { callState: "available" });
  }

  try {
    const updated = await runtime.network.snapshot();
    runtime.network.broadcast(updated);
  } catch { /* ignore */ }

  return { number, deviceId, sessionCode, success: true };
}

runtime.app.post("/api/network/equipment/:number/reconnect", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1 || number > 10) return res.status(404).json({ ok: false, error: "Equipo no encontrado." });
  try {
    const result = await attemptReconnectEquipment(number);
    const snapshot = await runtime.network.snapshot();
    res.json({ ok: true, result, equipment: snapshot.equipment[number - 1] });
  } catch {
    res.status(500).json({ ok: false, error: "No se pudo solicitar la reconexión del equipo." });
  }
});

runtime.app.post("/api/network/reconnect", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    let numbers = [];
    if (Array.isArray(req.body?.equipment) && req.body.equipment.length > 0) {
      numbers = [...new Set(req.body.equipment.map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= 10);
    } else {
      const snapshot = await runtime.network.snapshot();
      numbers = snapshot.equipment.filter(e => e.state === "Desconectado").map(e => e.number);
    }

    const results = [];
    for (const num of numbers) {
      results.push(await attemptReconnectEquipment(num));
    }

    const snapshot = await runtime.network.snapshot();
    res.json({ ok: true, reconnectedCount: results.length, numbers, results, snapshot });
  } catch {
    res.status(500).json({ ok: false, error: "No se pudo solicitar la reconexión de los equipos." });
  }
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
