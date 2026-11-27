import path from "path";
import { randomUUID } from "node:crypto";
import { normalizeBook } from "../services/campaigns/contact-book.js";
import { collectUsedBaseFingerprints, mergeImportedContactBatches } from "../services/contacts/import-contact-book.js";
import { getContactByWorker, setWorkerPaused } from "../services/campaigns/campaign-manager.js";

/**
 * registerNetwork: conserva los contratos y reglas existentes.
 * Dependencias: runtime.__dirname, runtime.app, runtime.auth, runtime.network.
 * Se construye una vez por proceso.
 */
export function registerNetwork(runtime, services) {
runtime.app.get("/api/network/access", (req, res) => res.json({ ok: true, role: req.user.role }));

const limaYearMonth = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = parts.find(part => part.type === "year")?.value;
  const month = parts.find(part => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : null;
};

runtime.app.get("/api/users/lists", runtime.auth.requireAdmin, async (_, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const [rows] = await runtime.auth.pool.query(`SELECT u.id AS user_id,u.username,u.role,u.active,access.session_code
      FROM auth_users u
      LEFT JOIN (
        SELECT user_id,session_code FROM auth_user_workspaces
        UNION
        SELECT user_id,session_code FROM auth_session_access
      ) access ON access.user_id=u.id
      ORDER BY u.username,access.session_code`);
    const usersById = new Map();
    for (const row of rows) {
      const key = String(row.user_id);
      if (!usersById.has(key)) usersById.set(key, { id: row.user_id, username: row.username,
        role: row.role, active: Boolean(Number(row.active)), lists: [], _listsBySession: new Map() });
    }
    const users = [...usersById.values()];
    const activeCodes = [...new Set(rows.map(row => row.session_code).filter(Boolean))];
    const booksByCode = new Map(activeCodes.map(code => [code, runtime.sessions.get(code)?.contactBook]));
    for (const row of rows) {
      if (!row.session_code) continue;
      const book = booksByCode.get(row.session_code);
      if (!book) continue;
      const user = usersById.get(String(row.user_id));
      const counts = new Map();
      for (const contact of book.contacts || []) {
        const name = contact.list || "Principal";
        let list = user._listsBySession.get(name);
        if (!list) {
          list = { name, count: 0, monthlyCounts: {}, monthlyLastImportedAt: {}, lastImportedAt: null };
          user._listsBySession.set(name, list);
          user.lists.push(list);
        }
        list.count++;
        const createdAt = contact.createdAt || contact.created_at;
        const yearMonth = limaYearMonth(createdAt);
        if (yearMonth) {
          list.monthlyCounts[yearMonth] = (list.monthlyCounts[yearMonth] || 0) + 1;
          if (Number.isFinite(new Date(createdAt).getTime()) && (!list.monthlyLastImportedAt[yearMonth] || new Date(createdAt).getTime() > new Date(list.monthlyLastImportedAt[yearMonth]).getTime())) {
            list.monthlyLastImportedAt[yearMonth] = createdAt;
          }
        }
        const timestamp = createdAt ? new Date(createdAt).getTime() : NaN;
        if (Number.isFinite(timestamp) && (!list.lastImportedAt || timestamp > new Date(list.lastImportedAt).getTime())) list.lastImportedAt = createdAt;
        counts.set(name, (counts.get(name) || 0) + 1);
      }
      for (const name of new Set([...(book.lists || []), ...counts.keys()])) {
        const key = name;
        if (!user._listsBySession.has(key)) {
          const list = { name, count: counts.get(name) || 0, monthlyCounts: {}, monthlyLastImportedAt: {}, lastImportedAt: null };
          user._listsBySession.set(key, list);
          user.lists.push(list);
        }
      }
    }
    const missingCodes = activeCodes.filter(code => !booksByCode.get(code)?.contacts?.length);
    if (missingCodes.length) {
      const [monthlyStoredContacts] = await runtime.auth.pool.query(
        `SELECT session_code,list_name,
          DATE_FORMAT(DATE_SUB(STR_TO_DATE(SUBSTRING(JSON_UNQUOTE(JSON_EXTRACT(contact_data,'$.createdAt')),1,23),'%Y-%m-%dT%H:%i:%s.%f'),INTERVAL 5 HOUR),'%Y-%m') AS import_month,
          COUNT(*) AS contact_count,MAX(JSON_UNQUOTE(JSON_EXTRACT(contact_data,'$.createdAt'))) AS last_imported_at
          FROM vc_contact_book_contacts WHERE session_code IN (${missingCodes.map(() => "?").join(",")})
            AND JSON_EXTRACT(contact_data,'$.createdAt') IS NOT NULL
          GROUP BY session_code,list_name,import_month`, missingCodes);
      for (const row of monthlyStoredContacts) {
        if (!row.import_month) continue;
        const account = rows.find(item => item.session_code === row.session_code);
        const user = account && usersById.get(String(account.user_id));
        if (!user) continue;
        let list = user._listsBySession.get(row.list_name);
        if (!list) {
          list = { name: row.list_name, count: 0, monthlyCounts: {}, monthlyLastImportedAt: {}, lastImportedAt: null };
          user._listsBySession.set(row.list_name, list);
          user.lists.push(list);
        }
        list.monthlyCounts[row.import_month] = (list.monthlyCounts[row.import_month] || 0) + Number(row.contact_count);
        const currentDate = list.monthlyLastImportedAt[row.import_month];
        if (!currentDate || new Date(row.last_imported_at).getTime() > new Date(currentDate).getTime()) {
          list.monthlyLastImportedAt[row.import_month] = row.last_imported_at;
        }
        if (!list.lastImportedAt || new Date(row.last_imported_at).getTime() > new Date(list.lastImportedAt).getTime()) list.lastImportedAt = row.last_imported_at;
      }
      const [storedContacts] = await runtime.auth.pool.query(
        `SELECT session_code,list_name,COUNT(*) AS contact_count FROM vc_call_contacts
          WHERE session_code IN (${missingCodes.map(() => "?").join(",")}) GROUP BY session_code,list_name`, missingCodes);
      for (const row of storedContacts) {
        const account = rows.find(item => item.session_code === row.session_code);
        const user = account && usersById.get(String(account.user_id));
        if (!user) continue;
        const key = row.list_name;
        const existing = user._listsBySession.get(key);
        if (existing) existing.count += Number(row.contact_count);
        else {
          const list = { name: row.list_name, count: Number(row.contact_count), monthlyCounts: {}, monthlyLastImportedAt: {}, lastImportedAt: null };
          user._listsBySession.set(key, list);
          user.lists.push(list);
        }
      }
      const [campaignLists] = await runtime.auth.pool.query(
        `SELECT DISTINCT session_code,list_name FROM vc_call_campaigns
          WHERE session_code IN (${missingCodes.map(() => "?").join(",")})`, missingCodes);
      for (const row of campaignLists) {
        const account = rows.find(item => item.session_code === row.session_code);
        const user = account && usersById.get(String(account.user_id));
        if (user) {
          const key = row.list_name;
          if (!user._listsBySession.has(key)) {
            const list = { name: row.list_name, count: 0, monthlyCounts: {}, monthlyLastImportedAt: {}, lastImportedAt: null };
            user._listsBySession.set(key, list);
            user.lists.push(list);
          }
        }
      }
    }
    if (activeCodes.length) {
      const [assignments] = await runtime.auth.pool.query(
        `SELECT session_code,list_name,month_key,undated_contact_count,assigned_at
          FROM vc_contact_book_month_assignments
          WHERE session_code IN (${activeCodes.map(() => "?").join(",")})`, activeCodes);
      for (const row of assignments) {
        const account = rows.find(item => item.session_code === row.session_code);
        const user = account && usersById.get(String(account.user_id));
        if (!user) continue;
        let list = user._listsBySession.get(row.list_name);
        if (!list) {
          list = { name: row.list_name, count: 0, monthlyCounts: {}, monthlyLastImportedAt: {}, lastImportedAt: null };
          user._listsBySession.set(row.list_name, list);
          user.lists.push(list);
        }
        const month = String(row.month_key);
        list.monthlyCounts[month] = (list.monthlyCounts[month] || 0) + Number(row.undated_contact_count || 0);
        list.monthlyLastImportedAt[month] = row.assigned_at;
        list.monthlyEstimatedMonths ||= {};
        list.monthlyEstimatedMonths[month] = true;
        if (!list.lastImportedAt || new Date(row.assigned_at).getTime() > new Date(list.lastImportedAt).getTime()) list.lastImportedAt = row.assigned_at;
      }
    }
    for (const user of users) delete user._listsBySession;
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
  const year = Number(req.query.year || 0);
  const month = Number(req.query.month || 0);
  const filterMonth = Boolean(req.query.year || req.query.month);
  if (!Number.isSafeInteger(userId) || userId < 1 || !listName || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit)) {
    return res.status(400).json({ ok: false, error: "Usuario, lista o página no válidos." });
  }
  if (filterMonth && (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12)) {
    return res.status(400).json({ ok: false, error: "El mes solicitado no es válido." });
  }
  try {
    const [rows] = await runtime.auth.pool.query(`SELECT u.username,access.session_code
      FROM auth_users u LEFT JOIN (
        SELECT user_id,session_code FROM auth_user_workspaces WHERE user_id=?
        UNION
        SELECT user_id,session_code FROM auth_session_access WHERE user_id=?
      ) access ON access.user_id=u.id WHERE u.id=?`, [userId, userId, userId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Usuario no encontrado." });
    const sessionCodes = [...new Set(rows.map(row => row.session_code).filter(Boolean))];
    const books = new Map();
    for (const code of sessionCodes) {
      const book = runtime.sessions.get(code)?.contactBook;
      if (book) books.set(code, book);
    }
    const legacyMonth = filterMonth ? `${year}-${String(month).padStart(2, "0")}` : "";
    const [legacyAssignments] = filterMonth && sessionCodes.length
      ? await runtime.auth.pool.query(
        `SELECT session_code FROM vc_contact_book_month_assignments
          WHERE session_code IN (${sessionCodes.map(() => "?").join(",")}) AND list_name=? AND month_key=?`,
        [...sessionCodes, listName, legacyMonth])
      : [[]];
    const legacySessions = new Set(legacyAssignments.map(row => row.session_code));
    const contactsFromBooks = sessionCodes.flatMap(code => (books.get(code)?.contacts || [])
      .filter(contact => (contact.list || "Principal") === listName)
      .map(contact => ({ ...contact, __sessionCode: code })));
    if (contactsFromBooks.length) {
      const contacts = filterMonth
        ? contactsFromBooks.filter(contact => {
          const importedMonth = limaYearMonth(contact.createdAt || contact.created_at);
          return importedMonth === legacyMonth || (!importedMonth && legacySessions.has(contact.__sessionCode));
        })
        : contactsFromBooks;
      return res.json({ ok: true, username: rows[0].username, list: listName, total: contacts.length,
        contacts: contacts.slice(offset, offset + limit).map(({ name, phone, note, createdAt, created_at }) => ({ name, phone, note, createdAt: createdAt || created_at || null })) });
    }
    if (!sessionCodes.length) return res.json({ ok: true, username: rows[0].username, list: listName, total: 0, contacts: [] });
    if (filterMonth) {
      const monthStart = new Date(Date.UTC(year, month - 1, 1, 5)).toISOString();
      const monthEnd = new Date(Date.UTC(year, month, 1, 5)).toISOString();
      const legacyFilter = legacySessions.size > 0;
      const datedContact = `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(contact_data,'$.createdAt')),JSON_UNQUOTE(JSON_EXTRACT(contact_data,'$.created_at')))`;
      const legacySessionList = legacySessions.size ? [...legacySessions] : sessionCodes;
      const legacyPlaceholders = legacySessionList.map(() => "?").join(",");
      const monthPredicate = `(${datedContact}>=? AND ${datedContact}<?${legacyFilter
        ? ` OR (session_code IN (${legacyPlaceholders}) AND ${datedContact} IS NULL)` : ""})`;
      const [storedRows] = await runtime.auth.pool.query(
        `SELECT contact_data FROM vc_contact_book_contacts WHERE session_code IN (${sessionCodes.map(() => "?").join(",")}) AND list_name=?
          AND ${monthPredicate} ORDER BY position LIMIT ? OFFSET ?`,
        [...sessionCodes, listName, monthStart, monthEnd, ...(legacyFilter ? legacySessionList : []), limit, offset]);
      const contacts = storedRows.map(row => typeof row.contact_data === "string" ? JSON.parse(row.contact_data) : row.contact_data);
      const [[{ total }]] = await runtime.auth.pool.query(
        `SELECT COUNT(*) AS total FROM vc_contact_book_contacts WHERE session_code IN (${sessionCodes.map(() => "?").join(",")}) AND list_name=?
          AND ${monthPredicate}`,
        [...sessionCodes, listName, monthStart, monthEnd, ...(legacyFilter ? legacySessionList : [])]);
      return res.json({ ok: true, username: rows[0].username, list: listName, total: Number(total),
        contacts: contacts.map(({ name, phone, note, createdAt, created_at }) => ({ name, phone, note, createdAt: createdAt || created_at || null })) });
    }
    const [contacts] = await runtime.auth.pool.query(
      `SELECT name,phone,'' AS note FROM vc_call_contacts WHERE session_code IN (${sessionCodes.map(() => "?").join(",")}) AND list_name=? ORDER BY name LIMIT ? OFFSET ?`,
      [...sessionCodes, listName, limit, offset]);
    const [[{ total }]] = await runtime.auth.pool.query(
      `SELECT COUNT(*) AS total FROM vc_call_contacts WHERE session_code IN (${sessionCodes.map(() => "?").join(",")}) AND list_name=?`, [...sessionCodes, listName]);
    return res.json({ ok: true, username: rows[0].username, list: listName, total: Number(total), contacts });
  } catch {
    return res.status(503).json({ ok: false, error: "No se pudieron cargar los contactos de esta lista." });
  }
});

// Current user's contact book (for admin viewing their own lists)
runtime.app.get("/api/users/me/contact-book", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const listName = String(req.query.list || "").trim();
  const offset = Number(req.query.offset || 0);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
  if (!listName || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit)) {
    return res.status(400).json({ ok: false, error: "Lista o página no válidos." });
  }
  const userId = req.user.id;
  try {
    const [rows] = await runtime.auth.pool.query(`SELECT u.username,access.session_code
      FROM auth_users u LEFT JOIN (
        SELECT user_id,session_code FROM auth_user_workspaces WHERE user_id=?
        UNION
        SELECT user_id,session_code FROM auth_session_access WHERE user_id=?
      ) access ON access.user_id=u.id WHERE u.id=?`, [userId, userId, userId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Usuario no encontrado." });
    const sessionCodes = [...new Set(rows.map(row => row.session_code).filter(Boolean))];
    const books = new Map();
    for (const code of sessionCodes) {
      const book = runtime.sessions.get(code)?.contactBook;
      if (book) books.set(code, book);
    }
    const contactsFromBooks = sessionCodes.flatMap(code => (books.get(code)?.contacts || [])
      .filter(contact => (contact.list || "Principal") === listName));
    if (contactsFromBooks.length) {
      const contacts = contactsFromBooks;
      return res.json({ ok: true, username: rows[0].username, list: listName, total: contacts.length,
        contacts: contacts.slice(offset, offset + limit).map(({ name, phone, note, createdAt, created_at }) => ({ name, phone, note, createdAt: createdAt || created_at || null })) });
    }
    if (!sessionCodes.length) return res.json({ ok: true, username: rows[0].username, list: listName, total: 0, contacts: [] });
    const [contacts] = await runtime.auth.pool.query(
      `SELECT name,phone,'' AS note FROM vc_call_contacts WHERE session_code IN (${sessionCodes.map(() => "?").join(",")}) AND list_name=? ORDER BY name LIMIT ? OFFSET ?`,
      [...sessionCodes, listName, limit, offset]);
    const [[{ total }]] = await runtime.auth.pool.query(
      `SELECT COUNT(*) AS total FROM vc_call_contacts WHERE session_code IN (${sessionCodes.map(() => "?").join(",")}) AND list_name=?`, [...sessionCodes, listName]);
    return res.json({ ok: true, username: rows[0].username, list: listName, total: Number(total), contacts });
  } catch {
    return res.status(503).json({ ok: false, error: "No se pudieron cargar los contactos de esta lista." });
  }
});

// Admin bulk import contacts to a user's list
runtime.app.post("/api/users/:id/contact-book/import", runtime.auth.requireAdmin, async (req, res) => {
  const userId = Number(req.params.id);
  const listName = String(req.body?.list || "").trim() || "Principal";
  const contacts = req.body?.contacts;
  if (!Number.isSafeInteger(userId) || userId < 1 || !Array.isArray(contacts) || !contacts.length) {
    return res.status(400).json({ ok: false, error: "Usuario inválido o contactos requeridos." });
  }
  try {
    const [rows] = await runtime.auth.pool.query(`SELECT u.username,access.session_code
      FROM auth_users u LEFT JOIN (
        SELECT user_id,session_code FROM auth_user_workspaces WHERE user_id=?
        UNION
        SELECT user_id,session_code FROM auth_session_access WHERE user_id=?
      ) access ON access.user_id=u.id WHERE u.id=?`, [userId, userId, userId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Usuario no encontrado." });
    const sessionCodes = [...new Set(rows.map(row => row.session_code).filter(Boolean))];
    if (!sessionCodes.length) return res.status(404).json({ ok: false, error: "Usuario sin sesiones asociadas." });
    const code = sessionCodes[0];
    const session = runtime.sessions.get(code);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada." });
    const result = await runtime.historyGate.serialize(code, async () => {
      const merged = mergeImportedContactBatches(session.contactBook, [{ list: listName, contacts }], {
        annualBlocks: services.annualBlocks(),
        globallyBlocked: services.globalBlockedNumbers(),
        usedBases: collectUsedBaseFingerprints(runtime.sessions, code)
      });
      const summary = merged.batches[0];
      if (!summary.added) {
        const error = new Error(`No hay números nuevos para importar. ${summary.skippedCalled} ya fueron llamados, ${summary.skippedBlocked} están bloqueados y ${summary.skippedExcluded} pertenecen a servicios médicos, policiales, municipales o de emergencia excluidos.`);
        error.status = 422;
        throw error;
      }
      session.contactBook = normalizeBook(merged.book);
      session.contactBookRevision = Number(session.contactBookRevision || 0) + 1;
      session.updatedAt = Date.now();
      runtime.persistence.markContactBookDirty(code);
      await runtime.persistence.save(runtime.sessions, [code]);
      return { summary, total: session.contactBook.contacts.length, revision: session.contactBookRevision };
    });
    if (runtime.io) runtime.io.to(code).emit("contact-book:changed", { revision: result.revision });
    return res.json({ ok: true, ...result.summary, total: result.total, revision: result.revision });
  } catch (error) {
    return res.status(error.status || 503).json({ ok: false, error: error.message || "No se pudo importar la base." });
  }
});

// Admin get message contacts for a user
runtime.app.get("/api/users/:id/message-contacts", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId < 1) {
    return res.status(400).json({ ok: false, error: "Usuario inválido." });
  }
  try {
    const [rows] = await runtime.auth.pool.query(`SELECT u.username,access.session_code
      FROM auth_users u LEFT JOIN (
        SELECT user_id,session_code FROM auth_user_workspaces WHERE user_id=?
        UNION
        SELECT user_id,session_code FROM auth_session_access WHERE user_id=?
      ) access ON access.user_id=u.id WHERE u.id=?`, [userId, userId, userId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: "Usuario no encontrado." });
    const sessionCodes = [...new Set(rows.map(row => row.session_code).filter(Boolean))];
    const allContacts = [];
    for (const code of sessionCodes) {
      const session = runtime.sessions.get(code);
      if (session?.messageContacts?.length) {
        allContacts.push(...session.messageContacts.map(c => ({ ...c, sessionCode: code })));
      }
    }
    return res.json({ ok: true, username: rows[0].username, contacts: allContacts });
  } catch {
    return res.status(503).json({ ok: false, error: "No se pudieron cargar los contactos de mensajes." });
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
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw) || raw.split(",").length > 100) {
    return res.status(400).json({ ok: false, error: "Selecciona IDs de equipo válidos." });
  }
  const numbers = [...new Set(raw.split(",").map(Number))];
  try {
    const current = await runtime.network.snapshot();
    if (numbers.some(number => number > current.equipment.length)) return res.status(400).json({ ok: false, error: "Equipo fuera del rango actual." });
    const snapshot = await runtime.network.snapshot({ detailNumbers: numbers });
    res.json({ ok: true, equipment: snapshot.equipment.filter(item => numbers.includes(item.number)) });
  } catch { res.status(503).json({ ok: false, error: "No se pudo consultar la actividad." }); }
});

runtime.app.get("/api/network/equipment/:number", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const number = Number(req.params.number);
  if (!Number.isInteger(number) || number < 1 || number > 1000) return res.status(404).json({ ok: false, error: "Equipo no encontrado." });
  try {
    const snapshot = await runtime.network.snapshot({ detailNumbers: [number] });
    const equipment = snapshot.equipment.find(item => item.number === number);
    if (!equipment) return res.status(404).json({ ok: false, error: "Equipo no encontrado." });
    res.json({ ok: true, generatedAt: snapshot.generatedAt, equipment });
  } catch { res.status(503).json({ ok: false, error: "No se pudo consultar el equipo." }); }
});

