import { phoneKey } from "./contact-book.js";

export function hydrateReportDetails(record, session, knownAttempts = new Map()) {
  const workers = new Map((session.phoneWorkers || []).map(worker => [String(worker.id), worker]));
  const calls = (record.history || []).map(attempt => {
    const saved = knownAttempts.get(attempt.attemptId) || {};
    const workerId = String(attempt.workerId || saved.workerId || "");
    return {
      ...saved, ...attempt, workerId,
      workerName: String(attempt.workerName || saved.workerName || workers.get(workerId)?.name || "").trim(),
      shiftLabel: attempt.shiftLabel || saved.shiftLabel || ""
    };
  });
  const latestById = new Map(), latestByPhone = new Map();
  const remember = (map, key, call) => {
    if (!key) return;
    const old = map.get(key);
    if (!old || Date.parse(call.startedAt || 0) >= Date.parse(old.startedAt || 0)) map.set(key, call);
  };
  for (const call of calls) {
    remember(latestById, String(call.contactId || ""), call);
    remember(latestByPhone, phoneKey(call.phone), call);
  }
  const contacts = (record.contacts || []).map(contact => {
    const call = latestById.get(String(contact.id)) || latestByPhone.get(phoneKey(contact.phone));
    const workerId = String(call?.workerId || contact.assignedWorkerId || contact.targetWorkerId || "");
    return {
      ...contact,
      workerId,
      workerName: call?.workerName || contact.workerName || contact.assignedWorkerName || workers.get(workerId)?.name || "",
      attemptNumber: call?.attemptNumber || contact.attemptNumber || null,
      shiftLabel: call?.shiftLabel || contact.shiftLabel || "",
      answeredAt: call?.answeredAt || null,
      lastCallAt: call?.startedAt || null
    };
  });
  const labelsByTeam = new Map();
  for (const call of calls) {
    if (!call.workerName || !call.shiftLabel) continue;
    if (!labelsByTeam.has(call.workerName)) labelsByTeam.set(call.workerName, new Set());
    labelsByTeam.get(call.workerName).add(call.shiftLabel);
  }
  return {
    ...record, contacts, calls,
    teamShifts: Object.fromEntries([...labelsByTeam].map(([name, labels]) =>
      [name, labels.size === 1 ? [...labels][0] : "TURNOS MIXTOS"]))
  };
}
