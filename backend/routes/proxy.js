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
export function registerProxy(runtime, services) {
const { app, remoteFetchRateLimit } = runtime;
const { validatePublicImportUrl } = services;
app.get("/api/fetch-url", remoteFetchRateLimit, async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "url requerida" });
  try {
    const safeUrl = await validatePublicImportUrl(url);
    const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
    const fetchFn = fetch || globalThis.fetch;
    const r = await fetchFn(safeUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VOIP VC/1.0)" },
      signal: AbortSignal.timeout(Number(process.env.FETCH_TIMEOUT_MS || 10000)),
      redirect: "error",
      size: 2 * 1024 * 1024
    });
    if (!r.ok) return res.status(502).json({ ok: false, error: `HTTP ${r.status} al obtener la URL` });
    const contentType = String(r.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("text/csv")) {
      return res.status(415).json({ ok: false, error: "La URL no devuelve HTML, texto o CSV." });
    }
    const html = await r.text();
    return res.json({ ok: true, html });
  } catch (e) {
    return res.status(Number(e.statusCode || 502)).json({ ok: false, error: e.message });
  }
});
}
