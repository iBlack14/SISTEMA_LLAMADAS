import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { nanoid } from "nanoid";
import { runtimeIdentity, runtimeLockName, probeRuntime, waitForRuntime } from "../services/workspace/runtime-instance.js";
import { UserWorkspaces } from "../services/workspace/user-workspace.js";
import { splitReportByList } from "../services/reports/report-lists.js";
import { hydrateReportDetails } from "../services/reports/report-details.js";
import { selectPendingReportContacts } from "../services/reports/report-selection.js";
import { isAnsweredAttempt, isVoicemailAttempt, attemptResultLabel } from "../../shared/reports/report-metrics.js";
import { bindDeviceToPairingSlot, clearDeviceFromPairingSlots, dedupePairingSlotDevices } from "../services/calls/pairing-lifecycle.js";
import { assertIsolatedConfig, assertXamppConfig, assertEasypanelConfig } from "../services/auth/config.js";
import { AuthService } from "../services/auth/service.js";
import { installSocketAuth } from "../services/auth/sockets.js";
import { NetworkMonitor } from "../services/network/network-monitor.js";
import { SessionPersistence } from "../shared/persistence.js";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks, phoneKey } from "../services/campaigns/contact-book.js";
import { collectReportAttempts } from "../services/reports/report-attempts.js";
import { collectCallAttempts } from "../services/calls/call-history.js";
import { CallHistoryGate } from "../services/calls/call-history-gate.js";
import { normalizeMessageContacts, upsertMessageContact } from "../services/messaging/message-contacts.js";
import {
  ensureCampaign,
  getCampaignSnapshot,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  assignNextContact,
  assignSpecificContact,
  ensureCampaignContact,
  updateActiveCallState,
  markContactResult,
  skipActiveContact,
  holdActiveContact,
  resumeHeldContact,
  getActiveContact,
  getContactByWorker,
  getActiveAttemptId,
  setWorkerPaused,
  isWorkerPaused,
  resetCampaignForShift,
  resetCampaignOperation,
  switchWorkerList
} from "../services/campaigns/campaign-manager.js";
import {
  ensureShiftManagement,
  syncPendingContacts,
  finalizeCurrentTurn,
  finalizeCurrentSession,
  markPendingCampaignStarted,
  getShiftSnapshot
} from "../services/campaigns/shift-manager.js";

// Extraído del servidor original; conserva validaciones y contratos públicos.
export function registerApk(runtime, services) {
const { app } = runtime;
const { getAvailableApks, getApkById } = services;
app.get("/api/apk/versions", (_, res) => {
  const versions = getAvailableApks();
  if (!versions.length) {
    return res.json({ ok: false, versions: [], error: "APK no encontrada. Compila el proyecto Android primero." });
  }
  return res.json({
    ok: true,
    latestId: versions[0].id,
    versions: versions.map(v => ({
      id: v.id,
      name: v.name,
      version: v.version,
      type: v.type,
      size: v.size,
      sizeKb: v.sizeKb,
      modified: v.modified
    }))
  });
});

app.get("/api/apk/info", (_, res) => {
  const versions = getAvailableApks();
  if (!versions.length) {
    return res.json({ ok: false, error: "APK no encontrada. Compila el proyecto Android primero." });
  }
  const top = versions[0];
  return res.json({
    ok: true,
    id: top.id,
    name: top.name,
    version: top.version,
    size: top.size,
    sizeKb: top.sizeKb,
    type: top.type,
    modified: top.modified
  });
});

app.get("/api/apk/download", (_, res) => {
  const versions = getAvailableApks();
  if (!versions.length) {
    return res.status(404).json({ ok: false, error: "APK no encontrada." });
  }
  const latest = versions[0];
  res.setHeader("Content-Disposition", `attachment; filename="${latest.name}"`);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  return res.sendFile(path.resolve(latest.fullPath));
});

app.get("/api/apk/download/:id", (req, res) => {
  const apk = getApkById(String(req.params.id || "").trim());
  if (!apk) return res.status(404).json({ ok: false, error: "Versión APK no encontrada." });
  res.setHeader("Content-Disposition", `attachment; filename="${apk.name}"`);
  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  return res.sendFile(path.resolve(apk.fullPath));
});
}