function equipmentListTarget(deviceId) {
  const candidate = runtime.network.candidates().get(deviceId);
  if (!candidate) throw Object.assign(new Error("El teléfono ya no está vinculado."), { status: 409 });
  const { code, session, slot, worker } = candidate;
  if (!worker?.connected || !worker.socketId || !runtime.network.isSocketConnected(worker.socketId)) {
    throw Object.assign(new Error("El teléfono no está conectado."), { status: 409 });
  }
  if (["dialing", "ringing", "in_call"].includes(worker.callState) || getContactByWorker(session, deviceId)) {
    throw Object.assign(new Error("Espera a que el equipo termine su llamada antes de cambiar la lista."), { status: 409, reason: "CALL_ACTIVE" });
  }
  return { code, session, slot };
}

runtime.app.post("/api/network/equipment/:number/stop-for-list", runtime.auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || "");
    const snapshot = await runtime.network.snapshot();
    const item = snapshot.equipment.find(item => item.number === Number(req.params.number));
    if (!deviceId || item?.deviceId !== deviceId) return res.status(409).json({ ok: false, error: "El equipo cambió. Actualiza la página." });
    const target = runtime.network.candidates().get(deviceId);
    if (!target?.connected) return res.status(409).json({ ok: false, error: "El teléfono no está conectado." });
    await runtime.historyGate.serialize(target.code, async () => {
      const { code, session, worker } = runtime.network.candidates().get(deviceId) || {};
      if (!worker?.connected || !runtime.network.isSocketConnected(worker.socketId)) {
        throw Object.assign(new Error("El teléfono se desconectó."), { status: 409 });
      }
      const previousCampaign = structuredClone(session.campaign);
      setWorkerPaused(session, deviceId, true);
      try { await runtime.persistence.save(runtime.sessions, [code]); }
      catch (error) { session.campaign = previousCampaign; throw error; }
      const active = getContactByWorker(session, deviceId);
      if (active || ["dialing", "ringing", "in_call"].includes(worker.callState)) {
        runtime.io.to(worker.socketId).emit("call:action", {
          action: "hangup", from: "dashboard", contactId: active?.id || "", commandId: randomUUID()
        });
      }
      services.emitState(code);
      services.emitCampaignState(code);
    });
    res.json({ ok: true });
  } catch (error) { res.status(error.status || 503).json({ ok: false, error: error.message }); }
});

