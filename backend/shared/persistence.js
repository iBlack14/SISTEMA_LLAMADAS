import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { collectCallAttempts, mergeAttempt, HISTORY_SCHEMA, writeCallAttempts } from "../services/calls/call-history.js";
import { phoneKey } from "../services/campaigns/contact-book.js";

const parseJson = value => typeof value === "string" ? JSON.parse(value) : value;
const keyOf = (code, row) => JSON.stringify([code, row.attemptId]);
const CONTACT_BOOK_MIGRATION_ID = "2026_11_19_normalize_contact_books_v1";
const SESSION_DATA_MIGRATION_ID = "2026_11_20_normalize_session_data_v1";

// Large, frequently rewritten collections stay in memory for the existing
// services/API, but are stored as independently updated MySQL rows.
const SHIFT_HISTORY_ENTITY_TYPES = new Set(["shift_history", "shift_report", "shift_unfinished"]);

export function splitSessionData(session = {}, { preserveShiftHistory = false } = {}) {
  const data = { ...session };
  delete data.dashboardSocketId; delete data.phoneSocketId; delete data.activePhoneSocketId; delete data.workerCursor;
  delete data.contactBook;
  const rows = [];
  const add = (type, id, position, value) => rows.push({ type, id: String(id || `${type}-${position}`), position, value });
  const campaign = data.campaign && { ...data.campaign };
  if (campaign) data.campaign = campaign;
  if (campaign) {
    for (const [position, contact] of (campaign.contacts || []).entries()) {
      const copy = { ...contact }; delete copy.attemptHistory;
      add("campaign_contact", contact.id, position, copy);
      for (const [i, attempt] of (contact.attemptHistory || []).entries()) add("campaign_attempt", `${contact.id}:${attempt.id}`, position * 1000 + i, { contactId: contact.id, attempt });
    }
    for (const [position, item] of (campaign.history || []).entries()) add("campaign_history", item.attemptId || position, position, item);
    delete campaign.contacts; delete campaign.history;
  }
  const shift = data.shiftManagement && { ...data.shiftManagement };
  if (shift) data.shiftManagement = shift;
  if (shift) {
    for (const field of ["pendingContacts", "currentReport", "closedContacts", "sessionHistory"]) {
      for (const [position, item] of (shift[field] || []).entries()) add(`shift_${field}`, item.id || item.attemptId || position, position, item);
      delete shift[field];
    }
    for (const [position, item] of (preserveShiftHistory ? [] : (shift.history || []).entries())) {
      const copy = { ...item }; delete copy.report; delete copy.unfinishedContacts;
      add("shift_history", item.id || position, position, copy);
      for (const [i, report] of (item.report || []).entries()) add("shift_report", `${item.id}:${report.attemptId || i}`, position * 100000 + i, report);
      for (const [i, contact] of (item.unfinishedContacts || []).entries()) add("shift_unfinished", `${item.id}:${contact.id || i}`, position * 100000 + i, contact);
    }
    delete shift.history;
  }
  for (const [position, archive] of (data.reportArchive || []).entries()) {
    const copy = { ...archive }; delete copy.contacts; delete copy.history;
    add("report_archive", archive.id || position, position, copy);
    for (const [i, contact] of (archive.contacts || []).entries()) add("archive_contact", `${archive.id}:${contact.id || i}`, position * 100000 + i, { archiveId: archive.id, contact });
    for (const [i, attempt] of (archive.history || []).entries()) add("archive_attempt", `${archive.id}:${attempt.attemptId || i}`, position * 100000 + i, { archiveId: archive.id, attempt });
  }
  if (Array.isArray(data.reportArchive)) data.reportArchive = [];
  return { data, rows };
}

export function hydrateSessionData(data, rows) {
  const session = structuredClone(data || {});
  const grouped = new Map();
  for (const row of rows || []) {
    const value = parseJson(row.row_data);
    if (!grouped.has(row.entity_type)) grouped.set(row.entity_type, []);
    grouped.get(row.entity_type).push({ entity_id: String(row.entity_id || ""), position: Number(row.position), value });
  }
    const entries = type => (grouped.get(type) || []).sort((a,b) => a.position - b.position);
    const list = type => entries(type).map(x => x.value);
  if (session.campaign) {
    const contacts = list("campaign_contact");
    const attempts = list("campaign_attempt");
    const byContact = new Map();
    for (const entry of attempts) { if (!byContact.has(entry.contactId)) byContact.set(entry.contactId, []); byContact.get(entry.contactId).push(entry.attempt); }
    for (const contact of contacts) contact.attemptHistory = byContact.get(contact.id) || [];
    session.campaign.contacts = contacts; session.campaign.history = list("campaign_history");
  }
  if (session.shiftManagement) {
    const shift = session.shiftManagement;
    for (const field of ["pendingContacts", "currentReport", "closedContacts", "sessionHistory"]) shift[field] = list(`shift_${field}`);
    const histories = list("shift_history");
    const reports = entries("shift_report"), unfinished = entries("shift_unfinished");
    const reportsByShift = new Map(), unfinishedByShift = new Map();
    const groupByShift = (source, target) => {
      for (const row of source) {
        const separator = row.entity_id.indexOf(":");
        const shiftId = separator < 0 ? row.entity_id : row.entity_id.slice(0, separator);
        if (!target.has(shiftId)) target.set(shiftId, []);
        target.get(shiftId).push(row.value);
      }
    };
    groupByShift(reports, reportsByShift);
    groupByShift(unfinished, unfinishedByShift);
    for (const item of histories) {
      item.report = reportsByShift.get(String(item.id)) || [];
      item.unfinishedContacts = unfinishedByShift.get(String(item.id)) || [];
    }
    shift.history = histories;
  }
  const archives = list("report_archive");
  if (archives.length || session.reportArchive) {
    const archiveContacts = new Map(), archiveAttempts = new Map();
    for (const row of list("archive_contact")) { if (!archiveContacts.has(row.archiveId)) archiveContacts.set(row.archiveId, []); archiveContacts.get(row.archiveId).push(row.contact); }
    for (const row of list("archive_attempt")) { if (!archiveAttempts.has(row.archiveId)) archiveAttempts.set(row.archiveId, []); archiveAttempts.get(row.archiveId).push(row.attempt); }
    for (const archive of archives) {
      archive.contacts = archiveContacts.get(archive.id) || [];
      archive.history = archiveAttempts.get(archive.id) || [];
    }
    session.reportArchive = archives;
  }
  return session;
}

