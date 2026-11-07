import "dotenv/config";
import path from "node:path";
import { SessionPersistence } from "./persistence.js";

const importIndex = process.argv.indexOf("--import");
const importFile = importIndex === -1 ? null : process.argv[importIndex + 1];
if (importIndex !== -1 && (!importFile || importFile.startsWith("--"))) {
  throw new Error("Indica el archivo de sesiones después de --import.");
}
const storage = new SessionPersistence(importFile ? path.resolve(importFile) : undefined, {
  databaseOnly: !importFile
});
try {
  if (!storage.databaseConfigured) {
    throw new Error("Configura DB_HOST, DB_PORT, DB_NAME, DB_USER y DB_PASSWORD en .env. No se ejecutó la migración MySQL.");
  }
  const sessions = await storage.load();
  if (!storage.usingDb) throw new Error("No se pudo conectar con MySQL. Revisa conexión y permisos.");
  const restoreIndex = process.argv.indexOf("--restore");
  if (restoreIndex !== -1) {
    const file = process.argv[restoreIndex + 1];
    if (!file) throw new Error("Indica el archivo de copia después de --restore.");
    await storage.restoreBackup(path.resolve(file), sessions);
  } else if (!process.argv.includes("--backup-only")) {
    await storage.save(sessions);
  }
  const backupFile = await storage.backup("manual");
  console.log(JSON.stringify({
    ok: true, mode: storage.status().mode, sessions: sessions.size,
    attempts: storage.status().attempts, backupFile
  }));
} catch (error) {
  console.error("[HISTORY] " + (error.code || error.message));
  process.exitCode = 1;
} finally { await storage.close(); }
