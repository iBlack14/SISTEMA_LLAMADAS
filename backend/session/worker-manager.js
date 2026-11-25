

/**
 * createWorkerManager: conserva los contratos y reglas existentes.
 * Dependencias: services.createPhoneWorker.
 * Se construye una vez por proceso.
 */
export function createWorkerManager(runtime, services) {
function getConnectedPhoneWorkers(session) {
  return (session.phoneWorkers || []).filter((worker) => worker.connected && worker.socketId);
}

function getPhoneWorkerBySocketId(session, socketId) {
  return (session.phoneWorkers || []).find((worker) => worker.socketId === socketId) || null;
}

function upsertPhoneWorker(session, { socketId, deviceId, deviceName }) {
  const workers = session.phoneWorkers || (session.phoneWorkers = []);
  // Primary match: deviceId. Secondary match: socketId.
  const existingIndex = workers.findIndex((worker) => (deviceId && worker.id === deviceId) || (socketId && worker.socketId === socketId));

  if (existingIndex !== -1) {
    const existing = workers[existingIndex];
    existing.socketId = socketId;
    existing.id = deviceId || existing.id;
    existing.name = deviceName || existing.name;
    existing.connected = Boolean(socketId);
    existing.detectorState = "unknown";
    existing.linkedAt = existing.linkedAt || new Date().toISOString();
    existing.callState = existing.callState || "idle";
    // Remove stale duplicates left by older versions while retaining the
    // canonical object and its campaign-related state.
    for (let index = workers.length - 1; index >= 0; index -= 1) {
      if (index !== existingIndex && workers[index].id === existing.id) workers.splice(index, 1);
    }
    return existing;
  }

  const worker = services.createPhoneWorker({
    socketId,
    deviceId,
    deviceName,
    connected: Boolean(socketId)
  });
  workers.push(worker);
  return worker;
}

function removePhoneWorker(session, socketId) {
  const workers = session.phoneWorkers || [];
  const index = workers.findIndex((worker) => worker.socketId === socketId);
  if (index === -1) return null;

  const [worker] = workers.splice(index, 1);
  return worker;
}

function selectPhoneWorker(session, preferredSocketId = "") {
  const workers = getConnectedPhoneWorkers(session);
  if (!workers.length) return null;

  if (preferredSocketId) {
    const preferred = workers.find((worker) => worker.socketId === preferredSocketId);
    if (preferred) return preferred;
  }

  const idleWorkers = workers.filter((worker) => (worker.callState || "idle") === "idle");
  const candidates = idleWorkers.length ? idleWorkers : workers;
  const start = Number(session.workerCursor || 0) % candidates.length;
  const chosen = candidates[start] || candidates[0];
  session.workerCursor = (start + 1) % candidates.length;
  return chosen;
}

function getActivePhoneWorker(session) {
  return selectPhoneWorker(session, session.activePhoneSocketId || session.phoneSocketId || "");
}

function syncSessionPhoneState(session) {
  const connectedWorkers = getConnectedPhoneWorkers(session);
  const statePriority = { in_call: 5, ringing: 4, dialing: 3, ended: 2, failed: 2, idle: 1, available: 1 };
  const busiestWorker = [...connectedWorkers].sort((a, b) =>
    (statePriority[String(b.callState || "idle")] || 0) - (statePriority[String(a.callState || "idle")] || 0)
  )[0] || null;
  const existingActive = connectedWorkers.find((worker) => worker.socketId === session.activePhoneSocketId) || null;
  const activeWorker = busiestWorker && (statePriority[String(busiestWorker.callState || "idle")] || 0) > 1
    ? busiestWorker
    : existingActive || connectedWorkers[0] || null;
  session.phoneSocketId = activeWorker?.socketId || null;
  session.activePhoneSocketId = activeWorker?.socketId || null;
  session.callState = busiestWorker?.callState || "idle";
  session.phoneDevice = activeWorker
    ? {
        id: activeWorker.id,
        name: activeWorker.name,
        linkedAt: activeWorker.linkedAt
      }
    : connectedWorkers[0]
      ? {
          id: connectedWorkers[0].id,
          name: connectedWorkers[0].name,
          linkedAt: connectedWorkers[0].linkedAt
        }
    : null;
}
return { getConnectedPhoneWorkers, getPhoneWorkerBySocketId, upsertPhoneWorker, removePhoneWorker, selectPhoneWorker, getActivePhoneWorker, syncSessionPhoneState };
}
