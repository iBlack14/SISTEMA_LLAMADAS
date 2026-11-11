import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";
import { collectCallAttempts, mergeAttempt, HISTORY_SCHEMA, writeCallAttempts } from "./call-history.js";

const parseJson = value => typeof value === "string" ? JSON.parse(value) : value;
const keyOf = (code, row) => JSON.stringify([code, row.attemptId]);

/** Session compatibility plus an independent, durable and replayable attempt ledger. */
export class SessionPersistence {
  constructor(filePath = "server/sessions.json", { env = process.env, poolFactory = mysql.createPool, databaseOnly = true } = {}) {
    this.databaseOnly = databaseOnly;
    this.filePath = path.resolve(filePath);
    this.historyPath = this.filePath + ".call-history.json";
    this.backupDir = path.resolve(env.CALL_BACKUP_DIR || path.join(path.dirname(this.filePath), "backups"));
    this.env = env;
    this.poolFactory = poolFactory;
    this.databaseConfigured = Boolean(env.DB_HOST && env.DB_USER && env.DB_NAME);
    this.pool = null;
    this.usingDb = false;
    this.schemaReady = false;
    this.pendingDatabase = false;
    this.saveChain = Promise.resolve();
    this.records = new Map();
    this.dirty = new Set();
    this.lastSnapshot = {};
    this.lastError = "";
    this.storageFailed = false;
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
      if (dirty) this.dirty.add(key);
    }
  }

  async initDb() {
    if (!this.databaseConfigured) return false;
    try {
      if (!this.pool) this.pool = this.poolFactory({
        host: this.env.DB_HOST, port: Number(this.env.DB_PORT || 3306),
        user: this.env.DB_USER, password: this.env.DB_PASSWORD, database: this.env.DB_NAME,
        waitForConnections: true, connectionLimit: 10, queueLimit: 0,
        connectTimeout: 10000, timezone: "Z",
        ...(this.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {})
      });
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
    if (await this.initDb()) {
      try {
        const [sessions] = await this.pool.query("SELECT id, data FROM sessions");
        const [attempts] = await this.pool.query("SELECT session_code, row_data FROM vc_call_attempts");
        const remote = Object.fromEntries(sessions.map(row => [row.id, parseJson(row.data)]));
        // A pending local snapshot is an outbox and must be replayed, never discarded.
        chosen = this.pendingDatabase ? { ...remote, ...local } : sessions.length ? remote : local;
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
    return result;
  }

  cleanSessionOnLoad(session) {
    return {
      ...session, dashboardSocketId: null, phoneSocketId: null, activePhoneSocketId: null,
      phoneWorkers: (session.phoneWorkers || []).map(worker => ({
        ...worker, socketId: null, connected: false, callState: "idle"
      }))
    };
  }

  save(sessionsMap) {
    // Capture immediately, before another reset/delete can mutate the live Map.
    const snapshot = {};
    for (const [code, session] of sessionsMap) {
      if (collectCallAttempts(session).length) session.hasCallHistory = true;
      const { dashboardSocketId, phoneSocketId, activePhoneSocketId, workerCursor, ...data } = session;
      snapshot[code] = JSON.parse(JSON.stringify(data));
    }
    const operation = this.saveChain.then(() => this.saveNow(snapshot)).then(result => {
      this.storageFailed = false;
      this.lastError = "";
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

  async saveNow(snapshot) {
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
    try {
      await connection.beginTransaction();
      for (const [code, data] of Object.entries(snapshot)) await connection.query(
        "INSERT INTO sessions (id,data) VALUES (?,?) ON DUPLICATE KEY UPDATE data=VALUES(data)",
        [code, JSON.stringify(data)]);
      const bySession = new Map();
      for (const key of changed) {
        const entry = this.records.get(key);
        if (!entry) continue;
        if (!bySession.has(entry.code)) bySession.set(entry.code, []);
        bySession.get(entry.code).push(entry.row);
      }
      for (const [code, rows] of bySession) await writeCallAttempts(connection, code, rows);
      await connection.commit();
      for (const key of changed) this.dirty.delete(key);
      this.pendingDatabase = false;
      this.usingDb = true;
      this.lastError = "";
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

  async getCallAttemptsForSessions(codes) {
    await this.saveChain;
    if (this.storageFailed || (this.databaseConfigured && (!this.usingDb || this.pendingDatabase))) {
      throw new Error("No se puede confirmar el historial mientras hay guardados pendientes.");
    }
    const unique = [...new Set(codes)];
    const grouped = new Map(unique.map(code => [code, []]));
    if (!unique.length) return grouped;
    if (this.databaseConfigured) {
      const [rows] = await this.pool.query(
        `SELECT session_code,row_data FROM vc_call_attempts WHERE session_code IN (${unique.map(() => "?").join(",")}) ORDER BY started_at,attempt_id`, unique);
      for (const entry of rows) grouped.get(entry.session_code)?.push(parseJson(entry.row_data));
    } else {
      for (const entry of this.records.values()) grouped.get(entry.code)?.push({ ...entry.row });
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

  async backup(label = "daily", payload = null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(this.backupDir, "call-history-" + stamp + "-" + label + ".json");
    await this.atomicJson(file, payload || {
      version: 1, createdAt: new Date().toISOString(), pendingDatabase: this.pendingDatabase,
      sessions: this.lastSnapshot, records: [...this.records.values()]
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
