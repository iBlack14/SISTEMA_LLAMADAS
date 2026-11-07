import { createHash } from "node:crypto";
import { collectReportAttempts } from "./report-attempts.js";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit"
});
const text = value => String(value ?? "");
const seconds = (from, to) => from && to
  ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) || 0 : 0;

export function stableAttemptId(row) {
  return text(row.attemptId) || "legacy-" + createHash("sha256")
    .update(JSON.stringify([row.contactId, row.phone, row.workerId, row.attemptNumber, row.startedAt]))
    .digest("hex");
}

export function mergeAttempt(previous, incoming) {
  if (!previous) return { ...incoming };
  // A late dialing/active snapshot cannot reopen or erase a finished attempt.
  if (previous.endedAt && !incoming.endedAt) return { ...incoming, ...previous };
  const merged = { ...previous, ...incoming };
  for (const field of ["startedAt", "answeredAt", "endedAt", "campaignId", "shiftId", "shiftLabel"]) {
    merged[field] = incoming[field] || previous[field] || "";
  }
  merged.durationSeconds = Math.max(Number(previous.durationSeconds || 0), Number(incoming.durationSeconds || 0));
  return merged;
}

export function collectCallAttempts(session) {
  const campaign = session.campaign || {};
  const shift = session.shiftManagement?.current;
  const rows = new Map();
  const add = (row, campaignId = "") => {
    if (!row.startedAt && !row.endedAt) return;
    const time = Date.parse(row.startedAt);
    const attemptId = stableAttemptId(row);
    const inShift = shift && Number.isFinite(time) && time >= Date.parse(shift.startedAt) &&
      (!shift.endedAt || time <= Date.parse(shift.endedAt));
    const normalized = {
      ...row, attemptId,
      campaignId: row.campaignId || rows.get(attemptId)?.campaignId || campaignId,
      shiftId: row.shiftId || (inShift ? shift.id : "") || "",
      shiftLabel: row.shiftLabel || (inShift ? shift.label : "") || "",
      reportDate: Number.isFinite(time) ? dateFormatter.format(new Date(time)) : row.reportDate || "",
      durationSeconds: Number(row.durationSeconds || 0),
      waitingSeconds: seconds(row.startedAt, row.answeredAt || row.endedAt),
      totalSeconds: seconds(row.startedAt, row.endedAt),
      technicalResult: row.technicalResult || "",
      disposition: row.disposition || ""
    };
    rows.set(attemptId, mergeAttempt(rows.get(attemptId), normalized));
  };
  for (const archive of session.reportArchive || []) for (const row of archive.history || []) add(row, archive.id);
  // Contact attemptHistory also contains live attempts, not just completed calls.
  for (const contact of campaign.contacts || []) {
    for (const attempt of contact.attemptHistory || []) add({
      attemptId: attempt.id, contactId: contact.id, name: contact.name, phone: contact.phone,
      list: contact.list || campaign.listName || "", workerId: attempt.workerId,
      workerName: attempt.workerName, attemptNumber: attempt.number,
      startedAt: attempt.startedAt, answeredAt: attempt.answeredAt, endedAt: attempt.endedAt,
      durationSeconds: attempt.durationSeconds, technicalResult: attempt.technicalResult,
      disposition: attempt.disposition || ""
    }, campaign.reportRunId || "");
  }
  for (const row of collectReportAttempts(session)) add(row, campaign.reportRunId || "");
  return [...rows.values()];
}

