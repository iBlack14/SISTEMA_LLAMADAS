import { summarizeAttempts, classifyAttempt } from "../web/modules/report-metrics.js";
import { createHash } from "node:crypto";

const states = new Set(["idle", "available", "dialing", "ringing", "in_call", "ended", "failed"]);
const activeStates = new Set(["dialing", "ringing", "in_call"]);
const pendingStates = new Set(["pending", "retry_pending", "held"]);
const labels = { dialing: "Marcando", ringing: "Marcando", in_call: "En llamada" };
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const iso = value => value ? new Date(value).toISOString() : null;
const isTest = id => /^(android-test-|TEST-|SIM-)/.test(id);

export class NetworkMonitor {
  constructor({ pool, persistence, getSessions, isSocketConnected, broadcast, now = () => Date.now() }) {
    Object.assign(this, { pool, persistence, getSessions, isSocketConnected, broadcast, now });
    this.observations = new Map();
    this.registry = [];
    this.chain = Promise.resolve();
  }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS admin_network_devices (
      position TINYINT UNSIGNED PRIMARY KEY,
      device_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL UNIQUE,
      session_code VARCHAR(50) NOT NULL,
      name VARCHAR(255) NOT NULL,
      last_activity_at DATETIME(3) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const [rows] = await this.pool.query("SELECT * FROM admin_network_devices ORDER BY position");
    this.registry = rows;
  }

  observe(code, worker, payload) {
    if (!worker || !states.has(payload.callState)) return;
    const previous = this.observations.get(worker.id);
    const at = this.now();
    this.observations.set(worker.id, {
      code, socketId: worker.socketId, state: payload.callState, reportedAt: at,
      lastActivity: activeStates.has(payload.callState) || ["ended", "failed"].includes(payload.callState)
        ? at : previous?.lastActivity || null
    });
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
    const sources = new Map();
    for (const row of this.registry) {
      const code = devices.get(row.device_id)?.code || row.session_code;
      if (sources.has(code)) continue;
      const session = this.getSessions().get(code);
      const turn = session?.shiftManagement?.current;
      sources.set(code, { session, turn, rows: null });
    }
    try {
      const histories = await this.persistence.getCallAttemptsForSessions([...sources.keys()]);
      for (const [code, source] of sources) source.rows = histories.get(code) ?? null;
    } catch { /* Unconfirmed data remains null, never an invented zero. */ }
    const equipment = Array.from({ length: 10 }, (_, index) => {
      const row = this.registry.find(item => item.position === index + 1);
      if (!row) return { number: index + 1, name: `Equipo ${index + 1}`, state: "Sin vincular", calling: false,
        deviceId: null, metrics: null, pending: null, historyVersion: "unknown",
        ...(detailNumbers.has(index + 1) ? { activity: [] } : {}), rubro: null, schedule: null, lastActivityAt: null };
      const device = devices.get(row.device_id);
      const source = sources.get(device?.code || row.session_code);
      const observed = this.observations.get(row.device_id);
      const currentObservation = device?.connected && observed?.socketId === device.worker?.socketId
        && observed.code === device.code ? observed : null;
      const calling = Boolean(currentObservation && activeStates.has(currentObservation.state));
      const state = !device ? "Sin vincular" : !device.connected ? "Desconectado" : calling ? labels[currentObservation.state] : "Disponible";
      const turn = source?.turn?.status === "active" ? source.turn : null;
      const reliableScope = Boolean(turn?.id && turn.startedAt && source?.rows);
      const rows = reliableScope ? source.rows.filter(item => item.workerId === row.device_id && item.shiftId === turn.id) : null;
      const assignment = device?.session.contactBook?.preferences?.pairingListAssignments?.[device.slot.id];
      const rubro = typeof assignment === "string" && assignment ? assignment : null;
      const contacts = source?.session?.campaign?.contacts;
      const assigned = Array.isArray(contacts) ? contacts.filter(c => c.targetWorkerId
        ? c.targetWorkerId === row.device_id : rubro && c.list === rubro) : null;
      // A list/target is required to attribute pending contacts to a physical phone.
      const pending = reliableScope && assigned && (rubro || assigned.length)
        ? assigned.filter(c => pendingStates.has(c.status)).length : null;
      const lastAttempt = source?.rows?.filter(r => r.workerId === row.device_id)
        .reduce((latest, r) => Math.max(latest, timestamp(r.endedAt || r.answeredAt || r.startedAt)), 0) || 0;
      return { number: row.position, deviceId: row.device_id, name: row.name, state, calling,
        simulated: isTest(row.device_id), rubro, schedule: turn?.schedule || null,
        turn: turn ? { id: turn.id, label: turn.label, date: turn.date, startedAt: turn.startedAt } : null,
        source: currentObservation ? "phone:status" : null, reportedAt: iso(currentObservation?.reportedAt),
        lastActivityAt: iso(Math.max(timestamp(row.last_activity_at), observed?.lastActivity || 0, lastAttempt)),
        metrics: rows ? summarizeAttempts(rows) : null, pending,
        historyVersion: rows ? createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 24) : "unknown",
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
      && this.registry.some(device => device.device_id === r.workerId))) : null;
    return { generatedAt: iso(this.now()), callingCount: equipment.filter(e => e.calling).length, capacity: 10,
      equipment, overflow: [...devices.keys()].filter(id => !this.registry.some(r => r.device_id === id)).length,
      summary: { metrics: scopeRows ? summarizeAttempts(scopeRows) : null,
        label: common ? `${allSources[0].turn.label} · ${allSources[0].turn.date}` : "Turno sin alcance común",
        scope: common ? `${allSources.length} sesión(es); intentos identificados por turno y celular.` : "No hay turnos activos compatibles para consolidar el resumen.",
        // Sum only when every phone has an attributable queue; never invent a zero.
        pending: common && equipment.filter(e => e.deviceId).every(e => e.pending !== null)
          ? equipment.filter(e => e.deviceId).reduce((sum, e) => sum + e.pending, 0) : null }
    };
  }

  start() {
    this.timer = setInterval(() => {
      if (this.publishing) return;
      this.publishing = true;
      this.snapshot().then(data => this.broadcast(data)).catch(() => this.broadcast({ unavailable: true }))
        .finally(() => { this.publishing = false; });
    }, 1000);
    this.timer.unref();
  }
}
