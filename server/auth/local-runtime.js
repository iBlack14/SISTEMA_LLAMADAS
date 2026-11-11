import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { LOCAL_DATABASE, assertIsolatedConfig } from "./config.js";
import { AUTH_SCHEMA } from "./schema.js";
import { hashPassword } from "./passwords.js";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const localDir = path.join(projectRoot, ".auth-local");
const configFile = path.join(localDir, "mysql.json");
const mysqlPort = 3308;

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`MySQL no pudo inicializarse (${code}): ${output.slice(-2000)}`)));
  });
}

async function portOpen() {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port: mysqlPort });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

export async function localConfig() {
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  if (config.host !== "127.0.0.1" || config.port !== mysqlPort || config.database !== LOCAL_DATABASE
      || config.user !== "calls_auth_local") throw new Error("Configuración local inesperada; no se conectó a MySQL.");
  return config;
}

export function appEnvironment(config) {
  const env = { ...process.env, AUTH_LOCAL_ISOLATED: "1", DB_HOST: config.host,
    DB_PORT: String(config.port), DB_NAME: config.database, DB_USER: config.user, DB_PASSWORD: config.password,
    DB_SSL: "false", HOST: "127.0.0.1", PORT: "3101", TRUST_PROXY: "0",
    CORS_ORIGIN: "http://127.0.0.1:3101,http://localhost:3101", CALL_BACKUP_INTERVAL_HOURS: "0",
    PUBLIC_BASE_URL: "http://127.0.0.1:3101", PUBLIC_WEB_BASE_URL: "http://127.0.0.1:3101",
    LOCAL_LAN_BASE_URL: "" };
  assertIsolatedConfig(env);
  return env;
}

export async function verifyDatabase(connection) {
  const [[row]] = await connection.query("SELECT DATABASE() AS db, @@port AS port");
  if (row.db !== LOCAL_DATABASE || Number(row.port) !== mysqlPort) {
    throw new Error("La conexión no corresponde a la base local aislada; operación cancelada.");
  }
}

export async function prepareLocalDatabase() {
  await fs.mkdir(localDir, { recursive: true });
  const basedir = process.env.AUTH_TEST_MYSQL_BASE || "C:/Program Files/MySQL/MySQL Server 8.0";
  const binary = path.join(basedir, "bin", process.platform === "win32" ? "mysqld.exe" : "mysqld");
  const datadir = path.join(localDir, "mysql-data");
  let config;
  if (await exists(configFile)) config = await localConfig();
  else {
    if (await portOpen()) throw new Error("El puerto 3308 está ocupado. No se usará una instancia desconocida.");
    if (await exists(datadir)) throw new Error("Hay un directorio MySQL sin configuración reconocida; no se sobrescribió.");
    config = { host: "127.0.0.1", port: mysqlPort, database: LOCAL_DATABASE, user: "calls_auth_local",
      password: randomBytes(32).toString("hex"), rootPassword: randomBytes(32).toString("hex"), rootInitialized: false };
    await fs.mkdir(datadir);
    await run(binary, ["--no-defaults", "--initialize-insecure", `--basedir=${basedir}`, `--datadir=${datadir}`, "--console"]);
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
  }
  if (!await portOpen()) {
    const child = spawn(binary, ["--no-defaults", `--basedir=${basedir}`, `--datadir=${datadir}`,
      "--bind-address=127.0.0.1", `--port=${mysqlPort}`, "--mysqlx=0",
      `--log-error=${path.join(localDir, "mysql-error.log")}`, `--pid-file=${path.join(localDir, "mysql.pid")}`],
    { windowsHide: true, detached: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  }
  let root;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      root = await mysql.createConnection({ host: config.host, port: config.port, user: "root",
        password: config.rootInitialized ? config.rootPassword : "", connectTimeout: 1000 });
      break;
    } catch (error) {
      if (attempt === 59) throw new Error(`No se pudo iniciar MySQL aislado: ${error.code}. Consulta .auth-local/mysql-error.log.`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  try {
    const [[instance]] = await root.query("SELECT @@port AS port, @@datadir AS datadir");
    if (Number(instance.port) !== mysqlPort || path.resolve(instance.datadir).toLowerCase() !== path.resolve(datadir).toLowerCase()) {
      throw new Error("Instancia MySQL inesperada. No se ejecutaron migraciones.");
    }
    if (!config.rootInitialized) {
      await root.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [config.rootPassword]);
      config.rootInitialized = true;
      await fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    }
    // Name is a code constant, never a user supplied SQL identifier.
    await root.query(`CREATE DATABASE IF NOT EXISTS ${LOCAL_DATABASE} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await root.query("CREATE USER IF NOT EXISTS 'calls_auth_local'@'127.0.0.1' IDENTIFIED BY ?", [config.password]);
    await root.query(`GRANT SELECT,INSERT,UPDATE,DELETE,CREATE,REFERENCES ON ${LOCAL_DATABASE}.* TO 'calls_auth_local'@'127.0.0.1'`);
  } finally { await root.end(); }

  const connection = await mysql.createConnection({ host: config.host, port: config.port,
    user: config.user, password: config.password, database: config.database, timezone: "Z" });
  try {
    await verifyDatabase(connection);
    console.log(`Verificado: 127.0.0.1:${mysqlPort} / ${LOCAL_DATABASE}.`);
    for (const sql of AUTH_SCHEMA) await connection.query(sql);
    const accountsFile = path.join(localDir, "test-accounts.json");
    let accounts;
    if (await exists(accountsFile)) accounts = JSON.parse(await fs.readFile(accountsFile, "utf8"));
    else {
      accounts = [
        { username: "empleado.prueba", role: "EMPLEADO", password: randomBytes(18).toString("base64url") },
        { username: "admin.prueba", role: "ADMINISTRADOR", password: randomBytes(18).toString("base64url") }
      ];
      await fs.writeFile(accountsFile, JSON.stringify(accounts, null, 2), { mode: 0o600, flag: "wx" });
    }
    for (const account of accounts) {
      const [existing] = await connection.query("SELECT id FROM auth_users WHERE username=?", [account.username]);
      if (!existing.length) await connection.query("INSERT INTO auth_users(username,password_hash,role) VALUES (?,?,?)",
        [account.username, await hashPassword(account.password), account.role]);
    }
  } finally { await connection.end(); }
  return config;
}
