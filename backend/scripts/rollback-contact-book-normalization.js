import "dotenv/config";
import { runtimeLockName } from "../services/workspace/runtime-instance.js";
import { SessionPersistence } from "../shared/persistence.js";

if (process.env.CONTACT_BOOK_MIGRATION_BACKUP_VERIFIED !== "1") {
  throw new Error("Confirma una copia externa restaurable con CONTACT_BOOK_MIGRATION_BACKUP_VERIFIED=1 antes de revertir.");
}

const storage = new SessionPersistence(undefined, { databaseOnly: true });
let lockConnection = null;
try {
  if (!storage.databaseConfigured || !await storage.initDb()) {
    throw new Error("No se pudo conectar a MySQL; no se ejecutó la reversión.");
  }
  lockConnection = await storage.pool.getConnection();
  const [[legacyLock]] = await lockConnection.query("SELECT IS_USED_LOCK('sistema_llamadas_runtime') AS owner");
  if (legacyLock.owner) {
    throw new Error("El servidor está usando la base. Detén la aplicación antes de revertir.");
  }
  const [[lock]] = await lockConnection.query("SELECT GET_LOCK(?,0) AS acquired", [runtimeLockName(process.env)]);
  if (Number(lock.acquired) !== 1) {
    throw new Error("El servidor está usando la base. Detén la aplicación antes de revertir.");
  }
  const result = await storage.restoreContactBooksToSessionJson();
  console.log(JSON.stringify({ ok: true, restoredSessions: result.restored }));
} catch (error) {
  console.error("[CONTACT_BOOK_ROLLBACK] " + (error.code || error.message));
  process.exitCode = 1;
} finally {
  if (lockConnection) {
    await lockConnection.query("SELECT RELEASE_LOCK(?)", [runtimeLockName(process.env)]).catch(() => {});
    lockConnection.release();
  }
  await storage.close();
}
