import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const TABLE = `CREATE TABLE IF NOT EXISTS email_smtp_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  host VARCHAR(180) NOT NULL,
  port SMALLINT UNSIGNED NOT NULL DEFAULT 587,
  secure BOOLEAN NOT NULL DEFAULT FALSE,
  username VARCHAR(180) NOT NULL DEFAULT '',
  password_enc TEXT NULL,
  from_address VARCHAR(180) NOT NULL DEFAULT '',
  from_name VARCHAR(120) NOT NULL DEFAULT '',
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const SECRET_FILE = path.resolve(process.cwd(), "backend", ".smtp-secret");
let schemaReady = false;
let secretPromise;

async function ensureSchema(pool) {
  if (schemaReady) return;
  await pool.query(TABLE);
  schemaReady = true;
}

async function getSecret() {
  if (!secretPromise) {
    secretPromise = (async () => {
      try {
        const value = (await fs.readFile(SECRET_FILE, "utf8")).trim();
        if (value && value.length >= 32) return Buffer.from(value, "hex");
      } catch { /* se crea abajo */ }
      const key = crypto.randomBytes(32);
      await fs.writeFile(SECRET_FILE, key.toString("hex"), { mode: 0o600 });
      return key;
    })().catch(error => {
      secretPromise = null;
      throw error;
    });
  }
  return secretPromise;
}

async function encrypt(value) {
  if (!value) return null;
  const key = await getSecret();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("hex")].join(":");
}

async function decrypt(value) {
  if (!value) return "";
  try {
    const [ivHex, tagHex, dataHex] = String(value).split(":");
    const key = await getSecret();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

export function createSmtpSettings(runtime) {
  const pool = () => runtime.auth.pool || runtime.persistence.pool;

  async function get() {
    const db = pool();
    if (!db) return null;
    await ensureSchema(db);
    const [rows] = await db.query(`SELECT id,host,port,secure,username,password_enc,from_address,from_name,updated_by,updated_at
      FROM email_smtp_settings WHERE id=1`);
    if (!rows.length) return null;
    const row = rows[0];
    return {
      host: row.host,
      port: Number(row.port),
      secure: Boolean(row.secure),
      username: row.username || "",
      password: await decrypt(row.password_enc),
      fromAddress: row.from_address || "",
      fromName: row.from_name || "",
      updatedBy: row.updated_by,
      updatedAt: row.updated_at
    };
  }

  async function getPublic() {
    const settings = await get();
    return {
      configured: Boolean(settings && settings.host && settings.fromAddress),
      fromAddress: settings?.fromAddress || "",
      fromName: settings?.fromName || ""
    };
  }

  async function save(input, userId) {
    const host = String(input.host || "").trim().slice(0, 180);
    const port = Number(input.port || 587);
    const secure = Boolean(input.secure);
    const username = String(input.username || "").trim().slice(0, 180);
    const password = String(input.password || "").trim().slice(0, 200);
    const fromAddress = String(input.fromAddress || "").trim().slice(0, 180);
    const fromName = String(input.fromName || "").trim().slice(0, 120);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error("Host y puerto SMTP son obligatorios y deben ser válidos."), { status: 400 });
    }
    if (!isEmail(fromAddress)) {
      throw Object.assign(new Error("La dirección From debe ser un correo válido."), { status: 400 });
    }
    if (password.length > 200) {
      throw Object.assign(new Error("La contraseña SMTP es demasiado larga."), { status: 400 });
    }
    const db = pool();
    if (!db) throw Object.assign(new Error("Base de datos no disponible."), { status: 503 });
    await ensureSchema(db);
    const passwordEnc = password ? await encrypt(password) : null;
    const passwordUpdate = password ? ", password_enc=VALUES(password_enc)" : "";
    await db.query(`INSERT INTO email_smtp_settings
      (id,host,port,secure,username,password_enc,from_address,from_name,updated_by,updated_at)
      VALUES (1,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE host=VALUES(host),port=VALUES(port),secure=VALUES(secure),
        username=VALUES(username)${passwordUpdate},from_address=VALUES(from_address),from_name=VALUES(from_name),
        updated_by=VALUES(updated_by),updated_at=CURRENT_TIMESTAMP(3)`,
    [host, port, secure ? 1 : 0, username, passwordEnc, fromAddress, fromName, userId || null]);
    return getPublic();
  }

  return { get, getPublic, save };
}
