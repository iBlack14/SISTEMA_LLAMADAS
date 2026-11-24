import { phoneKey } from "../campaigns/contact-book.js";

function deviceLabel(name, workerId) {
  const label = String(name || "").trim();
  const id = String(workerId || "").trim();
  const suffix = id.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase();
  if (!suffix || ["WEBPHONE", "ANDROIDWORKER"].includes(id.replace(/[^a-z0-9]/gi, "").toUpperCase())) {
    return label;
  }
  return `${label || "Equipo"} · ID ${suffix}`;
}

export function hydrateReportDetails(record, session, knownAttempts = new Map()) {
  const workers = new Map((session.phoneWorkers || []).map(worker => [String(worker.id), worker]));
  const calls = (record.history || []).map(attempt => {
    const saved = knownAttempts.get(attempt.attemptId) || {};
    const workerId = String(attempt.workerId || saved.workerId || "");
    const workerName = String(attempt.workerName || saved.workerName || workers.get(workerId)?.name || "").trim();
    return {
      ...saved, ...attempt, workerId,
      workerName: deviceLabel(workerName, workerId),
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
    const workerName = call?.workerName || contact.workerName || contact.assignedWorkerName || workers.get(workerId)?.name || "";
    return {
      ...contact,
      workerId,
      workerName: call?.workerName || deviceLabel(workerName, workerId),
      attemptId: call?.attemptId || contact.attemptId || "",
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
