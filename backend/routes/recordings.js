import express from "express";
import { saveCallRecording, getCallRecording } from "../services/calls/call-recordings.js";

function isValidPairingToken(session, token) {
  const candidate = String(token || "").trim();
  if (!session || !candidate) return false;
  if (session.pairingToken && session.pairingToken === candidate) return true;
  return (session.pairingSlots || []).some(slot => slot.token && slot.token === candidate);
}

/**
 * Rutas para subir grabaciones desde Android y reproducirlas desde Reportes.
 */
export function registerRecordings(runtime, services) {
  const rawAudioParser = express.raw({
    type: ["audio/*", "application/octet-stream"],
    limit: "15mb"
  });

  runtime.app.post("/api/session/:code/recordings/:attemptId", rawAudioParser, async (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const attemptId = String(req.params.attemptId || "").trim();
    if (!code || !attemptId) {
      return res.status(400).json({ ok: false, error: "code y attemptId son requeridos" });
    }
    const session = runtime.sessions.get(code);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });

    const token = req.headers["x-pairing-token"] || req.query.token || "";
    const authorized = isValidPairingToken(session, token) || services.hasDashboardAccess(req, session);
    if (!authorized) return res.status(401).json({ ok: false, error: "Token inválido para subir grabación" });

    const audioBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!audioBuffer.length) {
      return res.status(400).json({ ok: false, error: "Archivo de audio vacío" });
    }

    try {
      const saved = await saveCallRecording(runtime.persistence.pool, {
        sessionCode: code,
        attemptId,
        contactId: String(req.query.contactId || req.headers["x-contact-id"] || ""),
        phone: String(req.query.phone || req.headers["x-phone"] || ""),
        mimeType: String(req.headers["content-type"] || "audio/mp4").split(";")[0].trim(),
        durationSeconds: Number(req.query.durationSeconds || req.headers["x-duration-seconds"] || 0),
        audioBuffer
      });
      return res.json({ ok: true, recording: saved });
    } catch (error) {
      console.error("[RECORDINGS] Error guardando grabación:", error?.message || error);
      return res.status(503).json({ ok: false, error: "No se pudo guardar la grabación en MySQL" });
    }
  });

  runtime.app.get("/api/session/:code/recordings/:attemptId", async (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const attemptId = String(req.params.attemptId || "").trim();
    const session = runtime.sessions.get(code);
    if (!session) return res.status(404).json({ ok: false, error: "Sesión no encontrada" });
    if (!services.hasDashboardAccess(req, session)) {
      return res.status(403).json({ ok: false, error: "Acceso no autorizado" });
    }

    try {
      const recording = await getCallRecording(runtime.persistence.pool, code, attemptId);
      if (!recording || !recording.audio_data) {
        return res.status(404).json({ ok: false, error: "Grabación no encontrada" });
      }
      const buffer = Buffer.isBuffer(recording.audio_data)
        ? recording.audio_data
        : Buffer.from(recording.audio_data);
      const total = buffer.length;
      const mimeType = recording.mime_type || "audio/mp4";
      const rangeHeader = String(req.headers.range || "");

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "private, max-age=300");

      if (rangeHeader.startsWith("bytes=")) {
        const [startStr, endStr] = rangeHeader.replace("bytes=", "").split("-");
        const start = Math.max(0, Number.parseInt(startStr, 10) || 0);
        const end = endStr ? Math.min(total - 1, Number.parseInt(endStr, 10)) : total - 1;
        if (start >= total || start > end) {
          res.setHeader("Content-Range", `bytes */${total}`);
          return res.status(416).end();
        }
        const chunk = buffer.subarray(start, end + 1);
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(chunk.length));
        return res.end(chunk);
      }

      res.setHeader("Content-Length", String(total));
      return res.end(buffer);
    } catch (error) {
      console.error("[RECORDINGS] Error leyendo grabación:", error?.message || error);
      return res.status(503).json({ ok: false, error: "No se pudo obtener la grabación" });
    }
  });
}
