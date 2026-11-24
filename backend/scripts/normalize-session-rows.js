import "dotenv/config";
import { runtimeLockName } from "../services/workspace/runtime-instance.js";
import { SessionPersistence } from "../shared/persistence.js";

if (process.env.SESSION_ROWS_MIGRATION_BACKUP_VERIFIED !== "1") {
  throw new Error("Confirma una copia externa restaurable y define SESSION_ROWS_MIGRATION_BACKUP_VERIFIED=1.");
}

const storage = new SessionPersistence(undefined, {
  databaseOnly: true,
  env: {
    ...process.env,
    DB_POOL_LIMIT: String(Math.max(2, Number(process.env.DB_POOL_LIMIT) || 2)),
    CONTACT_BOOK_MIGRATION_BACKUP_VERIFIED: "1",
    SESSION_DATA_MIGRATION_BACKUP_VERIFIED: "1",
    SHIFT_DETAILS_MIGRATION_BACKUP_VERIFIED: "1"
  }
});
let lockConnection;
try {
  if (!storage.databaseConfigured || !await storage.initDb()) throw new Error("No se pudo conectar a MySQL.");
  lockConnection = await storage.pool.getConnection();
  const [[legacyLock]] = await lockConnection.query("SELECT IS_USED_LOCK('sistema_llamadas_runtime') AS owner");
  if (legacyLock.owner) throw new Error("Detén la aplicación antes de ejecutar la migración.");
  const [[lock]] = await lockConnection.query("SELECT GET_LOCK(?,0) AS acquired", [runtimeLockName(process.env)]);
  if (Number(lock.acquired) !== 1) throw new Error("La aplicación está usando la base; no se migró.");
  let result;
  if (process.argv.includes("--rollback")) {
    result = await storage.restoreSessionRows();
  } else {
    const sessions = await storage.load();
    await storage.normalizeContactBooks(sessions);
    await storage.normalizeSessionData(sessions);
    await storage.normalizeShiftDetails();
    result = await storage.normalizeSessionRows();
  }
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error("[SESSION_ROWS_MIGRATION] " + (error.code || error.message));
  process.exitCode = 1;
} finally {
  if (lockConnection) {
    await lockConnection.query("SELECT RELEASE_LOCK(?)", [runtimeLockName(process.env)]).catch(() => {});
    lockConnection.release();
  }
  await storage.close();
}
