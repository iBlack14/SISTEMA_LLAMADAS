// Inserta datos de prueba en MySQL: reportArchive (reporte diario)
// y vc_call_attempts (historial unificado del panel).
// Uso: node backend/scripts/seed-report-data.mjs [CODIGO_SESION]
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionPersistence } from "../shared/persistence.js";
import { runtimeLockName } from "../services/workspace/runtime-instance.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../..", ".env") });

const CODE = (process.argv[2] || "S2G5KO").toUpperCase().trim();

const RUBROS = [
  { name: "Ventas", companies: ["Bodega Don Juan", "Minimarket El Sol", "Ferretería Central", "Farmacia Salud Total", "Restaurante El Sabor", "Librería Punto Leer", "Bodega La Esquina", "Pollería El Buen Sabor"] },
  { name: "Cobranzas", companies: ["Constructora Andina", "Transportes Rápidos SAC", "Textiles del Sur", "Distribuidora Lima Norte", "Agroexportadora Valle Verde", "Panificadora San José", "Clínica Santa Rosa", "Importadora Pacífico"] },
  { name: "Farmacias", companies: ["Farmacia Botica Express", "Droguería Salud Andina", "Farmacia La Bamba", "Botica El Remedio", "Farmacia Cruz Verde Norte", "Droguería FarmaSur"] }
];

const WORKERS = [
  { id: "w-demo-1", name: "Equipo 1" },
  { id: "w-demo-2", name: "Equipo 2" }
];

const SHIFTS = [
  { id: "shift-demo-1", label: "Turno mañana" },
  { id: "shift-demo-2", label: "Turno tarde" }
];

const RESULTS = [
  { technicalResult: "contesto", duration: 95, disposition: "interesado" },
  { technicalResult: "contesto", duration: 142, disposition: "agendado" },
  { technicalResult: "contesto", duration: 61, disposition: "requiere_asesor" },
  { technicalResult: "buzon_de_voz", duration: 12, disposition: "reintentar" },
  { technicalResult: "sin_servicio", duration: 0, disposition: "no_contactado" },
  { technicalResult: "no_contesto", duration: 0, disposition: "sin_respuesta" },
  { technicalResult: "contesto", duration: 38, disposition: "no_interesado" },
  { technicalResult: "contesto", duration: 210, disposition: "interesado" }
];

let phoneSeq = 920000000 + Math.floor(Math.random() * 70000000);
const nextPhone = () => String(phoneSeq++).slice(0, 9);

function buildReport(date, index) {
  const rubroData = RUBROS[index % RUBROS.length];
  const shift = SHIFTS[index % SHIFTS.length];
  const count = 6 + (index % 3) * 3;
  const contacts = [];
  const history = [];
  const attempts = [];

  for (let i = 0; i < count; i++) {
    const phone = nextPhone();
    const company = rubroData.companies[i % rubroData.companies.length];
    const name = `${company} ${i + 1}`;
    const r = RESULTS[(i + index) % RESULTS.length];
    const worker = WORKERS[(i + index) % WORKERS.length];
    const contactId = `seed-${date}-${rubroData.name}-${i}`;
    const attemptId = `seed-try-${date}-${rubroData.name}-${i}`;
    const startedAt = `${date}T${String(9 + (i % 8)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00.000Z`;
    const answeredAt = r.technicalResult === "contesto"
      ? new Date(Date.parse(startedAt) + r.duration * 1000).toISOString()
      : "";
    const endedAt = r.technicalResult === "contesto"
      ? new Date(Date.parse(startedAt) + (r.duration + 8) * 1000).toISOString()
      : new Date(Date.parse(startedAt) + 25 * 1000).toISOString();
    const waitingSeconds = r.technicalResult === "contesto" ? 6 : 25;
    const totalSeconds = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000);

    contacts.push({
      id: contactId,
      name,
      phone,
      list: rubroData.name,
      status: r.technicalResult === "contesto" ? "completed" : "pending",
      technicalResult: r.technicalResult,
      result: r.technicalResult === "contesto" ? "contesto" : r.technicalResult,
      durationSeconds: r.duration
    });
    history.push({
      phone,
      technicalResult: r.technicalResult,
      durationSeconds: r.duration,
      startedAt
    });
    attempts.push({
      attemptId,
      contactId,
      name,
      phone,
      list: rubroData.name,
      workerId: worker.id,
      workerName: worker.name,
      attemptNumber: 1,
      campaignId: `SEED-${date}-${rubroData.name}`,
      shiftId: shift.id,
      shiftLabel: shift.label,
      startedAt,
      answeredAt,
      endedAt,
      durationSeconds: r.duration,
      waitingSeconds,
      totalSeconds,
      technicalResult: r.technicalResult,
      disposition: r.disposition,
      reportDate: date
    });
  }

  return {
    archive: {
      id: `SEED-${date}-${rubroData.name}`,
      date,
      rubro: rubroData.name,
      contacts,
      history
    },
    attempts
  };
}

const dates = [
  "2026-08-14", "2026-08-28",
  "2026-09-11", "2026-09-25",
  "2026-10-09", "2026-10-23",
  "2026-11-03", "2026-11-06"
];

const storage = new SessionPersistence();
const lockName = runtimeLockName(process.env);
let lockConnection;
try {
  if (!await storage.initDb()) throw new Error("No se pudo conectar a MySQL.");
  lockConnection = await storage.pool.getConnection();
  const [[legacyLock]] = await lockConnection.query("SELECT IS_USED_LOCK('sistema_llamadas_runtime') AS owner");
  if (legacyLock.owner) throw new Error("Detén la aplicación antes de cargar datos de prueba.");
  const [[lock]] = await lockConnection.query("SELECT GET_LOCK(?,0) AS acquired", [lockName]);
  if (Number(lock.acquired) !== 1) throw new Error("La aplicación está usando la base.");
  const sessions = await storage.load();
  const session = sessions.get(CODE);
  if (!session) throw new Error(`Sesión ${CODE} no existe en MySQL.`);
  session.reportArchive ||= [];
  let added = 0;
  for (const [index, date] of dates.entries()) {
    const { archive, attempts } = buildReport(date, index);
    const position = session.reportArchive.findIndex(report => report.id === archive.id);
    if (position >= 0) session.reportArchive[position] = archive;
    else {
      session.reportArchive.push(archive);
      added++;
    }
    for (const attempt of attempts) storage.remember(CODE, attempt);
  }
  await storage.save(sessions, [CODE]);
  console.log(`${session.reportArchive.length} reportes guardados en MySQL (${added} nuevos).`);
} finally {
  if (lockConnection) {
    await lockConnection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
    lockConnection.release();
  }
  await storage.close();
}
