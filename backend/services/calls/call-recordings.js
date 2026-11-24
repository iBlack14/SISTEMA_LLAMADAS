/**
 * Persistencia de grabaciones de llamadas contestadas en MySQL (vc_call_recordings).
 */

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

  await pool.query(
    `INSERT INTO vc_call_recordings
      (session_code, attempt_id, contact_id, phone, mime_type, duration_seconds, size_bytes, audio_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      contact_id=VALUES(contact_id),
      phone=VALUES(phone),
      mime_type=VALUES(mime_type),
      duration_seconds=VALUES(duration_seconds),
      size_bytes=VALUES(size_bytes),
      audio_data=VALUES(audio_data)`,
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

export async function getCallRecording(pool, sessionCode, attemptId) {
  if (!pool || !sessionCode || !attemptId) return null;
  const [rows] = await pool.query(
    `SELECT session_code, attempt_id, contact_id, phone, mime_type, duration_seconds, size_bytes, audio_data, created_at
     FROM vc_call_recordings
     WHERE session_code = ? AND attempt_id = ?
     LIMIT 1`,
    [String(sessionCode).slice(0, 50), String(attemptId).slice(0, 96)]
  );
  return rows[0] || null;
}

export async function getRecordedAttemptIds(pool, sessionCodes = []) {
  const codes = [...new Set((sessionCodes || []).map(c => String(c || "").trim()).filter(Boolean))];
  if (!pool || !codes.length) return new Map();
  const placeholders = codes.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT session_code, attempt_id, duration_seconds, size_bytes, mime_type
     FROM vc_call_recordings
     WHERE session_code IN (${placeholders})`,
    codes
  );
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.session_code)) result.set(row.session_code, new Map());
    result.get(row.session_code).set(String(row.attempt_id), {
      durationSeconds: Number(row.duration_seconds || 0),
      sizeBytes: Number(row.size_bytes || 0),
      mimeType: String(row.mime_type || "audio/mp4")
    });
  }
  return result;
}
