import multer from "multer";
import { createSmtpSettings } from "../services/email/smtp-settings.js";
import { createMailer } from "../services/email/mailer.js";

const ALLOWED_EXTENSIONS = /\.(pdf|doc|docx|xls|xlsx)$/i;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;
const sendAttempts = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 5, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_EXTENSIONS.test(file.originalname || "")) {
      return cb(Object.assign(new Error("Solo se permiten archivos PDF, Word o Excel."), { status: 400 }));
    }
    cb(null, true);
  }
});

function uploadFiles(req, res, next) {
  upload.array("attachments", 5)(req, res, error => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ ok: false, error: error.message || "No se pudieron recibir los archivos." });
    }
    const total = (req.files || []).reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_TOTAL_SIZE) {
      return res.status(413).json({ ok: false, error: "Los archivos superan el límite total de 20 MB." });
    }
    next();
  });
}

function rateLimited(userId) {
  const now = Date.now();
  const list = (sendAttempts.get(userId) || []).filter(time => now - time < 60000);
  if (list.length >= 10) {
    sendAttempts.set(userId, list);
    return true;
  }
  list.push(now);
  sendAttempts.set(userId, list);
  return false;
}

function fail(res, error) {
  const status = Number(error.status) || 500;
  if (status >= 500) console.error("[EMAIL]", error);
  return res.status(status).json({ ok: false, error: error.message || "No se pudo completar la operación." });
}

export function registerEmail(runtime) {
  const { app, auth } = runtime;
  const settings = createSmtpSettings(runtime);
  const mailer = createMailer(settings);

  app.get("/api/admin/email-settings", auth.requireAdmin, async (req, res) => {
    try {
      const value = await settings.get();
      return res.json({
        ok: true,
        settings: {
          host: value?.host || "",
          port: value?.port || 587,
          secure: Boolean(value?.secure),
          username: value?.username || "",
          hasPassword: Boolean(value?.password),
          fromAddress: value?.fromAddress || "",
          fromName: value?.fromName || "",
          updatedAt: value?.updatedAt || null
        }
      });
    } catch (error) { return fail(res, error); }
  });

  app.put("/api/admin/email-settings", auth.requireAdmin, auth.csrf, async (req, res) => {
    try {
      const publicConfig = await settings.save(req.body || {}, req.user?.id);
      return res.json({ ok: true, settings: publicConfig });
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/admin/email-settings/verify", auth.requireAdmin, auth.csrf, async (_, res) => {
    try {
      return res.json(await mailer.verify());
    } catch (error) { return fail(res, error); }
  });

  app.get("/api/email/settings", auth.requireUser, async (req, res) => {
    try {
      return res.json({ ok: true, ...(await settings.getPublic()) });
    } catch (error) { return fail(res, error); }
  });

  app.post("/api/email/send", auth.requireUser, auth.csrf, uploadFiles, async (req, res) => {
    try {
      if (rateLimited(req.user.id)) {
        return res.status(429).json({ ok: false, error: "Demasiados correos en un minuto. Espera un momento." });
      }
      const to = String(req.body?.to || "").trim();
      const subject = String(req.body?.subject || "").trim();
      const body = String(req.body?.body || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return res.status(400).json({ ok: false, error: "El destinatario no es un correo válido." });
      }
      if (!subject || subject.length > 200) {
        return res.status(400).json({ ok: false, error: "El asunto es obligatorio y no puede superar 200 caracteres." });
      }
      if (!body || body.length > 10000) {
        return res.status(400).json({ ok: false, error: "El cuerpo del correo es obligatorio y no puede superar 10000 caracteres." });
      }
      const result = await mailer.send({ to, subject, body, attachments: req.files || [] });
      return res.json({ ok: true, ...result });
    } catch (error) { return fail(res, error); }
  });
}
