import { summarizeAttempts, classifyAttempt } from "../../../shared/reports/report-metrics.js";
import { createHash } from "node:crypto";

const states = new Set(["idle", "available", "dialing", "ringing", "in_call", "ended", "failed"]);
const activeStates = new Set(["dialing", "ringing", "in_call"]);
const pendingStates = new Set(["pending", "retry_pending", "held"]);
const labels = { dialing: "Marcando", ringing: "Marcando", in_call: "En llamada" };
const displayState = state => state === "in_call" ? "in_call" : activeStates.has(state) ? "dialing" : "idle";
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const iso = value => value ? new Date(value).toISOString() : null;
const isTest = id => /^(android-test-|TEST-|SIM-)/.test(id);
const EMPTY_METRICS = summarizeAttempts([]);
const EMPTY_HISTORY_VERSION = createHash("sha256").update("[]").digest("hex").slice(0, 24);

export class NetworkMonitor {
  constructor({ pool, persistence, getSessions, isSocketConnected, broadcast, now = () => Date.now() }) {
    Object.assign(this, { pool, persistence, getSessions, isSocketConnected, broadcast, now });
    this.observations = new Map();
    this.displayTimings = new Map();
    this.connectionTimestamps = new Map();
    this.registry = [];
    this.chain = Promise.resolve();
    this.historyCache = new Map();
    this.historyRetryAfter = 0;
    this.broadcastTimer = null;
    this.broadcasting = false;
    this.broadcastDirty = false;
  }

