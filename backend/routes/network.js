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
    const usersById = new Map(users.map(user => [String(user.id), user]));
    const activeCodes = rows.map(row => row.session_code).filter(Boolean);
    const booksByCode = new Map();
    if (activeCodes.length) {
      const [sessionRows] = await runtime.auth.pool.query(
        `SELECT id,data FROM sessions WHERE id IN (${activeCodes.map(() => "?").join(",")})`, activeCodes);
      for (const sessionRow of sessionRows) {
        const activeSession = runtime.sessions.get(sessionRow.id);
        const stored = typeof sessionRow.data === "string" ? JSON.parse(sessionRow.data) : sessionRow.data;
        booksByCode.set(sessionRow.id, activeSession?.contactBook || stored?.contactBook || null);
      }
    }
    for (const row of rows) {
      if (!row.session_code) continue;
      const book = booksByCode.get(row.session_code);
      if (!book) continue;
      const user = usersById.get(String(row.user_id));
      const counts = new Map();
      for (const contact of book.contacts || []) {
        const name = contact.list || "Principal";
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      const names = [...new Set([...(book.lists || []), ...counts.keys()])];
      user.lists = names.map(name => ({ name, count: counts.get(name) || 0 }));
    }
    const missingCodes = activeCodes.filter(code => !booksByCode.get(code)?.contacts?.length);
    if (missingCodes.length) {
      const [storedContacts] = await runtime.auth.pool.query(
        `SELECT session_code,list_name,COUNT(*) AS contact_count FROM vc_call_contacts
          WHERE session_code IN (${missingCodes.map(() => "?").join(",")}) GROUP BY session_code,list_name`, missingCodes);
      for (const row of storedContacts) {
        const account = rows.find(item => item.session_code === row.session_code);
        const user = account && usersById.get(String(account.user_id));
        if (!user) continue;
        const existing = user.lists.find(list => list.name === row.list_name);
        if (existing) existing.count = Math.max(existing.count, Number(row.contact_count));
        else user.lists.push({ name: row.list_name, count: Number(row.contact_count) });
      }
      const [campaignLists] = await runtime.auth.pool.query(
        `SELECT session_code,list_name FROM vc_call_campaigns
          WHERE session_code IN (${missingCodes.map(() => "?").join(",")})`, missingCodes);
      for (const row of campaignLists) {
        const account = rows.find(item => item.session_code === row.session_code);
        const user = account && usersById.get(String(account.user_id));
        if (user && !user.lists.some(list => list.name === row.list_name)) user.lists.push({ name: row.list_name, count: 0 });
      }
    }
    res.json({ ok: true, users });
  } catch {
    res.status(503).json({ ok: false, error: "No se pudieron cargar las listas de los usuarios." });
  }
});

runtime.app.get("/api/users/:id/contact-book", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const userId = Number(req.params.id);
  const listName = String(req.query.list || "").trim();
  const offset = Number(req.query.offset || 0);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
  if (!Number.isSafeInteger(userId) || userId < 1 || !listName || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit)) {
    return res.status(400).json({ ok: false, error: "Usuario, lista o página no válidos." });
  }
  try {
    const [rows] = await runtime.auth.pool.query(`SELECT u.username,w.session_code
      FROM auth_users u LEFT JOIN auth_user_workspaces w ON w.user_id=u.id WHERE u.id=?`, [userId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Usuario no encontrado." });
    let book = runtime.sessions.get(rows[0].session_code)?.contactBook;
    if (!book && rows[0].session_code) {
      const [sessionRows] = await runtime.auth.pool.query("SELECT data FROM sessions WHERE id=?", [rows[0].session_code]);
      const stored = sessionRows[0]?.data;
      book = stored ? (typeof stored === "string" ? JSON.parse(stored) : stored)?.contactBook : null;
    }
    if (book?.contacts?.length) {
      const contacts = book.contacts.filter(contact => (contact.list || "Principal") === listName);
      return res.json({ ok: true, username: rows[0].username, list: listName, total: contacts.length,
        contacts: contacts.slice(offset, offset + limit).map(({ name, phone, note }) => ({ name, phone, note })) });
    }
    const [contacts] = await runtime.auth.pool.query(
      `SELECT name,phone,'' AS note FROM vc_call_contacts WHERE session_code=? AND list_name=? ORDER BY name LIMIT ? OFFSET ?`,
      [rows[0].session_code, listName, limit, offset]);
    const [[{ total }]] = await runtime.auth.pool.query(
      "SELECT COUNT(*) AS total FROM vc_call_contacts WHERE session_code=? AND list_name=?", [rows[0].session_code, listName]);
    return res.json({ ok: true, username: rows[0].username, list: listName, total: Number(total), contacts });
  } catch {
    return res.status(503).json({ ok: false, error: "No se pudieron cargar los contactos de esta lista." });
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
