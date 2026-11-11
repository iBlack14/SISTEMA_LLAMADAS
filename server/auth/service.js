import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { AUTH_SCHEMA } from "./schema.js";
import { hashPassword, verifyPassword } from "./passwords.js";

const digest = value => createHash("sha256").update(value).digest("hex");
const cookieName = "calls_local_sid";
const idleMinutes = 30;
const lifetimeMs = 8 * 60 * 60 * 1000;
const safeEqual = (a, b) => typeof a === "string" && typeof b === "string"
  && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class AuthService {
  constructor(pool, { origins, secure = false }) {
    this.pool = pool;
    this.origins = new Set(origins);
    this.secure = secure;
    this.attempts = new Map();
  }

  async initialize() {
    for (const sql of AUTH_SCHEMA) await this.pool.query(sql);
    this.dummyHash = await hashPassword(randomBytes(32).toString("hex"));
  }

  token(req) {
    const match = String(req.headers.cookie || "").split(";")
      .map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
    const value = match?.slice(cookieName.length + 1) || "";
    return /^[a-f0-9]{64}$/.test(value) ? value : "";
  }

  async resolve(req, touch = true) {
    const token = this.token(req);
    if (!token) return null;
    const hash = digest(token);
    const [rows] = await this.pool.query(`SELECT u.id,u.username,u.role,s.csrf_token
      FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
      WHERE s.token_hash=? AND u.active=1 AND s.auth_version=u.auth_version
      AND s.expires_at>UTC_TIMESTAMP(3)
      AND s.last_seen_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ${idleMinutes} MINUTE)`, [hash]);
    if (!rows.length) return null;
    if (touch) await this.pool.query("UPDATE auth_sessions SET last_seen_at=UTC_TIMESTAMP(3) WHERE token_hash=?", [hash]);
    return { id: rows[0].id, username: rows[0].username, role: rows[0].role,
      csrfToken: rows[0].csrf_token, tokenHash: hash };
  }

  publicUser(user) { return { id: user.id, username: user.username, role: user.role }; }

  async canAccess(user, code) {
    if (!user || !code) return false;
    // Operational data stays private to explicitly authorized accounts in every environment.
    const [rows] = await this.pool.query(
      "SELECT 1 FROM auth_session_access WHERE user_id=? AND session_code=?", [user.id, code]);
    return rows.length > 0;
  }

  async grant(user, code) {
    await this.pool.query("INSERT IGNORE INTO auth_session_access(user_id,session_code) VALUES (?,?)", [user.id, code]);
  }

  validOrigin(req) { return this.origins.has(req.headers.origin); }

  cookie(res, token, maxAge = lifetimeMs) {
    res.cookie(cookieName, token, { httpOnly: true, sameSite: "lax", secure: this.secure,
      path: "/", maxAge });
  }

  async revoke(req) {
    const token = this.token(req);
    if (token) await this.pool.query("DELETE FROM auth_sessions WHERE token_hash=?", [digest(token)]);
    return token ? digest(token) : "";
  }

  checkRate(ip, username) {
    const now = Date.now();
    for (const [key, bucket] of this.attempts) if (bucket.until <= now) this.attempts.delete(key);
    const keys = [`ip:${ip}`, `user:${username}`];
    const limits = [30, 10];
    if (keys.some((key, i) => (this.attempts.get(key)?.count || 0) >= limits[i])) return false;
    keys.forEach(key => {
      const bucket = this.attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
      bucket.count++;
      this.attempts.set(key, bucket);
    });
    return true;
  }

  middleware() {
    return async (req, res, next) => {
      try { req.user = await this.resolve(req); next(); }
      catch { res.status(503).json({ ok: false, error: "Autenticación temporalmente no disponible." }); }
    };
  }

  requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: "Inicia sesión." });
    next();
  };

  requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: "Inicia sesión." });
    if (req.user.role !== "ADMINISTRADOR") return res.status(403).json({ ok: false, error: "Acceso exclusivo de administrador." });
    next();
  };

  csrf = (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (!this.validOrigin(req) || !safeEqual(req.headers["x-csrf-token"], req.user?.csrfToken)) {
      return res.status(403).json({ ok: false, error: "Solicitud no autorizada. Recarga la página." });
    }
    next();
  };

  routes(app, disconnect) {
    app.use("/api/auth", (_, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
    app.post("/api/auth/login", async (req, res) => {
      if (!this.validOrigin(req) || !req.is("application/json")) return res.status(403).json({ ok: false, error: "Origen no autorizado." });
      const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
      const password = req.body?.password;
      if (!/^[a-z0-9._-]{3,80}$/.test(username) || typeof password !== "string" || password.length > 256) {
        return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos." });
      }
      if (!this.checkRate(req.ip, username)) {
        res.setHeader("Retry-After", "900");
        return res.status(429).json({ ok: false, error: "Demasiados intentos. Intenta de nuevo en 15 minutos." });
      }
      try {
        const [rows] = await this.pool.query("SELECT * FROM auth_users WHERE username=?", [username]);
        const user = rows[0];
        const valid = await verifyPassword(password, user?.password_hash || this.dummyHash);
        if (!valid || !user?.active) return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos." });
        const oldHash = await this.revoke(req);
        if (oldHash) disconnect(oldHash);
        const token = randomBytes(32).toString("hex");
        await this.pool.query(`INSERT INTO auth_sessions
          (token_hash,user_id,auth_version,csrf_token,expires_at,last_seen_at)
          VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`,
        [digest(token), user.id, user.auth_version, randomBytes(32).toString("hex"), new Date(Date.now() + lifetimeMs)]);
        this.cookie(res, token);
        this.attempts.delete(`user:${username}`);
        res.json({ ok: true, user: this.publicUser(user), redirect: user.role === "ADMINISTRADOR" ? "/admin/nucleo-red" : "/" });
      } catch { res.status(503).json({ ok: false, error: "No se pudo iniciar sesión." }); }
    });
    app.get("/api/auth/me", this.requireUser, (req, res) => {
      res.json({ ok: true, user: this.publicUser(req.user), csrfToken: req.user.csrfToken });
    });
    app.post("/api/auth/logout", this.requireUser, this.csrf, async (req, res) => {
      try {
        const hash = await this.revoke(req);
        this.cookie(res, "", 0);
        disconnect(hash);
        res.json({ ok: true });
      } catch { res.status(503).json({ ok: false, error: "No se pudo cerrar sesión. Intenta de nuevo." }); }
    });
  }
}
