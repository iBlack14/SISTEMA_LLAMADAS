import mysql from "mysql2/promise";
import path from "node:path";
import { localConfig, localDir } from "./local-runtime.js";

const config = await localConfig();
const connection = await mysql.createConnection({ host: config.host, port: config.port,
  user: "root", password: config.rootPassword });
try {
  const [[instance]] = await connection.query("SELECT @@port AS port, @@datadir AS datadir");
  if (Number(instance.port) !== 3308 || path.resolve(instance.datadir).toLowerCase() !== path.join(localDir, "mysql-data").toLowerCase()) {
    throw new Error("Instancia inesperada: no se detuvo MySQL.");
  }
  await connection.query("SHUTDOWN");
  console.log("MySQL de pruebas detenido; datos conservados.");
} finally { await connection.end().catch(() => {}); }
