import { apiFetch as fetch, currentUser, bindAccountControls } from '../features/auth/auth-session.js';
import { dashboardSessionKeys } from '../features/workspace/dashboard-session.js';

// Estado compartido de una instancia. Se conservan las claves de almacenamiento existentes.
export function createDashboardState() {
let sessionCode = "";
let dashboardToken = "";
let pairQrObjectUrls = [];
let pairingStateSignature = "";
let pairingSlotsSnapshot = [];
let callCtx = null;
let callTimerId = null;
let callStartedAt = null;
let lastCallDuration = 0;
let currentState = "idle";
let micEnabled = false;
let speakerEnabled = false;
let importPreviewData = [];
let importPreviewBatches = [];
let currentPage = 1;
let currentCallingContactId = null;
let currentPhoneLinked = false;
let latestSessionState = {};
let messageContacts = [];
let campaignState = null;
let reportRowsCache = [];
let reportCacheSession = "";
let reportRequestSerial = 0;
let reportPeriod = { from: "", to: "" };
let reportShiftId = "";
let reportListFilter = "";
let reportWorkerFilter = "";
let reportResultFilter = "";
const pendingCommandTimeouts = new Map();
const PAGE_SIZE = 100;
const {
  session: DASHBOARD_SESSION_KEY,
  tokenPrefix: DASHBOARD_TOKEN_PREFIX,
  client: DASHBOARD_CLIENT_KEY
} = dashboardSessionKeys(currentUser.id);
const dashboardClientId = (() => {
  let value = String(sessionStorage.getItem(DASHBOARD_CLIENT_KEY) || "").trim();
  if (!value) {
    value = globalThis.crypto?.randomUUID?.() || `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(DASHBOARD_CLIENT_KEY, value);
  }
  return value;
})();
const TURN_PENDING_PREFIX = "voip vc.turnPending.";
const HIDDEN_ASSIGNED_RECORDS_PREFIX = "voip vc.hiddenAssignedRecords.";
const PAIRING_LIST_ASSIGNMENTS_PREFIX = "voip vc.pairingListAssignments.";
let restoreAttempted = false;
let autoSessionRequested = false;
let pendingRecoveryRunning = false;
let normalCampaignResumeRequested = false;
let activePendingTeamId = "all";
let currentImportFileName = "";
let pdfLogoDataPromise = null;
let callHistory = [];
return { sessionCode, dashboardToken, pairQrObjectUrls, pairingStateSignature, pairingSlotsSnapshot, callCtx, callTimerId, callStartedAt, lastCallDuration, currentState, micEnabled, speakerEnabled, importPreviewData, importPreviewBatches, currentPage, currentCallingContactId, currentPhoneLinked, latestSessionState, messageContacts, campaignState, reportRowsCache, reportCacheSession, reportRequestSerial, reportPeriod, reportShiftId, reportListFilter, reportWorkerFilter, reportResultFilter, pendingCommandTimeouts, PAGE_SIZE, DASHBOARD_SESSION_KEY, DASHBOARD_TOKEN_PREFIX, DASHBOARD_CLIENT_KEY, dashboardClientId, TURN_PENDING_PREFIX, HIDDEN_ASSIGNED_RECORDS_PREFIX, PAIRING_LIST_ASSIGNMENTS_PREFIX, restoreAttempted, autoSessionRequested, pendingRecoveryRunning, normalCampaignResumeRequested, activePendingTeamId, currentImportFileName, pdfLogoDataPromise, callHistory };
}