  // Publica el snapshot en cuanto cambia un estado. Nunca hay más de un
  // snapshot en vuelo: los cambios que llegan mientras se publica se agrupan
  // en un único aviso final. Esto evita saturar socket y MySQL con ráfagas.
  notifyChanged() {
    if (this.broadcasting) {
      this.broadcastDirty = true;
      return;
    }
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcasting = true;
      this.snapshot()
        .then(snapshot => this.broadcast?.(snapshot))
        .catch(() => this.broadcast?.({ unavailable: true }))
        .finally(() => {
          this.broadcasting = false;
          if (this.broadcastDirty) {
            this.broadcastDirty = false;
            this.notifyChanged();
          }
        });
    }, 250);
    this.broadcastTimer.unref?.();
  }

  async initialize() {
    if (!this.pool) return;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS admin_network_devices (
      position TINYINT UNSIGNED PRIMARY KEY,
      device_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
      session_code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      last_activity_at DATETIME(3) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    try {
      await this.pool.query("ALTER TABLE admin_network_devices ADD COLUMN connected_at DATETIME(3) NULL, ADD COLUMN disconnected_at DATETIME(3) NULL");
    } catch { /* columnas ya existentes */ }
    const [rows] = await this.pool.query("SELECT * FROM admin_network_devices ORDER BY position");
    this.registry = rows;
    for (const r of rows) {
      if (r.device_id && (r.connected_at || r.disconnected_at)) {
        this.connectionTimestamps.set(r.device_id, {
          isConnected: Boolean(r.connected_at && !r.disconnected_at),
          connectedAt: timestamp(r.connected_at) || null,
          disconnectedAt: timestamp(r.disconnected_at) || null
        });
      }
    }
  }

  observe(code, worker, payload) {
    if (!worker || !states.has(payload.callState)) return;
    const device = this.candidates().get(worker.id);
    if (!device?.connected || device.code !== code || device.worker.socketId !== worker.socketId) return;
    const timing = this.displayTimings.get(worker.id);
    const sameConnection = timing?.code === code && timing.socketId === worker.socketId
      && !["disconnected", "unknown"].includes(timing.state);
    const previous = sameConnection ? this.observations.get(worker.id) : null;
    const at = this.now();
    const state = displayState(payload.callState);
    const callId = String(payload.callId || "").trim() || null;
    const changed = !previous || previous.state !== payload.callState || previous.callId !== callId;
    const newCall = activeStates.has(payload.callState) && callId && timing?.callId && callId !== timing.callId;
    const terminal = ["ended", "failed"].includes(payload.callState);
    const newTerminal = terminal && !["ended", "failed"].includes(previous?.state);
    // Receipt time is a known transition, not a reconstructed call/connection start.
    // A first status report cannot establish when the current activity began.
    const stateSince = sameConnection && state === timing.state && !newCall && !newTerminal
      ? timing.stateSince : (previous || terminal ? at : null);
    this.displayTimings.set(worker.id, {
      code, socketId: worker.socketId, state, stateSince,
      callId: callId || (sameConnection && state === timing.state ? timing.callId : null)
    });
    this.observations.set(worker.id, {
      code, socketId: worker.socketId, state: payload.callState, reportedAt: at,
      lastActivity: activeStates.has(payload.callState) || ["ended", "failed"].includes(payload.callState)
        ? at : previous?.lastActivity || null
    });
    if (changed) this.notifyChanged();
  }

  candidates() {
    const devices = new Map();
    for (const [code, session] of this.getSessions()) {
      for (const slot of session.pairingSlots || []) {
        if (!slot.deviceId) continue;
        const worker = (session.phoneWorkers || []).find(item => item.id === slot.deviceId);
        const connected = Boolean(worker?.connected && worker.socketId && this.isSocketConnected(worker.socketId));
        const candidate = { code, session, slot, worker, connected, name: worker?.name || slot.deviceName || "Equipo" };
        const previous = devices.get(slot.deviceId);
        if (!previous || (connected && !previous.connected)
            || (connected === previous.connected && timestamp(slot.linkedAt) > timestamp(previous.slot.linkedAt))) {
          devices.set(slot.deviceId, candidate);
        }
      }
    }
    return devices;
  }

  async syncRegistry(devices) {
    for (const [id, device] of devices) {
      let row = this.registry.find(item => item.device_id === id);
      if (!row) {
        const position = Array.from({ length: 10 }, (_, i) => i + 1).find(n => !this.registry.some(item => item.position === n));
        if (!position) continue;
        await this.pool.query("INSERT INTO admin_network_devices(position,device_id,session_code,name) VALUES (?,?,?,?)",
          [position, id, device.code, device.name]);
        row = { position, device_id: id, session_code: device.code, name: device.name, last_activity_at: null };
        this.registry.push(row);
      }
      const observed = this.observations.get(id);
      const lastActivity = observed?.lastActivity ? iso(observed.lastActivity) : iso(row.last_activity_at);
      if (row.session_code !== device.code || row.name !== device.name || timestamp(row.last_activity_at) !== timestamp(lastActivity)) {
        await this.pool.query("UPDATE admin_network_devices SET session_code=?,name=?,last_activity_at=? WHERE position=?",
          [device.code, device.name, lastActivity ? new Date(lastActivity) : null, row.position]);
        Object.assign(row, { session_code: device.code, name: device.name, last_activity_at: lastActivity });
      }
      if (this.pool && row.device_id) {
        const connRecord = this.connectionTimestamps.get(row.device_id);
        if (connRecord && (timestamp(row.connected_at) !== (connRecord.connectedAt || 0) || timestamp(row.disconnected_at) !== (connRecord.disconnectedAt || 0))) {
          try {
            await this.pool.query("UPDATE admin_network_devices SET connected_at=?,disconnected_at=? WHERE position=?",
              [connRecord.connectedAt ? new Date(connRecord.connectedAt) : null, connRecord.disconnectedAt ? new Date(connRecord.disconnectedAt) : null, row.position]);
            row.connected_at = connRecord.connectedAt ? iso(connRecord.connectedAt) : null;
            row.disconnected_at = connRecord.disconnectedAt ? iso(connRecord.disconnectedAt) : null;
          } catch { /* ignorar columnas inexistentes */ }
        }
      }
    }
  }

  snapshot({ detailNumbers = [] } = {}) {
    const operation = this.chain.then(() => this.buildSnapshot(new Set(detailNumbers)));
    this.chain = operation.catch(() => {});
    return operation;
  }

  async buildSnapshot(detailNumbers) {
    const devices = this.candidates();
    await this.syncRegistry(devices);
    const registeredIds = new Set(this.registry.map(row => row.device_id));
    const virtualRows = [...devices.entries()]
      .filter(([id]) => !registeredIds.has(id))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, device], index) => ({
        position: Math.max(10, ...this.registry.map(row => Number(row.position) || 0)) + index + 1,
        device_id: device.slot.deviceId,
        session_code: device.code,
        name: device.name,
        last_activity_at: null
      }));
    const displayRows = [...this.registry, ...virtualRows];
    const rowsByPosition = new Map(displayRows.map(row => [Number(row.position), row]));
    const sources = new Map();
    for (const row of displayRows) {
      const code = devices.get(row.device_id)?.code || row.session_code;
      if (sources.has(code)) continue;
      const session = this.getSessions().get(code);
      const turn = session?.shiftManagement?.current;
      sources.set(code, { session, turn, rows: null });
    }
    const missing = [...sources].filter(([code, source]) => {
      const cached = this.historyCache.get(code);
      if (cached && cached.turnId === (source.turn?.id || "") && cached.rows) {
        source.rows = cached.rows;
        source.rowsByWorker = cached.rowsByWorker;
        source.lastAttemptByWorker = cached.lastAttemptByWorker;
        source.metricsByWorker = cached.metricsByWorker;
        source.historyVersionByWorker = cached.historyVersionByWorker;
        source.rollupTurnId = cached.rollupTurnId;
        return this.now() - cached.loadedAt >= 5000;
      }
      return true;
    }).map(([code]) => code);
    if (missing.length && this.now() >= this.historyRetryAfter) {
      try {
        const shiftIds = new Map(missing.map(code => [code, sources.get(code).turn?.id || ""]));
        const histories = await this.persistence.getCallAttemptsForSessions(missing, shiftIds);
        for (const code of missing) {
          const source = sources.get(code);
          const rows = histories.get(code) ?? null;
          source.rows = rows;
          if (rows) {
            const rowsByWorker = new Map();
            const lastAttemptByWorker = new Map();
            for (const attempt of rows) {
              const workerId = attempt.workerId;
              if (!workerId) continue;
              if (attempt.shiftId === source.turn?.id) {
                if (!rowsByWorker.has(workerId)) rowsByWorker.set(workerId, []);
                rowsByWorker.get(workerId).push(attempt);
              }
              lastAttemptByWorker.set(workerId, Math.max(lastAttemptByWorker.get(workerId) || 0,
                timestamp(attempt.endedAt || attempt.answeredAt || attempt.startedAt)));
            }
            source.rowsByWorker = rowsByWorker;
            source.lastAttemptByWorker = lastAttemptByWorker;
            source.metricsByWorker = new Map();
            source.historyVersionByWorker = new Map();
            for (const [workerId, workerRows] of rowsByWorker) {
              source.metricsByWorker.set(workerId, summarizeAttempts(workerRows));
              source.historyVersionByWorker.set(workerId,
                createHash("sha256").update(JSON.stringify(workerRows)).digest("hex").slice(0, 24));
            }
            source.rollupTurnId = source.turn?.id || "";
            this.historyCache.set(code, { turnId: source.turn?.id || "", rows, rowsByWorker, lastAttemptByWorker,
              metricsByWorker: source.metricsByWorker, historyVersionByWorker: source.historyVersionByWorker,
              rollupTurnId: source.rollupTurnId, loadedAt: this.now() });
          }
        }
      } catch {
        this.historyRetryAfter = this.now() + 5000;
        /* Keep the last confirmed history snapshot while storage recovers. */
      }
    }
    const equipment = Array.from({ length: Math.max(10, ...displayRows.map(row => Number(row.position) || 0)) }, (_, index) => {
      const row = rowsByPosition.get(index + 1);
      if (!row) return { number: index + 1, name: `Equipo ${index + 1}`, state: "Sin vincular", calling: false,
        stateSince: null,
        call: null, deviceId: null, metrics: null, pending: null, historyVersion: "unknown",
        connectedAt: null, disconnectedAt: null, connectedDurationSeconds: null, disconnectedDurationSeconds: null,
        ...(detailNumbers.has(index + 1) ? { activity: [] } : {}), rubro: null, schedule: null, lastActivityAt: null };
      const device = devices.get(row.device_id);
      const source = sources.get(device?.code || row.session_code);
      const observed = this.observations.get(row.device_id);
      const currentObservation = device?.connected && observed?.socketId === device.worker?.socketId
        && observed.code === device.code ? observed : null;
      const calling = Boolean(currentObservation && activeStates.has(currentObservation.state));
      const isConnected = Boolean(device?.connected);
      const state = !device ? "Sin vincular" : !isConnected ? "Desconectado" : calling ? labels[currentObservation.state] : "Disponible";
      let displayTiming = this.displayTimings.get(row.device_id);
      if (!device || !isConnected || !currentObservation) {
        const timingState = device && !isConnected ? "disconnected" : "unknown";
        if (!displayTiming || displayTiming.state !== timingState) {
          displayTiming = { code: device?.code, socketId: device?.worker?.socketId, state: timingState,
            stateSince: timingState === "disconnected" ? this.now() : null };
          this.displayTimings.set(row.device_id, displayTiming);
        }
        // An old report cannot become current again after a sampled disconnect.
        this.observations.delete(row.device_id);
      }
      const stateSince = iso(displayTiming?.stateSince);

      let connRecord = this.connectionTimestamps.get(row.device_id);
      if (!connRecord) {
        const linked = timestamp(device?.slot?.linkedAt);
        connRecord = {
          isConnected,
          connectedAt: isConnected ? (linked || this.now()) : null,
          disconnectedAt: !isConnected && device ? (linked || this.now()) : null
        };
        this.connectionTimestamps.set(row.device_id, connRecord);
      } else {
        if (isConnected) {
          if (!connRecord.isConnected) {
            connRecord.isConnected = true;
            connRecord.connectedAt = this.now();
            connRecord.disconnectedAt = null;
          } else if (!connRecord.connectedAt) {
            connRecord.connectedAt = this.now();
          }
        } else {
          if (connRecord.isConnected) {
            connRecord.isConnected = false;
            connRecord.disconnectedAt = this.now();
            connRecord.connectedAt = null;
          } else if (device && !connRecord.disconnectedAt) {
            connRecord.disconnectedAt = this.now();
          }
        }
      }

      const connectedAt = isConnected && connRecord.connectedAt ? iso(connRecord.connectedAt) : null;
      const disconnectedAt = !isConnected && device && connRecord.disconnectedAt ? iso(connRecord.disconnectedAt) : null;
      const connectedDurationSeconds = isConnected && connRecord.connectedAt
        ? Math.max(0, Math.floor((this.now() - connRecord.connectedAt) / 1000)) : null;
      const disconnectedDurationSeconds = !isConnected && device && connRecord.disconnectedAt
        ? Math.max(0, Math.floor((this.now() - connRecord.disconnectedAt) / 1000)) : null;

      const turn = source?.turn?.status === "active" ? source.turn : null;
      const reliableScope = Boolean(turn?.id && turn.startedAt && source?.rows);
      const rows = reliableScope ? source.rowsByWorker?.get(row.device_id) || [] : null;
      const assignment = device?.session.contactBook?.preferences?.pairingListAssignments?.[device.slot.id];
      const rubro = typeof assignment === "string" && assignment ? assignment : null;
      const contacts = source?.session?.campaign?.contacts;
      const assigned = Array.isArray(contacts) ? contacts.filter(c => c.targetWorkerId
        ? c.targetWorkerId === row.device_id : rubro && c.list === rubro) : null;
      // A list/target is required to attribute pending contacts to a physical phone.
      const pending = reliableScope && assigned && (rubro || assigned.length)
        ? assigned.filter(c => pendingStates.has(c.status)).length : null;
      const lastAttempt = source?.lastAttemptByWorker?.get(row.device_id) || 0;
      const sameWorker = (id) => Boolean(id) && String(id) === String(row.device_id);
      const activeContact = Array.isArray(contacts) ? contacts.find((c) =>
        activeStates.has(c.status) && (sameWorker(c.assignedWorkerId) || sameWorker(c.targetWorkerId))) : null;
      const call = calling && activeContact ? {
        name: activeContact.name || "Sin nombre",
        phone: activeContact.phone || "",
        status: activeContact.status,
        list: activeContact.list || null
      } : null;
      return { number: row.position, deviceId: row.device_id, name: row.name, state, calling, call,
        stateSince,
        simulated: isTest(row.device_id), rubro, schedule: turn?.schedule || null,
        connectedAt, disconnectedAt, connectedDurationSeconds, disconnectedDurationSeconds,
        turn: turn ? { id: turn.id, label: turn.label, date: turn.date, startedAt: turn.startedAt } : null,
        source: currentObservation ? "phone:status" : null, reportedAt: iso(currentObservation?.reportedAt),
        lastActivityAt: iso(Math.max(timestamp(row.last_activity_at), observed?.lastActivity || 0, lastAttempt)),
        metrics: rows ? source.metricsByWorker?.get(row.device_id) || EMPTY_METRICS : null, pending,
        historyVersion: rows ? source.historyVersionByWorker?.get(row.device_id) || EMPTY_HISTORY_VERSION : "unknown",
        ...(detailNumbers.has(row.position) ? { activity: rows ? rows.sort((a, b) => timestamp(b.startedAt) - timestamp(a.startedAt)).slice(0, 30).map(r => ({
          attemptId: r.attemptId, name: r.name || "Sin nombre", list: r.list || null,
          startedAt: r.startedAt || null, endedAt: r.endedAt || null,
          durationSeconds: r.durationSeconds ?? null, result: r.technicalResult || null, category: classifyAttempt(r)
        })) : [] } : {}),
        scopeReason: !turn ? "Sin un turno activo verificable." : !source?.rows ? "Historial no disponible o con escrituras pendientes." : null
      };
    });
    const allSources = [...sources.values()];
    const common = allSources.length > 0 && allSources.every(s => s.turn?.status === "active" && s.turn.id
      && ["morning", "afternoon"].includes(s.turn.type) && /^\d{4}-\d{2}-\d{2}$/.test(s.turn.date)
      && s.turn.startedAt && s.rows && s.turn.date === allSources[0].turn.date && s.turn.type === allSources[0].turn.type);
    const scopeRows = common ? allSources.flatMap(s => s.rows.filter(r => r.shiftId === s.turn.id
      && displayRows.some(device => device.device_id === r.workerId))) : null;
    return { generatedAt: iso(this.now()), callingCount: equipment.filter(e => e.calling).length, capacity: equipment.length,
      equipment, overflow: virtualRows.length,
      summary: { metrics: scopeRows ? summarizeAttempts(scopeRows) : null,
        label: common ? `${allSources[0].turn.label} · ${allSources[0].turn.date}` : "Turno sin alcance común",
        scope: common ? `${allSources.length} sesión(es); intentos identificados por turno y celular.` : "No hay turnos activos compatibles para consolidar el resumen.",
        // Sum only when every phone has an attributable queue; never invent a zero.
        pending: common && equipment.filter(e => e.deviceId).every(e => e.pending !== null)
          ? equipment.filter(e => e.deviceId).reduce((sum, e) => sum + e.pending, 0) : null }
    };
  }

  start() {
    const intervalMs = Number(process.env.NETWORK_MONITOR_INTERVAL_MS || 30000);
    this.timer = setInterval(() => {
      if (this.publishing) return;
      this.publishing = true;
      this.snapshot().then(data => this.broadcast(data)).catch(() => this.broadcast({ unavailable: true }))
        .finally(() => { this.publishing = false; });
    }, intervalMs);
    this.timer.unref();
  }
}