function contactBookMetadata(book = {}) {
  const { contacts, ...metadata } = book;
  return metadata;
}

function contactBookRowValues(code, contact, position) {
  const id = String(contact.id || "").trim();
  const list = String(contact.list || "Principal");
  const phone = String(contact.phone || "");
  if (!id || id.length > 191 || list.length > 255 || phone.length > 64) {
    throw new Error("Un contacto excede los límites de la tabla normalizada.");
  }
  return [code, id, list, phone, position, JSON.stringify(contact)];
}

/** Session compatibility plus an independent, durable and replayable attempt ledger. */
export class SessionPersistence {
  constructor(filePath = "server/sessions.json", { env = process.env, poolFactory = mysql.createPool, databaseOnly = true } = {}) {
    this.databaseOnly = databaseOnly;
    this.filePath = path.resolve(filePath);
    this.historyPath = this.filePath + ".call-history.json";
    this.backupDir = path.resolve(env.CALL_BACKUP_DIR || path.join(path.dirname(this.filePath), "backups"));
this.env = env;
    this.poolFactory = poolFactory;
    this.poolConfig = {
      host: env.DB_HOST, port: Number(env.DB_PORT || 3306),
      user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
      waitForConnections: true, connectionLimit: Number(env.DB_POOL_LIMIT || 50), queueLimit: 0,
      connectTimeout: 10000, timezone: "Z",
      ...(env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {})
    };
    this.databaseConfigured = Boolean(env.DB_HOST && env.DB_USER && env.DB_NAME);
    this.pool = null;
    this.usingDb = false;
    this.schemaReady = false;
    this.pendingDatabase = false;
    this.saveChain = Promise.resolve();
    this.records = new Map();
    this.dirty = new Set();
    this.dirtySessions = new Set();
    this.dirtySessionVersions = new Map();
    this.attemptsRevision = 0;
    this.contactBookCache = new Map();
    this.normalizedContactBooks = new Set();
    this.dirtyContactBooks = new Set();
    this.contactBookVersions = new Map();
    this.contactBookStorageEnabled = false;
    this.sessionDataStorageEnabled = false;
    this.sessionEntityCache = new Map();
    this.sessionEntityTypesBySession = new Map();
    this.shiftHistorySourceRefs = new Map();
    this.lastSnapshot = {};
    this.lastError = "";
    this.storageFailed = false;
    this.lastWriteLogAt = 0;
    this.lastWriteLogSignature = "";
  }

  status() {
    return {
      mode: this.storageFailed ? "pending" : !this.databaseConfigured ? (this.databaseOnly ? "pending" : "local") : this.usingDb && !this.pendingDatabase ? "mysql" : "pending",
      databaseConfigured: this.databaseConfigured,
      pendingDatabase: this.pendingDatabase,
      attempts: this.records.size,
      lastError: this.lastError
    };
  }

  cacheSessionEntity(key, value) {
    this.sessionEntityCache.set(key, value);
    const [code, type] = JSON.parse(key);
    if (!this.sessionEntityTypesBySession.has(code)) this.sessionEntityTypesBySession.set(code, new Map());
    const byType = this.sessionEntityTypesBySession.get(code);
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(key);
  }

  forgetSessionEntity(key) {
    this.sessionEntityCache.delete(key);
    const [code, type] = JSON.parse(key);
    const byType = this.sessionEntityTypesBySession.get(code);
    byType?.get(type)?.delete(key);
    if (byType?.get(type)?.size === 0) byType.delete(type);
    if (byType?.size === 0) this.sessionEntityTypesBySession.delete(code);
  }