runtime.app.get("/api/network/equipment/:number/lists", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const snapshot = await runtime.network.snapshot();
    const item = snapshot.equipment.find(item => item.number === Number(req.params.number));
    if (!item?.deviceId) return res.status(404).json({ ok: false, error: "Equipo no vinculado." });
    const { session, slot } = equipmentListTarget(item.deviceId);
    const assignments = session.contactBook?.preferences?.pairingListAssignments || {};
    const lists = (session.contactBook?.lists || []).map(name => ({
      name,
      count: (session.contactBook.contacts || []).filter(c => (c.list || "Principal") === name).length,
      occupied: Object.entries(assignments).some(([id, list]) => id !== slot.id && list === name)
    })).filter(list => list.count > 0);
    res.json({ ok: true, deviceId: item.deviceId, currentList: assignments[slot.id] || "", lists });
  } catch (error) { res.status(error.status || 503).json({ ok: false, error: error.message, reason: error.reason }); }
});

runtime.app.post("/api/network/equipment/:number/lists", runtime.auth.requireAdmin, async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || "");
    const nextList = String(req.body?.list || "").trim();
    const snapshot = await runtime.network.snapshot();
    const item = snapshot.equipment.find(item => item.number === Number(req.params.number));
    if (!deviceId || item?.deviceId !== deviceId) return res.status(409).json({ ok: false, error: "El equipo cambió. Actualiza la página." });
    const target = equipmentListTarget(deviceId);
    await runtime.historyGate.serialize(target.code, async () => {
      const { code, session, slot } = equipmentListTarget(deviceId);
      const book = session.contactBook;
      if (!nextList || !book?.contacts?.some(c => (c.list || "Principal") === nextList)) {
        throw Object.assign(new Error("Selecciona una lista con contactos de esta cuenta."), { status: 400 });
      }
      const previousBook = structuredClone(book);
      const previousCampaign = structuredClone(session.campaign);
      const previousRevision = session.contactBookRevision;
      book.preferences ||= {};
      const assignments = { ...(book.preferences.pairingListAssignments || {}) };
      if (Object.entries(assignments).some(([id, list]) => id !== slot.id && list === nextList)) {
        throw Object.assign(new Error("Esa lista ya está asignada a otro equipo. Libérala primero desde Llamadas."), { status: 409 });
      }
      assignments[slot.id] = nextList;
      book.preferences.pairingListAssignments = assignments;
      setWorkerPaused(session, deviceId, true);
      // Al iniciar la nueva lista no debe retomar la cola anterior del teléfono.
      for (const contact of session.campaign.contacts) {
        if (contact.targetWorkerId !== deviceId || contact.list === nextList
            || ["completed", "failed", "awaiting_callback"].includes(contact.status)) continue;
        contact.targetWorkerId = "";
        if (contact.status === "held") contact.status = contact.attempts ? "retry_pending" : "pending";
        if (contact.assignedWorkerId === deviceId) {
          contact.assignedWorkerId = null;
          contact.assignedWorkerName = "";
          contact.currentAttemptId = "";
        }
      }
      session.contactBookRevision = Number(previousRevision || 0) + 1;
      runtime.persistence.markContactBookDirty(code);
      try { await runtime.persistence.save(runtime.sessions, [code]); }
      catch (error) {
        session.contactBook = previousBook;
        session.campaign = previousCampaign;
        session.contactBookRevision = previousRevision;
        runtime.persistence.markContactBookDirty(code);
        throw error;
      }
      services.emitState(code);
      services.emitCampaignState(code);
      runtime.io.to(code).emit("contact-book:changed", { revision: session.contactBookRevision });
    });
    const updated = await runtime.network.snapshot();
    runtime.network.broadcast(updated);
    res.json({ ok: true, snapshot: updated });
  } catch (error) { res.status(error.status || 503).json({ ok: false, error: error.message || "No se pudo cambiar la lista." }); }
});