export const HISTORY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS vc_call_contacts (
    session_code VARCHAR(50) NOT NULL, contact_id VARCHAR(191) NOT NULL,
    name VARCHAR(255) NOT NULL, phone VARCHAR(64) NOT NULL, list_name VARCHAR(255) NOT NULL,
    PRIMARY KEY(session_code, contact_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS vc_call_devices (
    session_code VARCHAR(50) NOT NULL, device_id VARCHAR(191) NOT NULL, name VARCHAR(255) NOT NULL,
    PRIMARY KEY(session_code, device_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS vc_call_campaigns (
    session_code VARCHAR(50) NOT NULL, campaign_id VARCHAR(191) NOT NULL, list_name VARCHAR(255) NOT NULL,
    PRIMARY KEY(session_code, campaign_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS vc_call_turns (
    session_code VARCHAR(50) NOT NULL, turn_id VARCHAR(191) NOT NULL, label VARCHAR(255) NOT NULL,
    PRIMARY KEY(session_code, turn_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS vc_call_attempts (
    session_code VARCHAR(50) NOT NULL, attempt_id VARCHAR(96) NOT NULL,
    contact_id VARCHAR(191) NOT NULL, campaign_id VARCHAR(191) NOT NULL,
    shift_id VARCHAR(191) NOT NULL, worker_id VARCHAR(191) NOT NULL,
    phone VARCHAR(64) NOT NULL, report_date DATE NULL,
    started_at DATETIME(3) NULL, connected_at DATETIME(3) NULL, ended_at DATETIME(3) NULL,
    waiting_seconds INT UNSIGNED NOT NULL DEFAULT 0,
    connected_seconds INT UNSIGNED NOT NULL DEFAULT 0,
    total_seconds INT UNSIGNED NOT NULL DEFAULT 0,
    technical_result VARCHAR(64) NOT NULL, commercial_result VARCHAR(64) NOT NULL,
    row_data JSON NOT NULL,
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY(session_code, attempt_id),
    INDEX vc_attempt_date(session_code, report_date, started_at),
    INDEX vc_attempt_phone(session_code, phone, started_at),
    INDEX vc_attempt_worker(session_code, worker_id, started_at),
    INDEX vc_attempt_turn(session_code, shift_id, started_at),
    INDEX vc_attempt_result(session_code, technical_result, started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

function sqlDate(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString().slice(0,23).replace("T"," ") : null;
}
const limit = (value, size = 191) => text(value).slice(0, size);

export async function writeCallAttempts(connection, code, rows) {
  for (const incoming of rows) {
    const [existing] = await connection.query(
      "SELECT row_data FROM vc_call_attempts WHERE session_code=? AND attempt_id=? FOR UPDATE",
      [code, limit(incoming.attemptId,96)]);
    const stored = existing[0]?.row_data;
    const row = mergeAttempt(typeof stored === "string" ? JSON.parse(stored) : stored, incoming);
    if (row.contactId) await connection.query(
      "INSERT INTO vc_call_contacts (session_code,contact_id,name,phone,list_name) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),phone=VALUES(phone),list_name=VALUES(list_name)",
      [code, limit(row.contactId), limit(row.name,255), limit(row.phone,64), limit(row.list,255)]);
    if (row.workerId) await connection.query(
      "INSERT INTO vc_call_devices (session_code,device_id,name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)",
      [code, limit(row.workerId), limit(row.workerName || row.worker,255)]);
    if (row.campaignId) await connection.query(
      "INSERT INTO vc_call_campaigns (session_code,campaign_id,list_name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE list_name=VALUES(list_name)",
      [code, limit(row.campaignId), limit(row.list,255)]);
    if (row.shiftId) await connection.query(
      "INSERT INTO vc_call_turns (session_code,turn_id,label) VALUES (?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label)",
      [code, limit(row.shiftId), limit(row.shiftLabel,255)]);
    await connection.query(`INSERT INTO vc_call_attempts
      (session_code,attempt_id,contact_id,campaign_id,shift_id,worker_id,phone,report_date,
       started_at,connected_at,ended_at,waiting_seconds,connected_seconds,total_seconds,
       technical_result,commercial_result,row_data)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
       contact_id=VALUES(contact_id),campaign_id=VALUES(campaign_id),shift_id=VALUES(shift_id),
       worker_id=VALUES(worker_id),phone=VALUES(phone),report_date=VALUES(report_date),
       started_at=VALUES(started_at),connected_at=VALUES(connected_at),ended_at=VALUES(ended_at),
       waiting_seconds=VALUES(waiting_seconds),connected_seconds=VALUES(connected_seconds),
       total_seconds=VALUES(total_seconds),technical_result=VALUES(technical_result),
       commercial_result=VALUES(commercial_result),row_data=VALUES(row_data)`,
      [code, limit(row.attemptId,96), limit(row.contactId), limit(row.campaignId), limit(row.shiftId),
       limit(row.workerId), limit(row.phone,64), row.reportDate || null,
       sqlDate(row.startedAt),sqlDate(row.answeredAt),sqlDate(row.endedAt),
       Math.max(0,Math.round(row.waitingSeconds || 0)),Math.max(0,Math.round(row.durationSeconds || 0)),
       Math.max(0,Math.round(row.totalSeconds || 0)),limit(row.technicalResult,64),
       limit(row.disposition,64),JSON.stringify(row)]);
  }
}
