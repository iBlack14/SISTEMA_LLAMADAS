import express from "express";
import { saveCallRecording, getCallRecording, deleteCallRecording, listAnsweredRecordings, RECORDING_RETENTION_DAYS } from "../services/calls/call-recordings.js";

function isValidPairingToken(session, token) {
  const candidate = String(token || "").trim();
  if (!session || !candidate) return false;
  if (session.pairingToken && session.pairingToken === candidate) return true;
  return (session.pairingSlots || []).some(slot => slot.token && slot.token === candidate);
}

/**
 * Rutas para subir grabaciones desde Android y reproducirlas desde Reportes.
 */
export function registerRecordings(runtime) {
  const rawAudioParser = express.raw({
    type: ["audio/*", "application/octet-stream"],
    limit: "15mb"
  });

  function authorizeUpload(req, res, next) {
    const code = String(req.params.code || "").toUpperCase().trim();
    const session = runtime.sessions.get(code);
    const token = String(req.headers["x-pairing-token"] || "").trim();
    if (!isValidPairingToken(session, token)) {
      return res.status(401).json({ ok: false, error: "Token inválido para subir grabación" });
    }
    const slot = session.pairingSlots?.find(item => item.token === token);
    if (slot && !slot.deviceId) return res.status(403).json({ ok: false, error: "El equipo ya no está vinculado." });
    res.locals.recordingWorkerId = slot?.deviceId || "";
    next();
  }

  runtime.app.get("/api/admin/recordings", runtime.auth.requireAdmin, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const field = key => typeof req.query[key] === "string" ? req.query[key].trim() : "";
    const from = field("from");
    const to = field("to");
    const list = field("list");
    const worker = field("worker");
    const search = field("search");
    const offset = Number(field("offset") || 0);
    const validDate = value => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
    if (!validDate(from) || !validDate(to) || (from && to && from > to) ||
        list.length > 255 || worker.length > 255 || search.length > 100 ||
        !Number.isSafeInteger(offset) || offset < 0) {
      return res.status(400).json({ ok: false, error: "Revisa los filtros y el rango de fechas." });
    }
    try {
      return res.json({ ok: true, ...await listAnsweredRecordings(runtime.persistence.pool, {
        from, to, list, worker, search, offset, limit: 25
      }) });
    } catch (error) {
      console.error("[RECORDINGS] Error consultando el catálogo:", error.code || error.name);
      return res.status(503).json({ ok: false, error: "No se pudieron cargar las grabaciones." });
    }
  });

  runtime.app.post("/api/session/:code/recordings/:attemptId", authorizeUpload, rawAudioParser, async (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const attemptId = String(req.params.attemptId || "").trim();
    if (!code || code.length > 50 || !attemptId || attemptId.length > 96) {
      return res.status(400).json({ ok: false, error: "code y attemptId son requeridos" });
    }
    const audioBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (audioBuffer.length < 12 || audioBuffer.toString("ascii", 4, 8) !== "ftyp") {
      return res.status(400).json({ ok: false, error: "Se esperaba audio M4A." });
    }

    try {
      const pool = runtime.persistence.pool;
      const [[attempt]] = await pool.query(
        `SELECT contact_id, phone, worker_id, connected_at, ended_at, connected_seconds, technical_result,
                ended_at <= UTC_TIMESTAMP(3) - INTERVAL ${RECORDING_RETENTION_DAYS} DAY AS expired
           FROM vc_call_attempts WHERE session_code=? AND attempt_id=?`, [code, attemptId]);
      if (!attempt || !attempt.ended_at) {
        return res.status(409).json({ ok: false, error: "El cierre de la llamada está pendiente." });
      }
      if (res.locals.recordingWorkerId && attempt.worker_id !== res.locals.recordingWorkerId) {
        return res.status(403).json({ ok: false, error: "El intento pertenece a otro equipo." });
      }
      if (attempt.expired) return res.status(410).json({ ok: false, error: "Terminó el plazo para guardar esta grabación." });
      if (!attempt.connected_at || attempt.technical_result !== "contesto") {
        return res.status(422).json({ ok: false, error: "El intento no corresponde a una llamada contestada." });
      }
      const saved = await saveCallRecording(pool, {
        sessionCode: code,
        attemptId,
        contactId: attempt.contact_id,
        phone: attempt.phone,
        mimeType: "audio/mp4",
        durationSeconds: attempt.connected_seconds,
        audioBuffer
      });
      return res.json({ ok: true, recording: saved });
    } catch (error) {
      console.error("[RECORDINGS] Error guardando grabación:", error.code || error.name);
      return res.status(503).json({ ok: false, error: "No se pudo guardar la grabación en MySQL" });
    }
  });

  runtime.app.delete("/api/admin/recordings/:code/:attemptId", runtime.auth.requireAdmin, async (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const attemptId = String(req.params.attemptId || "").trim();
    if (code.length > 50 || attemptId.length > 96) {
      return res.status(400).json({ ok: false, error: "Parámetros inválidos." });
    }
    try {
      const deleted = await deleteCallRecording(runtime.persistence.pool, code, attemptId);
      if (!deleted) return res.status(404).json({ ok: false, error: "Grabación no encontrada." });
      console.info(`[RECORDINGS] Grabación eliminada code=${code} attempt=${attemptId}`);
      return res.json({ ok: true, deleted });
    } catch (error) {
      console.error("[RECORDINGS] Error eliminando grabación:", error.code || error.name);
      return res.status(503).json({ ok: false, error: "No se pudo eliminar la grabación." });
    }
  });

  runtime.app.get("/api/session/:code/recordings/:attemptId", runtime.auth.requireAdmin, async (req, res) => {
    const code = String(req.params.code || "").toUpperCase().trim();
    const attemptId = String(req.params.attemptId || "").trim();
    if (code.length > 50 || attemptId.length > 96) return res.sendStatus(400);

    try {
      const recording = await getCallRecording(runtime.persistence.pool, code, attemptId);
      if (!recording || !recording.audio_data) {
        return res.status(404).json({ ok: false, error: "Grabación no encontrada" });
      }
      const buffer = Buffer.isBuffer(recording.audio_data)
        ? recording.audio_data
        : Buffer.from(recording.audio_data);
      const total = buffer.length;
      const mimeType = recording.mime_type === "audio/wav" ? "audio/wav" : "audio/mp4";
      const rangeHeader = String(req.headers.range || "");

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Cache-Control", "no-store");

      if (rangeHeader.startsWith("bytes=")) {
        const ranges = req.range(total);
        if (!Array.isArray(ranges) || ranges.length !== 1) {
          res.setHeader("Content-Range", `bytes */${total}`);
          return res.status(416).end();
        }
        const [{ start, end }] = ranges;
        const chunk = buffer.subarray(start, end + 1);
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(chunk.length));
        return res.end(chunk);
      }

      res.setHeader("Content-Length", String(total));
      return res.end(buffer);
    } catch (error) {
      console.error("[RECORDINGS] Error leyendo grabación:", error.code || error.name);
      return res.status(503).json({ ok: false, error: "No se pudo obtener la grabación" });
    }
  });
}
