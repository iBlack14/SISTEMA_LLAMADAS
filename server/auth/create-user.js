import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { assertXamppConfig } from "./config.js";
import { hashPassword } from "./passwords.js";
import { AUTH_SCHEMA } from "./schema.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

async function readSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Ejecuta este comando desde una terminal interactiva para ingresar la contraseña de forma oculta.");
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Operación cancelada."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const [rawUsername, role, ...extra] = process.argv.slice(2);
  const username = String(rawUsername || "").trim().toLowerCase();
  if (extra.length || !/^[a-z0-9._-]{3,80}$/.test(username)
      || !["EMPLEADO", "ADMINISTRADOR"].includes(role)) {
    throw new Error("Uso: npm run auth:user:add -- <usuario> <EMPLEADO|ADMINISTRADOR>");
  }
  assertXamppConfig();

  const password = await readSecret("Contraseña (mínimo 12 caracteres): ");
  if (password.length < 12 || password.length > 256) throw new Error("La contraseña debe tener entre 12 y 256 caracteres.");
  const confirmation = await readSecret("Confirma la contraseña: ");
  if (password !== confirmation) throw new Error("Las contraseñas no coinciden.");

  const connection = await mysql.createConnection({
    host: "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    timezone: "Z",
    ...(process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {})
  });
  try {
    const [[instance]] = await connection.query("SELECT DATABASE() AS db, @@port AS port");
    if (instance.db !== process.env.DB_NAME || Number(instance.port) !== 3306) {
      throw new Error("La conexión no corresponde a la base XAMPP configurada; no se creó el usuario.");
    }
    for (const statement of AUTH_SCHEMA) await connection.query(statement);
    const [existing] = await connection.query("SELECT id FROM auth_users WHERE username=?", [username]);
    if (existing.length) throw new Error(`El usuario ${username} ya existe.`);
    await connection.query("INSERT INTO auth_users(username,password_hash,role) VALUES (?,?,?)",
      [username, await hashPassword(password), role]);
    console.log(`Usuario ${username} creado con rol ${role}.`);
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