  async atomicJson(file, data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + "." + process.pid + ".tmp";
    try {
      const handle = await fs.open(temporary, "w", 0o600);
      try { await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
      if (process.platform !== "win32") {
        const directory = await fs.open(path.dirname(file), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }

  remember(code, incoming, dirty = true) {
    const key = keyOf(code, incoming);
    const previous = this.records.get(key);
    const row = mergeAttempt(previous?.row, incoming);
    if (JSON.stringify(previous?.row) !== JSON.stringify(row)) {
      this.records.set(key, { code, row });
      this.attemptsRevision += 1;
      if (dirty) this.dirty.add(key);
    }
  }

  async initDb() {
    if (!this.databaseConfigured) return false;
    try {
      if (!this.pool) this.pool = this.poolFactory(this.poolConfig);
      await this.pool.query("SELECT 1");
      if (!this.schemaReady) {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS sessions (
          id VARCHAR(50) PRIMARY KEY, data JSON NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        for (const ddl of HISTORY_SCHEMA) await this.pool.query(ddl);
        this.schemaReady = true;
      }
      this.usingDb = true;
      this.lastError = "";
      return true;
    } catch (error) {
      this.usingDb = false;
      this.lastError = error.code || "DATABASE_UNAVAILABLE";
      return false;
    }
  }

  async load() {
    if (this.databaseOnly && !this.databaseConfigured) throw new Error("Configura DB_HOST, DB_NAME y DB_USER en .env. MySQL es obligatorio.");
    const disk = this.databaseOnly ? null : await this.readJson(this.historyPath, null);
    if (disk && (disk.version !== 1 || !Array.isArray(disk.records))) {
      throw new Error("Formato de historial local no reconocido; no se sobrescribió.");
    }
    const local = this.databaseOnly ? {} : disk?.sessions || await this.readJson(this.filePath, {});
    this.pendingDatabase = this.databaseConfigured && Boolean(disk?.pendingDatabase);
    for (const entry of disk?.records || []) this.remember(entry.code, entry.row, this.pendingDatabase);
    let chosen = local;
    let loadSource = this.databaseOnly ? "mysql-empty" : "local";
    let mysqlSessionRows = null;
    if (await this.initDb()) {
      try {
        const [sessions] = await this.pool.query("SELECT id, data FROM sessions");
        const [attempts] = await this.pool.query("SELECT session_code, row_data FROM vc_call_attempts");
        const [bookMetadataRows] = await this.pool.query("SELECT session_code, revision, book_data FROM vc_contact_book_meta");
        const [bookContactRows] = await this.pool.query("SELECT session_code, contact_id, contact_data FROM vc_contact_book_contacts ORDER BY session_code,position,contact_id");
        const [[contactBookMigration]] = await this.pool.query(
          "SELECT migration_id FROM vc_schema_migrations WHERE migration_id=?", [CONTACT_BOOK_MIGRATION_ID]);
        this.contactBookStorageEnabled = Boolean(contactBookMigration);
        const [[sessionDataMigration]] = await this.pool.query(
          "SELECT migration_id FROM vc_schema_migrations WHERE migration_id=?", [SESSION_DATA_MIGRATION_ID]);
        this.sessionDataStorageEnabled = Boolean(sessionDataMigration);
        mysqlSessionRows = sessions.length;
        const remote = Object.fromEntries(sessions.map(row => [row.id, parseJson(row.data)]));
        if (this.sessionDataStorageEnabled) {
          const [entityRows] = await this.pool.query("SELECT session_code,entity_type,entity_id,position,row_data FROM vc_session_entities ORDER BY session_code,entity_type,position");
          const entitiesBySession = new Map();
          for (const row of entityRows) {
            if (!entitiesBySession.has(row.session_code)) entitiesBySession.set(row.session_code, []);
            entitiesBySession.get(row.session_code).push(row);
            this.cacheSessionEntity(JSON.stringify([row.session_code,row.entity_type,row.entity_id]), JSON.stringify([Number(row.position),parseJson(row.row_data)]));
          }
          for (const [code, data] of Object.entries(remote)) remote[code] = hydrateSessionData(data, entitiesBySession.get(code) || []);
        }
        // A pending local snapshot is an outbox and must be replayed, never discarded.
        chosen = this.pendingDatabase ? { ...remote, ...local } : sessions.length ? remote : local;
        loadSource = this.pendingDatabase ? "mysql+local-outbox" : sessions.length ? "mysql" : "mysql-empty";
        const bookMetadata = new Map(bookMetadataRows.map(row => [row.session_code, {
          revision: Number(row.revision || 0), data: parseJson(row.book_data)
        }]));
        const contactsBySession = new Map();
        for (const row of bookContactRows) {
          if (!contactsBySession.has(row.session_code)) contactsBySession.set(row.session_code, []);
          contactsBySession.get(row.session_code).push(parseJson(row.contact_data));
        }
        for (const [code, session] of Object.entries(chosen)) {
          if (this.sessionDataStorageEnabled) this.shiftHistorySourceRefs.set(code, session.shiftManagement?.history || null);
          const storedBook = bookMetadata.get(code);
          if (storedBook) {
            session.contactBook = {
              ...storedBook.data,
              contacts: contactsBySession.get(code) || []
            };
            session.contactBookRevision = storedBook.revision;
            this.normalizedContactBooks.add(code);
          }
          if (session.contactBook) this.contactBookCache.set(code, session.contactBook);
        }
        for (const entry of attempts) {
          const row = parseJson(entry.row_data);
          const key = keyOf(entry.session_code, row);
          if (this.pendingDatabase) {
            const localRow = this.records.get(key)?.row;
            this.remember(entry.session_code, row, false);
            if (localRow) this.remember(entry.session_code, localRow);
          } else this.remember(entry.session_code, row, false);
          if (JSON.stringify(this.records.get(key)?.row) !== JSON.stringify(row)) this.dirty.add(key);
        }
        // Preserve pre-migration database contents before the first backfill.
        if (!this.databaseOnly) await this.backup("before-migration", { version: 1, sessions: remote, records: attempts.map(entry => ({
          code: entry.session_code, row: parseJson(entry.row_data)
        })) });
        // Backfill local records missing from MySQL (idempotent on the primary key).
        const remoteKeys = new Set(attempts.map(entry => keyOf(entry.session_code, parseJson(entry.row_data))));
        for (const key of this.records.keys()) if (!remoteKeys.has(key)) this.dirty.add(key);
      } catch (error) {
        this.usingDb = false;
        this.lastError = error.code || "DATABASE_READ_FAILED";
        this.pendingDatabase = true;
        if (this.databaseOnly) throw error;
      }
    } else if (this.databaseConfigured) {
      this.pendingDatabase = true;
      if (this.databaseOnly) throw new Error("No se pudo conectar con MySQL: " + this.lastError);
    }

    this.lastSnapshot = chosen;
    const result = new Map();
    for (const [code, session] of Object.entries(chosen)) {
      for (const row of collectCallAttempts(session)) this.remember(code, row);
      if ([...this.records.values()].some(entry => entry.code === code)) session.hasCallHistory = true;
      result.set(code, this.cleanSessionOnLoad(session));
    }
    const summary = this.summarizeSessions(chosen);
    console.info(`[PERSISTENCE] Load source=${loadSource} mysqlTarget=${this.env.DB_HOST}:${Number(this.env.DB_PORT || 3306)}/${this.env.DB_NAME} mysqlRows=${mysqlSessionRows ?? "unavailable"} sessions=${summary.sessions} contactBooks=${summary.contactBooks} lists=${summary.lists} contacts=${summary.contacts} attempts=${this.records.size}`);
    return result;
  }

  async normalizeContactBooks(sessionsMap) {
    if (!this.databaseConfigured || !this.usingDb) throw new Error("La normalización de contactos requiere MySQL disponible.");
    const connection = await this.pool.getConnection();
    let sessionCount = 0;
    let contactCount = 0;
    const normalizedCodes = [];
    try {
      const [[applied]] = await connection.query(
        "SELECT migration_id FROM vc_schema_migrations WHERE migration_id=?", [CONTACT_BOOK_MIGRATION_ID]);
      if (applied) {
        this.contactBookStorageEnabled = true;
        return { applied: false, sessions: 0, contacts: 0 };
      }
      if (this.env.CONTACT_BOOK_MIGRATION_BACKUP_VERIFIED !== "1") {
        throw new Error("Confirma una copia externa restaurable con CONTACT_BOOK_MIGRATION_BACKUP_VERIFIED=1 antes de migrar.");
      }

      await connection.beginTransaction();
      for (const [code, session] of sessionsMap) {
        const book = session?.contactBook;
        if (!book || !Array.isArray(book.contacts)) continue;
        if (!this.normalizedContactBooks.has(code)) {
          const metadata = contactBookMetadata(book);
          await connection.query(
            `INSERT INTO vc_contact_book_meta (session_code,revision,book_data) VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE revision=VALUES(revision),book_data=VALUES(book_data)`,
            [code, Number(session.contactBookRevision || 0), JSON.stringify(metadata)]);
          await connection.query("DELETE FROM vc_contact_book_contacts WHERE session_code=?", [code]);
          const contacts = book.contacts;
          for (let offset = 0; offset < contacts.length; offset += 200) {
            const batch = contacts.slice(offset, offset + 200);
            if (!batch.length) continue;
            const values = batch.flatMap((contact, index) => contactBookRowValues(code, contact, offset + index));
            const placeholders = batch.map(() => "(?,?,?,?,?,?)").join(",");
            await connection.query(
              `INSERT INTO vc_contact_book_contacts (session_code,contact_id,list_name,phone,position,contact_data) VALUES ${placeholders}`,
              values);
          }
          normalizedCodes.push(code);
          sessionCount++;
          contactCount += contacts.length;
        }

        const [[storedCount]] = await connection.query(
          "SELECT COUNT(*) AS count FROM vc_contact_book_contacts WHERE session_code=?", [code]);
        if (Number(storedCount.count) !== book.contacts.length) {
          throw new Error(`La sesión ${code} no pasó la validación de cantidad de contactos.`);
        }

        const { contactBook, dashboardSocketId, phoneSocketId, activePhoneSocketId, workerCursor, ...sessionData } = session;
        const serialized = JSON.stringify(sessionData);
        const [updated] = await connection.query("UPDATE sessions SET data=? WHERE id=?", [serialized, code]);
        if (!updated.affectedRows) {
          await connection.query("INSERT INTO sessions (id,data) VALUES (?,?)", [code, serialized]);
        }
      }
      await connection.query("INSERT INTO vc_schema_migrations (migration_id) VALUES (?)", [CONTACT_BOOK_MIGRATION_ID]);
      await connection.commit();
      for (const code of normalizedCodes) {
        this.normalizedContactBooks.add(code);
        this.contactBookCache.set(code, sessionsMap.get(code).contactBook);
      }
      this.contactBookStorageEnabled = true;
      console.info(`[CONTACT_BOOK_MIGRATION] applied sessions=${sessionCount} contacts=${contactCount}`);
      return { applied: true, sessions: sessionCount, contacts: contactCount };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async normalizeSessionData(sessionsMap) {
    if (!this.databaseConfigured || !this.usingDb) throw new Error("La normalización requiere MySQL disponible.");
    if (this.env.SESSION_DATA_MIGRATION_BACKUP_VERIFIED !== "1") throw new Error("Confirma una copia externa restaurable con SESSION_DATA_MIGRATION_BACKUP_VERIFIED=1 antes de migrar.");
    const connection = await this.pool.getConnection();
    let sessions = 0, entities = 0;
    try {
      const [[applied]] = await connection.query("SELECT migration_id FROM vc_schema_migrations WHERE migration_id=?", [SESSION_DATA_MIGRATION_ID]);
      if (applied) { this.sessionDataStorageEnabled = true; return { applied: false, sessions: 0, entities: 0 }; }
      await connection.beginTransaction();
      for (const [code, session] of sessionsMap) {
        const { data, rows } = splitSessionData(session);
        if (!this.contactBookStorageEnabled && session.contactBook) data.contactBook = session.contactBook;
        await connection.query("DELETE FROM vc_session_entities WHERE session_code=?", [code]);
        for (const row of rows) {
          if (row.type.length > 48 || row.id.length > 191 || row.position < 0 || row.position > 4294967295) {
            throw new Error(`Entidad fuera de límites en sesión ${code}: ${row.type}/${row.id.slice(0,40)}.`);
          }
          await connection.query("INSERT INTO vc_session_entities(session_code,entity_type,entity_id,position,row_data) VALUES(?,?,?,?,?)",
            [code,row.type,row.id,row.position,JSON.stringify(row.value)]);
          entities++;
        }
        await connection.query("UPDATE sessions SET data=? WHERE id=?", [JSON.stringify(data),code]);
        sessions++;
      }
      await connection.query("INSERT INTO vc_schema_migrations(migration_id) VALUES(?)", [SESSION_DATA_MIGRATION_ID]);
      await connection.commit();
      this.sessionDataStorageEnabled = true;
      for (const [code, session] of sessionsMap) {
        for (const row of splitSessionData(session).rows) this.cacheSessionEntity(JSON.stringify([code,row.type,row.id]), JSON.stringify([row.position,row.value]));
        this.shiftHistorySourceRefs.set(code, session.shiftManagement?.history || null);
      }
      console.info(`[SESSION_DATA_MIGRATION] applied sessions=${sessions} entities=${entities}`);
      return { applied: true, sessions, entities };
    } catch (error) { await connection.rollback().catch(() => {}); throw error; }
    finally { connection.release(); }
  }

  async restoreSessionDataToJson() {
    if (!this.databaseConfigured || !this.usingDb) throw new Error("La reversión requiere MySQL disponible.");
    if (this.env.SESSION_DATA_MIGRATION_BACKUP_VERIFIED !== "1") throw new Error("Confirma una copia externa antes de revertir.");
    const connection = await this.pool.getConnection();
    try {
      const [[applied]] = await connection.query("SELECT migration_id FROM vc_schema_migrations WHERE migration_id=?", [SESSION_DATA_MIGRATION_ID]);
      if (!applied) return { restored: 0 };
      const [sessions] = await connection.query("SELECT id,data FROM sessions");
      const [entities] = await connection.query("SELECT session_code,entity_type,entity_id,position,row_data FROM vc_session_entities ORDER BY session_code,entity_type,position");
      const bySession = new Map();
      for (const row of entities) { if (!bySession.has(row.session_code)) bySession.set(row.session_code, []); bySession.get(row.session_code).push(row); }
      await connection.beginTransaction();
      for (const row of sessions) {
        const hydrated = hydrateSessionData(parseJson(row.data), bySession.get(row.id) || []);
        await connection.query("UPDATE sessions SET data=? WHERE id=?", [JSON.stringify(hydrated),row.id]);
      }
      await connection.query("DELETE FROM vc_session_entities");
      await connection.query("DELETE FROM vc_schema_migrations WHERE migration_id=?", [SESSION_DATA_MIGRATION_ID]);
      await connection.commit();
      this.sessionDataStorageEnabled = false;
      this.sessionEntityCache.clear();
      this.sessionEntityTypesBySession.clear();
      this.shiftHistorySourceRefs.clear();
      return { restored: sessions.length };
    } catch (error) { await connection.rollback().catch(() => {}); throw error; }
    finally { connection.release(); }
  }

  async restoreContactBooksToSessionJson() {
    if (!this.databaseConfigured || !this.usingDb) throw new Error("La reversión requiere MySQL disponible.");
    const connection = await this.pool.getConnection();
    let restored = 0;
    try {
      const [sessions] = await connection.query("SELECT id,data FROM sessions");
      const [metadataRows] = await connection.query("SELECT session_code,revision,book_data FROM vc_contact_book_meta");
      const [contactRows] = await connection.query("SELECT session_code,contact_data FROM vc_contact_book_contacts ORDER BY session_code,position,contact_id");
      const metadata = new Map(metadataRows.map(row => [row.session_code, {
        revision: Number(row.revision || 0), book: parseJson(row.book_data)
      }]));
      const contacts = new Map();
      for (const row of contactRows) {
        if (!contacts.has(row.session_code)) contacts.set(row.session_code, []);
        contacts.get(row.session_code).push(parseJson(row.contact_data));
      }
      await connection.beginTransaction();
      for (const row of sessions) {
        const entry = metadata.get(row.id);
        if (!entry) continue;
        const session = parseJson(row.data) || {};
        session.contactBook = { ...entry.book, contacts: contacts.get(row.id) || [] };
        session.contactBookRevision = entry.revision;
        await connection.query("UPDATE sessions SET data=? WHERE id=?", [JSON.stringify(session), row.id]);
        restored++;
      }
      await connection.query("DELETE FROM vc_contact_book_contacts");
      await connection.query("DELETE FROM vc_contact_book_meta");
      await connection.query("DELETE FROM vc_schema_migrations WHERE migration_id=?", [CONTACT_BOOK_MIGRATION_ID]);
      await connection.commit();
      return { restored };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  summarizeSessions(snapshot = {}) {
    const sessions = Object.values(snapshot || {});
    return sessions.reduce((summary, session) => {
      const book = session?.contactBook;
      if (book) {
        summary.contactBooks += 1;
        summary.lists += Array.isArray(book.lists) ? book.lists.length : 0;
        summary.contacts += Array.isArray(book.contacts) ? book.contacts.length : 0;
      }
      summary.sessions += 1;
      return summary;
    }, { sessions: 0, contactBooks: 0, lists: 0, contacts: 0 });
  }

  cleanSessionOnLoad(session) {
    const rawProcessed = session.processedCallIds;
    let processedCallIds;
    if (rawProcessed instanceof Set) processedCallIds = new Set(rawProcessed);
    else if (Array.isArray(rawProcessed)) processedCallIds = new Set(rawProcessed);
    else if (rawProcessed && typeof rawProcessed === "object") processedCallIds = new Set(Object.keys(rawProcessed));
    else processedCallIds = new Set();
    return {
      ...session, dashboardSocketId: null, phoneSocketId: null, activePhoneSocketId: null,
      processedCallIds,
      phoneWorkers: (session.phoneWorkers || []).map(worker => ({
        ...worker, socketId: null, connected: false, callState: "idle"
      }))
    };
  }

  save(sessionsMap, changedCodes = null) {
    // Capture immediately, before another reset/delete can mutate the live Map.
    const snapshotStartedAt = Date.now();
    const snapshot = {};
    const snapshotJson = {};
    const contactBooks = {};
    const contactBookRevisions = {};
    const contactBookVersions = new Map();
    const sessionEntities = {};
    const preservedEntityTypes = {};
    const shiftHistorySources = {};
    let snapshotBytes = 0;
    const codesToSave = changedCodes ? new Set(changedCodes) : null;
    for (const [code, session] of sessionsMap) {
      if (codesToSave && !codesToSave.has(code)) continue;
      if (collectCallAttempts(session).length) session.hasCallHistory = true;
      const { dashboardSocketId, phoneSocketId, activePhoneSocketId, workerCursor, contactBook, ...rawData } = session;
      let data = rawData;
      if (this.sessionDataStorageEnabled) {
        const historyRef = session.shiftManagement?.history || null;
        const preserveShiftHistory = historyRef !== null && this.shiftHistorySourceRefs.get(code) === historyRef;
        const split = splitSessionData(session, { preserveShiftHistory });
        data = split.data;
        sessionEntities[code] = split.rows;
        preservedEntityTypes[code] = preserveShiftHistory ? [...SHIFT_HISTORY_ENTITY_TYPES] : [];
        shiftHistorySources[code] = historyRef;
      }
      if (contactBook && (!this.databaseOnly || !this.contactBookStorageEnabled)) {
        this.contactBookCache.set(code, contactBook);
      }
      const normalizedBook = this.databaseOnly && this.contactBookStorageEnabled && Boolean(contactBook) &&
        (this.normalizedContactBooks.has(code) || this.dirtyContactBooks.has(code));
      if (normalizedBook) {
        if (this.dirtyContactBooks.has(code)) {
          contactBooks[code] = JSON.parse(JSON.stringify(contactBook));
          contactBookRevisions[code] = Number(session.contactBookRevision || 0);
          contactBookVersions.set(code, this.contactBookVersions.get(code) || 0);
        }
      } else if (contactBook) {
        data.contactBook = contactBook;
      }
      const serialized = JSON.stringify(data);
      snapshotJson[code] = serialized;
      snapshotBytes += Buffer.byteLength(serialized);
      snapshot[code] = JSON.parse(serialized);
    }
    const snapshotBuildMs = Date.now() - snapshotStartedAt;
    const dirtyVersions = new Map(Object.keys(snapshot)
      .filter(code => this.dirtySessions.has(code))
      .map(code => [code, this.dirtySessionVersions.get(code) || 0]));
    const queuedAt = Date.now();
    const operation = this.saveChain.then(() => this.saveNow(snapshot, changedCodes, {
      snapshotJson,
      sessionEntities,
      preservedEntityTypes,
      shiftHistorySources,
      contactBooks,
      contactBookRevisions,
      snapshotBytes,
      snapshotBuildMs,
      queueWaitMs: Date.now() - queuedAt
    })).then(result => {
      this.storageFailed = false;
      this.lastError = "";
      for (const [code, book] of Object.entries(contactBooks)) {
        this.normalizedContactBooks.add(code);
        this.contactBookCache.set(code, book);
      }
      for (const [code, version] of contactBookVersions) {
        if (this.contactBookVersions.get(code) === version) this.dirtyContactBooks.delete(code);
      }
      for (const [code, version] of dirtyVersions) {
        if (this.dirtySessionVersions.get(code) === version) this.dirtySessions.delete(code);
      }
      return result;
    }, error => {
      this.storageFailed = true;
      this.lastError = error.code || "STORAGE_WRITE_FAILED";
      throw error;
    });
    // A failed save rejects its caller, but cannot permanently poison future retries.
    this.saveChain = operation.catch(() => {});
    return operation;
  }

  markSessionDirty(code) {
    // Track which sessions have pending changes for targeted saves
    this.dirtySessions.add(code);
    this.dirtySessionVersions.set(code, (this.dirtySessionVersions.get(code) || 0) + 1);
  }

  markContactBookDirty(code) {
    this.dirtyContactBooks.add(code);
    this.contactBookVersions.set(code, (this.contactBookVersions.get(code) || 0) + 1);
  }

  getDirtySessions() {
    const dirty = this.dirtySessions;
    this.dirtySessions = new Set();
    return dirty;
  }

  getPendingSessionCodes() {
    const codes = new Set([...this.dirtySessions, ...this.dirtyContactBooks]);
    for (const key of this.dirty) {
      const entry = this.records.get(key);
      if (entry?.code) codes.add(entry.code);
    }
    return [...codes];
  }

  async saveNow(snapshot, changedCodes = null, metrics = {}) {
    for (const [code, session] of Object.entries(snapshot)) {
      for (const row of collectCallAttempts(session)) this.remember(code, row);
    }
    this.lastSnapshot = snapshot;
    if (this.databaseConfigured) this.pendingDatabase = true;
    if (this.databaseOnly && !this.databaseConfigured) throw new Error("MySQL es obligatorio; configura DB_HOST, DB_NAME y DB_USER.");
    // Local files are used only by explicit legacy import and test fixtures.
    if (!this.databaseOnly) {
    await this.atomicJson(this.historyPath, {
      version: 1, pendingDatabase: this.pendingDatabase, sessions: snapshot,
      records: [...this.records.values()]
    });
    await this.atomicJson(this.filePath, snapshot);
    }
    if (!this.databaseConfigured) return { committed: true, mode: "local" };
    if (!await this.initDb()) throw new Error("MySQL no disponible; guardado pendiente.");
    const connection = await this.pool.getConnection();
    const changed = [...this.dirty];
    const entityCacheChanges = new Map();
    const entityCacheDeletes = new Set();
    try {
      await connection.beginTransaction();
      for (const [code, book] of Object.entries(metrics.contactBooks || {})) {
        const metadata = contactBookMetadata(book);
        await connection.query(
          `INSERT INTO vc_contact_book_meta (session_code,revision,book_data) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE revision=VALUES(revision),book_data=VALUES(book_data)`,
          [code, Number(metrics.contactBookRevisions?.[code] || 0), JSON.stringify(metadata)]);
        await connection.query("DELETE FROM vc_contact_book_contacts WHERE session_code=?", [code]);
        for (let offset = 0; offset < book.contacts.length; offset += 200) {
          const batch = book.contacts.slice(offset, offset + 200);
          if (!batch.length) continue;
          const values = batch.flatMap((contact, index) => contactBookRowValues(code, contact, offset + index));
          const placeholders = batch.map(() => "(?,?,?,?,?,?)").join(",");
          await connection.query(
            `INSERT INTO vc_contact_book_contacts (session_code,contact_id,list_name,phone,position,contact_data) VALUES ${placeholders}`,
            values);
        }
      }
      // Only update sessions that actually changed
      const codesToUpdate = changedCodes ? new Set(changedCodes) : new Set(Object.keys(snapshot));
      for (const [code, data] of Object.entries(snapshot)) {
        if (!codesToUpdate.has(code)) continue;
        if (this.sessionDataStorageEnabled) {
          const rows = metrics.sessionEntities?.[code] || [];
          const currentKeysByType = new Map();
          for (const row of rows) {
            const key = JSON.stringify([code,row.type,row.id]);
            if (row.type.length > 48 || row.id.length > 191 || row.position < 0 || row.position > 4294967295) {
              throw new Error(`Entidad fuera de límites en sesión ${code}: ${row.type}/${row.id.slice(0,40)}.`);
            }
            if (!currentKeysByType.has(row.type)) currentKeysByType.set(row.type, new Set());
            currentKeysByType.get(row.type).add(key);
            const serialized = JSON.stringify(row.value);
            const cached = JSON.stringify([row.position,row.value]);
            if (this.sessionEntityCache.get(key) === cached) continue;
            await connection.query(`INSERT INTO vc_session_entities(session_code,entity_type,entity_id,position,row_data)
              VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE position=VALUES(position),row_data=VALUES(row_data)`,
              [code,row.type,row.id,row.position,serialized]);
            entityCacheChanges.set(key,cached);
          }
          const preserved = new Set(metrics.preservedEntityTypes?.[code] || []);
          for (const [type, existingKeys] of this.sessionEntityTypesBySession.get(code) || []) {
            if (preserved.has(type)) continue;
            const currentKeys = currentKeysByType.get(type) || new Set();
            for (const key of existingKeys) {
              if (currentKeys.has(key)) continue;
              const parsed = JSON.parse(key);
              await connection.query("DELETE FROM vc_session_entities WHERE session_code=? AND entity_type=? AND entity_id=?", parsed);
              entityCacheDeletes.add(key);
            }
          }
        }
        const [existing] = await connection.query(
          "SELECT data FROM sessions WHERE id=?", [code]);
        const existingData = existing[0]?.data;
        if (existingData && JSON.stringify(existingData) === metrics.snapshotJson?.[code]) continue;
        await connection.query(
          "INSERT INTO sessions (id,data) VALUES (?,?) ON DUPLICATE KEY UPDATE data=VALUES(data)",
          [code, JSON.stringify(data)]);
      }
      const bySession = new Map();
      for (const key of changed) {
        const entry = this.records.get(key);
        if (!entry) continue;
        if (!bySession.has(entry.code)) bySession.set(entry.code, []);
        bySession.get(entry.code).push(entry.row);
      }
      for (const [code, rows] of bySession) await writeCallAttempts(connection, code, rows);
      await connection.commit();
      for (const key of entityCacheDeletes) this.forgetSessionEntity(key);
      for (const [key,value] of entityCacheChanges) this.cacheSessionEntity(key,value);
      for (const [code, ref] of Object.entries(metrics.shiftHistorySources || {})) this.shiftHistorySourceRefs.set(code,ref);
      for (const key of changed) this.dirty.delete(key);
      this.pendingDatabase = false;
      this.usingDb = true;
      this.lastError = "";
      const summary = this.summarizeSessions(snapshot);
      const logSignature = `${summary.sessions}:${summary.contactBooks}:${summary.lists}:${summary.contacts}:${this.records.size}`;
      const now = Date.now();
      if (logSignature !== this.lastWriteLogSignature || now - this.lastWriteLogAt >= 30000) {
        console.info(`[PERSISTENCE] MySQL snapshot committed target=${this.env.DB_HOST}:${Number(this.env.DB_PORT || 3306)}/${this.env.DB_NAME} sessions=${summary.sessions} contactBooks=${summary.contactBooks} lists=${summary.lists} contacts=${summary.contacts} attempts=${this.records.size} snapshotBytes=${metrics.snapshotBytes || 0} snapshotBuildMs=${metrics.snapshotBuildMs || 0} queueWaitMs=${metrics.queueWaitMs || 0}`);
        this.lastWriteLogSignature = logSignature;
        this.lastWriteLogAt = now;
      }
      if (!this.databaseOnly) await this.atomicJson(this.historyPath, {
        version: 1, pendingDatabase: false, sessions: snapshot, records: [...this.records.values()]
      });
      return { committed: true, mode: "mysql" };
    } catch (error) {
      await connection.rollback().catch(() => {});
      this.usingDb = false;
      this.pendingDatabase = true;
      this.lastError = error.code || "DATABASE_WRITE_FAILED";
      throw error;
    } finally { connection.release(); }
  }

  hasFinishedAttempt(code, attemptId, contactId) {
    const row = this.records.get(JSON.stringify([code, attemptId]))?.row;
    return Boolean(row?.endedAt && row.contactId === contactId);
  }

  async getCallAttemptsForSessions(codes, shiftIds = null) {
    await this.saveChain;
    if (this.storageFailed || (this.databaseConfigured && (!this.usingDb || this.pendingDatabase))) {
      throw new Error("No se puede confirmar el historial mientras hay guardados pendientes.");
    }
    const unique = [...new Set(codes)];
    const grouped = new Map(unique.map(code => [code, []]));
    if (!unique.length) return grouped;
    if (this.databaseConfigured) {
      const scoped = shiftIds instanceof Map && unique.every(code => shiftIds.has(code));
      const where = scoped
        ? unique.map(() => "(session_code=? AND shift_id=?)").join(" OR ")
        : `session_code IN (${unique.map(() => "?").join(",")})`;
      const values = scoped ? unique.flatMap(code => [code, shiftIds.get(code)]) : unique;
      const [rows] = await this.pool.query(
        `SELECT session_code,row_data FROM vc_call_attempts WHERE ${where} ORDER BY started_at,attempt_id`, values);
      for (const entry of rows) grouped.get(entry.session_code)?.push(parseJson(entry.row_data));
    } else {
      for (const entry of this.records.values()) {
        if (!grouped.has(entry.code)) continue;
        if (shiftIds instanceof Map && shiftIds.has(entry.code) && entry.row.shiftId !== shiftIds.get(entry.code)) continue;
        grouped.get(entry.code).push({ ...entry.row });
      }
    }
    return grouped;
  }

  async getCallAttempts(code, { from = "", to = "", phone = "" } = {}) {
    await this.saveChain;
    if (this.storageFailed) throw new Error("Hay escrituras pendientes; no se puede confirmar el historial completo.");
    if (this.databaseConfigured) {
      if (!this.usingDb || this.pendingDatabase) {
        throw new Error("MySQL tiene escrituras pendientes; no se puede confirmar el historial completo.");
      }
      const clauses = ["session_code=?"];
      const values = [code];
      if (from) { clauses.push("report_date>=?"); values.push(from); }
      if (to) { clauses.push("report_date<=?"); values.push(to); }
      if (phone) { clauses.push("phone=?"); values.push(phone); }
      const [rows] = await this.pool.query(
        "SELECT row_data FROM vc_call_attempts WHERE " + clauses.join(" AND ") + " ORDER BY started_at,attempt_id", values);
      return rows.map(row => parseJson(row.row_data));
    }
    return [...this.records.values()].filter(entry => entry.code === code).map(entry => ({ ...entry.row }))
      .filter(row => (!from || row.reportDate >= from) && (!to || row.reportDate <= to) && (!phone || row.phone === phone))
      .sort((a,b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
  }

  async getContactProgress(code) {
    await this.saveChain;
    if (this.storageFailed) throw new Error("Hay escrituras pendientes; no se puede confirmar el progreso.");
    if (this.databaseConfigured && (!this.usingDb || this.pendingDatabase)) {
      throw new Error("MySQL tiene escrituras pendientes; no se puede confirmar el progreso.");
    }
    const progress = new Map();
    const add = row => {
      const phone = phoneKey(row.phone);
      if (!phone) return;
      const state = progress.get(phone) || { count: 0, duration: 0, result: "" };
      state.count += 1;
      state.duration += Number(row.durationSeconds || 0);
      state.result = row.technicalResult || state.result;
      progress.set(phone, state);
    };
    if (this.databaseConfigured) {
      const [rows] = await this.pool.query(
        `SELECT phone,connected_seconds AS durationSeconds,technical_result AS technicalResult
         FROM vc_call_attempts WHERE session_code=? ORDER BY started_at,attempt_id`, [code]);
      for (const row of rows) add(row);
    } else {
      for (const entry of this.records.values()) if (entry.code === code) add(entry.row);
    }
    return progress;
  }

  async backup(label = "daily", payload = null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(this.backupDir, "call-history-" + stamp + "-" + label + ".json");
    let sessions = structuredClone(this.lastSnapshot);
    if (this.sessionDataStorageEnabled) {
      sessions = Object.fromEntries(Object.entries(sessions).map(([code, data]) => {
        const rows = [];
        for (const [key, serialized] of this.sessionEntityCache) {
          const [sessionCode, entity_type, entity_id] = JSON.parse(key);
          if (sessionCode !== code) continue;
          const [position, row_data] = JSON.parse(serialized);
          rows.push({ entity_type, entity_id, row_data, position });
        }
        return [code, hydrateSessionData(data, rows)];
      }));
    }
    for (const [code, book] of this.contactBookCache) {
      if (sessions[code]) sessions[code].contactBook = book;
    }
    await this.atomicJson(file, payload || {
      version: 1, createdAt: new Date().toISOString(), pendingDatabase: this.pendingDatabase,
      sessions, records: [...this.records.values()]
    });
    return file;
  }

  startBackups() {
    const hours = Number(this.env.CALL_BACKUP_INTERVAL_HOURS ?? (this.databaseOnly ? 0 : 24));
    if (hours <= 0) return;
    this.backupTimer = setInterval(() => {
      this.saveChain.then(() => this.backup()).catch(error =>
        console.error("[BACKUP] No se pudo crear la copia:", error.code || "BACKUP_FAILED"));
    }, hours * 60 * 60 * 1000);
    this.backupTimer.unref();
  }

  async restoreBackup(file, sessionsMap) {
    const backup = await this.readJson(file, null);
    if (backup?.version !== 1 || !Array.isArray(backup.records) || !backup.sessions) {
      throw new Error("La copia no tiene un formato válido.");
    }
    for (const entry of backup.records) this.remember(entry.code, entry.row);
    for (const [code, session] of Object.entries(backup.sessions)) {
      if (!sessionsMap.has(code)) sessionsMap.set(code, this.cleanSessionOnLoad(session));
    }
    return this.save(sessionsMap);
  }

  async close() {
    clearInterval(this.backupTimer);
    await this.saveChain;
    if (this.pool) await this.pool.end();
  }
}
