import "dotenv/config";
import { runtimeLockName } from "../services/workspace/runtime-instance.js";
import { SessionPersistence } from "../shared/persistence.js";

if (process.env.SHIFT_DETAILS_MIGRATION_BACKUP_VERIFIED !== "1") {
  throw new Error("Confirma una copia externa restaurable y define SHIFT_DETAILS_MIGRATION_BACKUP_VERIFIED=1.");
}

const storage = new SessionPersistence(undefined, { databaseOnly: true });
let lockConnection;
try {
  if (!storage.databaseConfigured || !await storage.initDb()) throw new Error("No se pudo conectar a MySQL.");
  lockConnection = await storage.pool.getConnection();
  const [[legacyLock]] = await lockConnection.query("SELECT IS_USED_LOCK('sistema_llamadas_runtime') AS owner");
  if (legacyLock.owner) throw new Error("Detén la aplicación antes de migrar los detalles de turnos.");
  const [[lock]] = await lockConnection.query("SELECT GET_LOCK(?,0) AS acquired", [runtimeLockName(process.env)]);
  if (Number(lock.acquired) !== 1) throw new Error("La aplicación está usando la base; no se migró.");
  const result = await storage.normalizeShiftDetails();
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error("[SHIFT_DETAILS_MIGRATION] " + (error.code || error.message));
  process.exitCode = 1;
} finally {
  if (lockConnection) {
    await lockConnection.query("SELECT RELEASE_LOCK(?)", [runtimeLockName(process.env)]).catch(() => {});
    lockConnection.release();
  }
  await storage.close();
}
