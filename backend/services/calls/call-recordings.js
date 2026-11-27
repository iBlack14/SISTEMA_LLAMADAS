/**
 * Persistencia de grabaciones de llamadas contestadas en MySQL (vc_call_recordings).
 */
export const RECORDING_RETENTION_DAYS = 7;
const expiration = `CURRENT_TIMESTAMP(3) - INTERVAL ${RECORDING_RETENTION_DAYS} DAY`;

export async function purgeExpiredRecordings(pool) {
  const batchSize = 50;
  let deleted = 0;
  for (let batch = 0; batch < 10; batch++) {
    const [result] = await pool.query(
      `DELETE FROM vc_call_recordings WHERE created_at <= ${expiration}
       ORDER BY created_at LIMIT ?`, [batchSize]);
    deleted += result.affectedRows;
    if (result.affectedRows < batchSize) break;
  }
  return deleted;
}

export function startRecordingRetention(pool) {
  let active = false;
  let indexChecked = false;
  async function purge() {
    if (active) return;
    active = true;
    try {
      if (!indexChecked) {
        indexChecked = true;
        try {
          const [indexes] = await pool.query("SHOW INDEX FROM vc_call_recordings WHERE Key_name = 'vc_recording_created'");
          if (!indexes.length) {
            await pool.query("ALTER TABLE vc_call_recordings ADD INDEX vc_recording_created (created_at)");
          }
        } catch (error) {
          if (error.code !== "ER_DUP_KEYNAME") console.warn("[RECORDINGS_RETENTION] Índice de fecha:", error.code || error.name);
        }
      }
      const deleted = await purgeExpiredRecordings(pool);
      if (deleted) console.info(`[RECORDINGS_RETENTION] expired=${deleted}`);
    } catch (error) {
      console.error("[RECORDINGS_RETENTION] Error eliminando audios vencidos:", error.code || error.name);
    } finally {
      active = false;
    }
  }
  void purge();
  return setInterval(purge, 60_000).unref();
}

export async function saveCallRecording(pool, {
  sessionCode,
  attemptId,
  contactId = "",
  phone = "",
  mimeType = "audio/mp4",
  durationSeconds = 0,
  audioBuffer
}) {
  if (!pool) throw new Error("MySQL no está disponible.");
  if (!sessionCode || !attemptId || !Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    throw new Error("Datos de grabación inválidos.");
  }
  const safeCode = String(sessionCode).slice(0, 50);
  const safeAttemptId = String(attemptId).slice(0, 96);
  const safeContactId = String(contactId || "").slice(0, 191);
  const safePhone = String(phone || "").slice(0, 64);
  const safeMime = String(mimeType || "audio/mp4").slice(0, 64);
  const safeDuration = Math.max(0, Math.round(Number(durationSeconds || 0)));

  await pool.execute(
    `INSERT INTO vc_call_recordings
      (session_code, attempt_id, contact_id, phone, mime_type, duration_seconds, size_bytes, audio_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE attempt_id=vc_call_recordings.attempt_id`,
    [safeCode, safeAttemptId, safeContactId, safePhone, safeMime, safeDuration, audioBuffer.length, audioBuffer]
  );

  return {
    sessionCode: safeCode,
    attemptId: safeAttemptId,
    sizeBytes: audioBuffer.length,
    durationSeconds: safeDuration,
    mimeType: safeMime
  };
}

export async function listAnsweredRecordings(pool, { from, to, list, worker, search, sessionCodes, shift, offset, limit }) {
  const conditions = ["a.ended_at IS NOT NULL"];
  const values = [];
  const add = (condition, ...args) => { conditions.push(condition); values.push(...args); };
  if (from) add("a.report_date>=?", from);
  if (to) add("a.report_date<=?", to);
  if (list) add("c.list_name=?", list);
  if (worker) add("(a.worker_id=? OR d.name=?)", worker, worker);
  if (Array.isArray(sessionCodes)) add(`a.session_code IN (${sessionCodes.map(() => "?").join(",")})`, ...sessionCodes);
  if (shift) {
    const pattern = shift === "morning" ? "%MAÑANA%" : shift === "afternoon" ? "%TARDE%" : "%FUERA%";
    add("t.label LIKE ?", pattern);
  }
  if (search) {
    const pattern = search.replace(/[!%_]/g, char => "!" + char) + "%";
    add("(a.phone LIKE ? ESCAPE '!' OR c.name LIKE ? ESCAPE '!')", pattern, pattern);
  }
  const joins = `LEFT JOIN vc_call_contacts c ON c.session_code=a.session_code AND c.contact_id=a.contact_id
       LEFT JOIN vc_call_devices d ON d.session_code=a.session_code AND d.device_id=a.worker_id
       LEFT JOIN vc_call_turns t ON t.session_code=a.session_code AND t.turn_id=a.shift_id`;
  const [summaryRows] = await pool.query(
    `SELECT COUNT(CASE WHEN a.technical_result='buzon_de_voz' THEN 1 END) AS voicemail,
            COUNT(CASE WHEN a.connected_at IS NOT NULL AND a.connected_seconds < 10 THEN 1 END) AS shortCalls,
            COUNT(CASE WHEN a.connected_at IS NOT NULL AND a.connected_seconds >= 25 THEN 1 END) AS longCalls,
            COALESCE(SUM(CASE WHEN a.connected_at IS NOT NULL AND a.connected_seconds >= 25 THEN a.connected_seconds ELSE 0 END),0) AS longSeconds
       FROM vc_call_attempts a ${joins} WHERE ${conditions.join(" AND ")}`, values);
  const recordingConditions = [...conditions, "a.technical_result='contesto'", "a.connected_at IS NOT NULL", "r.duration_seconds>=30", `r.created_at > ${expiration}`];
  const [rows] = await pool.query(
    `SELECT a.session_code AS sessionCode, a.attempt_id AS attemptId, a.phone,
            a.started_at AS startedAt, a.connected_at AS connectedAt, a.ended_at AS endedAt,
            a.connected_seconds AS connectedSeconds, a.commercial_result AS result,
            c.name AS contact, c.list_name AS list, COALESCE(d.name,a.worker_id) AS worker,
            r.duration_seconds AS durationSeconds, r.size_bytes AS sizeBytes
       FROM vc_call_recordings r
       JOIN vc_call_attempts a ON a.session_code=r.session_code AND a.attempt_id=r.attempt_id
       ${joins}
      WHERE ${recordingConditions.join(" AND ")}
      ORDER BY a.report_date DESC, a.started_at DESC, a.session_code DESC, a.attempt_id DESC
      LIMIT ? OFFSET ?`, [...values, limit + 1, offset]);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit, summary: summaryRows[0] };
}

export async function getCallRecording(pool, sessionCode, attemptId) {
  if (!pool || !sessionCode || !attemptId) return null;
  const [rows] = await pool.query(
    `SELECT session_code, attempt_id, contact_id, phone, mime_type, duration_seconds, size_bytes, audio_data, created_at
     FROM vc_call_recordings
     WHERE session_code = ? AND attempt_id = ?
       AND created_at > ${expiration}
     LIMIT 1`,
    [String(sessionCode).slice(0, 50), String(attemptId).slice(0, 96)]
  );
  return rows[0] || null;
}

export async function deleteCallRecording(pool, sessionCode, attemptId) {
  if (!pool || !sessionCode || !attemptId) return 0;
  const [result] = await pool.query(
    "DELETE FROM vc_call_recordings WHERE session_code = ? AND attempt_id = ?",
    [String(sessionCode).slice(0, 50), String(attemptId).slice(0, 96)]
  );
  return result.affectedRows;
}