runtime.app.post("/api/network/equipment/:number/position", runtime.auth.requireAdmin, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const fromNumber = Number(req.params.number);
  const toNumber = Number(req.body?.number);
  const deviceId = typeof req.body?.deviceId === "string" ? req.body.deviceId : "";
  if (!Number.isInteger(fromNumber) || fromNumber < 1 || fromNumber > 1000
      || !Number.isInteger(toNumber) || toNumber < 1 || toNumber > 255
      || !deviceId || deviceId.length > 191) {
    return res.status(400).json({ ok: false, error: "Número o ID de equipo no válido." });
  }
  try {
    const before = await runtime.network.snapshot();
    const source = before.equipment.find(item => item.number === fromNumber);
    if (!source?.deviceId || source.deviceId !== deviceId) {
      return res.status(409).json({ ok: false, error: "El equipo cambió desde que se cargó la página. Actualízala e inténtalo de nuevo." });
    }
    const snapshot = await runtime.network.movePosition(fromNumber, toNumber, deviceId);
    res.json({ ok: true, snapshot });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message || "No se pudo cambiar la posición del equipo." });
  }
});

async function attemptReconnectEquipment(number) {
  const row = runtime.network.registry.find(item => item.position === number);
  const candidates = runtime.network.candidates();
  let deviceId = row?.device_id || null;
  let sessionCode = row?.session_code || null;
  if (!row) {
    const registeredIds = new Set(runtime.network.registry.map(item => item.device_id));
    const unregistered = [...candidates.entries()]
      .filter(([id]) => !registeredIds.has(id))
      .sort(([left], [right]) => left.localeCompare(right));
    const firstVirtualPosition = Math.max(10, ...runtime.network.registry.map(item => Number(item.position) || 0)) + 1;
    const candidate = unregistered[number - firstVirtualPosition]?.[1];
    deviceId = candidate?.slot?.deviceId || null;
    sessionCode = candidate?.code || null;
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
  if (!Number.isInteger(number) || number < 1 || number > 1000) return res.status(404).json({ ok: false, error: "Equipo no encontrado." });
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
    const current = await runtime.network.snapshot();
    let numbers = [];
    if (Array.isArray(req.body?.equipment) && req.body.equipment.length > 0) {
      numbers = [...new Set(req.body.equipment.map(Number))].filter(n => Number.isInteger(n) && n >= 1 && n <= current.equipment.length);
    } else {
      numbers = current.equipment.filter(e => e.state === "Desconectado").map(e => e.number);
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
  res.sendFile(runtime.paths.dashboardPage);
});

runtime.app.get("/usuarios", runtime.auth.requireAdmin, (_, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(runtime.paths.dashboardPage);
});
}
