export function clearDeviceFromPairingSlots(session, deviceId, exceptSlotId = "") {
  const normalizedDeviceId = String(deviceId || "").trim();
  if (!normalizedDeviceId) return 0;
  let cleared = 0;
  for (const slot of session?.pairingSlots || []) {
    if (slot.id === exceptSlotId || slot.deviceId !== normalizedDeviceId) continue;
    slot.deviceId = "";
    slot.deviceName = "";
    slot.linkedAt = null;
    cleared += 1;
  }
  return cleared;
}

export function bindDeviceToPairingSlot(session, slot, { deviceId, deviceName, linkedAt } = {}, io = null) {
  if (!slot) return null;
  const normalizedDeviceId = String(deviceId || "").trim();
  if (!normalizedDeviceId) throw new Error("deviceId requerido");
  // Invalidate previous session using this slot: disconnect old worker's socket
  if (io && session.phoneWorkers) {
    const oldWorker = session.phoneWorkers.find((w) => w.pairingSlotId === slot.id && w.id !== normalizedDeviceId && w.connected && w.socketId);
    if (oldWorker) {
      const oldSocket = io.sockets.sockets.get(oldWorker.socketId);
      if (oldSocket?.connected) {
        oldSocket.emit("session:error", { message: "Sesion invalida: nuevo dispositivo vinculado a este slot", reason: "slot_reassigned" });
        oldSocket.disconnect(true);
      }
      oldWorker.connected = false;
      oldWorker.socketId = null;
      oldWorker.pairingSlotId = null;
    }
  }
  clearDeviceFromPairingSlots(session, normalizedDeviceId, slot.id);
  slot.deviceId = normalizedDeviceId;
  slot.deviceName = String(deviceName || "Android bridge");
  slot.linkedAt = slot.linkedAt || linkedAt || new Date().toISOString();
  return slot;
}

export function dedupePairingSlotDevices(session) {
  const preferredByDevice = new Map((session?.phoneWorkers || []).filter((worker) => worker?.id && worker?.pairingSlotId).map((worker) => [String(worker.id), String(worker.pairingSlotId)]));
  const slotsByDevice = new Map();
  for (const slot of session?.pairingSlots || []) {
    if (!slot.deviceId) continue;
    const entries = slotsByDevice.get(slot.deviceId) || [];
    entries.push(slot);
    slotsByDevice.set(slot.deviceId, entries);
  }
  let cleared = 0;
  for (const [deviceId, slots] of slotsByDevice) {
    if (slots.length < 2) continue;
    const keeper = slots.find((slot) => slot.id === preferredByDevice.get(deviceId)) || slots[0];
    for (const slot of slots) {
      if (slot === keeper) continue;
      slot.deviceId = "";
      slot.deviceName = "";
      slot.linkedAt = null;
      cleared += 1;
    }
    const worker = (session.phoneWorkers || []).find((item) => item.id === deviceId);
    if (worker) worker.pairingSlotId = keeper.id;
  }
  return cleared;
}
