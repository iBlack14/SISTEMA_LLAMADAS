import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';

/**
 * createShiftActions: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.buildCallReportPdf, dashboardActions.currentShiftSnapshot, dashboardActions.loadPairingData, dashboardActions.loadTurnPendingContacts, dashboardActions.mapCampaignReportRow, dashboardActions.normalizeValidPeruPhone, dashboardActions.postCampaignAction, dashboardActions.renderCampaignPanel, dashboardActions.requestConfirmation, dashboardState.campaignState, dashboardState.latestSessionState, dashboardState.normalCampaignResumeRequested, dashboardState.pairingSlotsSnapshot, dashboardState.pairingStateSignature, dashboardState.pendingRecoveryRunning, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createShiftActions(dashboardState, dashboardActions) {
async function startPendingTurnRun() {
  const pending = dashboardActions.loadTurnPendingContacts().filter((contact) =>
    String(contact.status || "pending_next_shift") !== "exhausted"
    && Number(contact.recoveryAttempts || 0) < 2
  );
  if (!pending.length) {
    setStatus("No hay números pendientes del turno.", true);
    return;
  }
  const workers = Array.isArray(dashboardState.latestSessionState?.phoneWorkers) ? dashboardState.latestSessionState.phoneWorkers : [];
  const firstAvailableSlot = dashboardState.pairingSlotsSnapshot.find((slot) => {
    if (!slot.deviceId) return false;
    const worker = workers.find((item) => String(item.id) === String(slot.deviceId));
    return worker?.connected && !worker.paused
      && ["idle", "failed", "available"].includes(String(worker.callState || "idle"));
  });
  const fallbackWorker = workers.find((worker) => worker.connected && !worker.paused
    && ["idle", "failed", "available"].includes(String(worker.callState || "idle")));
  const workerId = firstAvailableSlot?.deviceId || fallbackWorker?.id || "";
  if (!workerId) {
    setStatus("No hay ningún equipo disponible para llamar los pendientes.", true);
    return;
  }
  const data = await dashboardActions.postCampaignAction("/campaign/start", {
    listName: "Pendientes del turno",
    maxAttempts: 2,
    contacts: pending.map((contact, index) => ({
      id: `turn-pending-${Date.now()}-${index}`,
      name: contact.name,
      phone: dashboardActions.normalizeValidPeruPhone(contact.phone),
      list: contact.list || "Principal",
      targetWorkerId: workerId
    }))
  });
  if (data) {
    dashboardState.pendingRecoveryRunning = true;
    dashboardState.normalCampaignResumeRequested = false;
    setStatus(`Llamando ${pending.length} número${pending.length === 1 ? "" : "s"} pendiente${pending.length === 1 ? "" : "s"} desde el primer equipo disponible.`, true);
  }
}

async function finalizeWorkTurn() {
  const snapshot = dashboardActions.currentShiftSnapshot();
  if (!snapshot?.current) {
    setStatus("No hay un turno activo para finalizar.", true);
    return;
  }
  const accepted = await dashboardActions.requestConfirmation({
    title: "Finalizar turno",
    message: `Se archivará ${snapshot.current.label || "el turno"}, se detendrán las llamadas y se desvincularán todos los equipos. Los pendientes se conservarán para el siguiente turno.`,
    confirmLabel: "Finalizar turno"
  });
  if (!accepted) return;
  const data = await dashboardActions.postCampaignAction("/turn/finalize");
  if (!data) return;
  const finalizedRows = Array.isArray(data.finalizedTurn?.report)
    ? data.finalizedTurn.report.map((item) => dashboardActions.mapCampaignReportRow(item))
    : [];
  if (finalizedRows.length) {
    try {
      const pdf = await dashboardActions.buildCallReportPdf(data.finalizedTurn.label || "Turno finalizado", finalizedRows, data.finalizedTurn);
      const blob = new Blob([pdf], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `reporte_final_${data.finalizedTurn.type || "turno"}_${data.finalizedTurn.date || new Date().toISOString().slice(0, 10)}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error("No se pudo descargar el reporte final:", error);
      setStatus("El turno se cerró, pero el PDF no pudo descargarse. El reporte quedó archivado para recuperarlo.", true);
    }
  }
  dashboardState.campaignState = data.campaign || dashboardState.campaignState;
  await dashboardActions.loadPairingData(dashboardState.sessionCode);
  dashboardActions.renderCampaignPanel();
  setStatus("Turno finalizado. Reporte archivado y pendientes conservados.", true);
}

async function finalizeOperationalSession() {
  const accepted = await dashboardActions.requestConfirmation({
    title: "Desvincular todos los equipos",
    message: "Se colgarán las llamadas, se desvincularán los teléfonos y se generarán nuevos códigos QR. El turno, sus listas, avance, pendientes y reportes se conservarán.",
    confirmLabel: "Desvincular equipos"
  });
  if (!accepted) return;
  const data = await dashboardActions.postCampaignAction("/session/finalize");
  if (!data) return;
  dashboardState.campaignState = data.campaign || dashboardState.campaignState;
  dashboardState.pairingStateSignature = "";
  await dashboardActions.loadPairingData(dashboardState.sessionCode);
  dashboardActions.renderCampaignPanel();
  setStatus("Equipos desvinculados. Tu cuenta, bases e historial se conservan.", true);
}
return { startPendingTurnRun, finalizeWorkTurn, finalizeOperationalSession };
}
