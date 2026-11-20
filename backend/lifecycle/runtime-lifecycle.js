import { runtimeIdentity, runtimeLockName, probeRuntime, waitForRuntime } from "../services/workspace/runtime-instance.js";
import {
  ensureCampaign,
  getCampaignSnapshot,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  assignNextContact,
  assignSpecificContact,
  ensureCampaignContact,
  updateActiveCallState,
  markContactResult,
  skipActiveContact,
  holdActiveContact,
  resumeHeldContact,
  getActiveContact,
  getContactByWorker,
  getActiveAttemptId,
  setWorkerPaused,
  isWorkerPaused,
  resetCampaignForShift,
  resetCampaignOperation,
  switchWorkerList
} from "../services/campaigns/campaign-manager.js";

/**
 * createRuntimeLifecycle: conserva los contratos y reglas existentes.
 * Dependencias: runtime.alreadyRunning, runtime.auth, runtime.easypanel, runtime.historyGate, runtime.instanceIdentity, runtime.instancePort, runtime.network, runtime.persistence, runtime.server, runtime.sessions, runtime.shuttingDown, runtime.workspaces, services.normalizeSessionShape.
 * Se construye una vez por proceso.
 */
export function createRuntimeLifecycle(runtime, services) {
async function bootstrap() {
  const running = await probeRuntime(runtime.instancePort, runtime.instanceIdentity);
  if (running === "same") { runtime.alreadyRunning(); process.exit(0); }
  if (running === "other") throw new Error(`El puerto ${runtime.instancePort} está ocupado por otro servicio. No se cerró ningún proceso.`);
  if (!await runtime.persistence.initDb()) throw new Error("No se pudo conectar a MySQL. Verifica el servicio MySQL y las variables DB_*.");
  // Operational state is kept in memory: never run two writers on this database.
  const runtimeLock = await runtime.persistence.pool.getConnection();
  let lock;
  const lockName = runtimeLockName(process.env);
  const retryUntil = Date.now() + 30000;
  do {
    const [[legacyLock]] = await runtimeLock.query("SELECT IS_USED_LOCK('sistema_llamadas_runtime') AS owner");
    const [[result]] = legacyLock.owner
      ? [[{ acquired: 0 }]]
      : await runtimeLock.query("SELECT GET_LOCK(?,0) AS acquired", [lockName]);
    lock = result;
    if (Number(lock.acquired) === 1) break;
    if (Date.now() >= retryUntil) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  } while (true);
  if (Number(lock.acquired) !== 1) {
    runtimeLock.release();
    if (await waitForRuntime(runtime.instancePort, runtime.instanceIdentity) === "same") { runtime.alreadyRunning(); process.exit(0); }
    throw new Error(`No se pudo obtener el bloqueo exclusivo de MySQL para ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME}. Otra instancia sigue escribiendo en esa base; se evitó iniciar un segundo escritor.`);
  }
  // MySQL releases this dedicated connection's lock when the process exits.
  runtime.sessions = await runtime.persistence.load();
  if (process.env.AUTO_NORMALIZE_CONTACT_BOOKS === "1") {
    await runtime.persistence.normalizeContactBooks(runtime.sessions);
  }
  runtime.auth.pool = runtime.persistence.pool;
  await runtime.auth.initialize();
  runtime.network.pool = runtime.persistence.pool;
  await runtime.network.initialize();
  // Socket IDs and live calls cannot survive a backend restart. Return every
  // interrupted assignment to the retry queue so campaigns never stay stuck.
  for (const [code, loadedSession] of runtime.sessions.entries()) {
    const session = services.normalizeSessionShape(loadedSession);
    runtime.sessions.set(code, session);
    const campaign = ensureCampaign(session);
    for (const workerId of Object.keys(campaign.assignments || {})) {
      skipActiveContact(session, workerId);
    }
    session.callState = "idle";
  }
  services.synchronizeGlobalBlockedNumbers();
  // MySQL is the sole session/history store; file backups are optional exports.
  // Only save if there are sessions with pending changes to avoid unnecessary binlog writes.
  if (runtime.sessions.size > 0) {
    await runtime.persistence.save(runtime.sessions);
  }
  runtime.persistence.startBackups();
  runtime.network.start();
  setInterval(() => runtime.historyGate.retryPending().catch(error => {
    console.error("[HISTORY] Reintento pendiente:", error.code || "STORAGE_UNAVAILABLE");
  }), 10000).unref();
  console.log(`[PERSISTENCE] Loaded ${runtime.sessions.size} sessions. Mode: ${runtime.persistence.status().mode}`);
  await runtime.workspaces.sweep();

  const port = Number(process.env.PORT || 3000);
  const host = runtime.easypanel ? "0.0.0.0" : process.env.AUTH_LOCAL_ISOLATED === "1" ? process.env.HOST || "127.0.0.1" : "127.0.0.1";
  runtime.server.listen(port, host, () => {
    console.log(`Call bridge listening on ${host}:${port}`);
  });
}

async function gracefulShutdown(signal) {
  if (runtime.shuttingDown) return;
  runtime.shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal}: guardando sesiones...`);
  try { await runtime.persistence.save(runtime.sessions); }
  catch (error) { console.error("No se pudieron guardar las sesiones al cerrar:", error); }
  runtime.server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
return { bootstrap, gracefulShutdown };
}
