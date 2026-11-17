import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import * as Contacts from '../contacts/contacts-repository.js';
import { apiFetch as fetch, currentUser, bindAccountControls } from '../auth/auth-session.js';

/**
 * createWorkspaceController: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.renderCampaignPanel, dashboardState.DASHBOARD_SESSION_KEY, dashboardState.DASHBOARD_TOKEN_PREFIX, dashboardState.autoSessionRequested, dashboardState.currentPhoneLinked, dashboardState.dashboardClientId, dashboardState.dashboardToken, dashboardState.latestSessionState, dashboardState.restoreAttempted, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createWorkspaceController(dashboardState, dashboardActions) {
function saveSessionCode(code, token = dashboardState.dashboardToken) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return;
  localStorage.setItem(dashboardState.DASHBOARD_SESSION_KEY, normalized);
  if (token) localStorage.setItem(`${dashboardState.DASHBOARD_TOKEN_PREFIX}${normalized}`, String(token));
}

function getSavedSessionCode() {
  return String(localStorage.getItem(dashboardState.DASHBOARD_SESSION_KEY) || "").trim().toUpperCase();
}

function getSavedDashboardToken(code) {
  const normalized = String(code || "").trim().toUpperCase();
  return normalized ? String(localStorage.getItem(`${dashboardState.DASHBOARD_TOKEN_PREFIX}${normalized}`) || "").trim() : "";
}

function restoreSavedSession() {
  if (dashboardState.restoreAttempted) return;
  dashboardState.restoreAttempted = true;
  requestAutomaticSession();
}

function requestAutomaticSession() {
  if (dashboardState.autoSessionRequested || !socket.connected) return;
  dashboardState.autoSessionRequested = true;
  setStatus("Conectando con tu espacio de trabajo...");
  // MySQL selects the same account workspace on every browser. The old code
  // is only a migration hint; the server checks ownership before using it.
  socket.emit("workspace:open", { dashboardClientId: dashboardState.dashboardClientId, previousCode: getSavedSessionCode() });
}

function updatePairingHint(link) {
  if (!refs.qrHintEl) return;
  if (dashboardState.currentPhoneLinked) return;

  try {
    const parsed = new URL(link);
    const apiBase = String(parsed.searchParams.get("apiBase") || "").trim();
    if (!apiBase) {
      refs.qrHintEl.textContent = "QR generado, pero no incluye apiBase.";
      return;
    }

    const apiUrl = new URL(apiBase);
    const host = apiUrl.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      refs.qrHintEl.textContent = `Advertencia: el QR apunta a ${apiBase}. Ese host no sirve para el celular; usa IP LAN o dominio público.`;
      return;
    }

    refs.qrHintEl.textContent = `QR listo. La APK se conectará a ${apiBase}`;
  } catch {
    refs.qrHintEl.textContent = "QR listo. Verifica que la URL del servidor sea accesible desde el celular.";
  }
}

function updateSessionUi(st = {}) {
  if (dashboardState.sessionCode && dashboardState.dashboardToken) {
    const bookCode = dashboardState.sessionCode;
    const bookToken = dashboardState.dashboardToken;
    Contacts.connectDatabase(bookCode, async (method,body) => {
      const response = await fetch(`${API_BASE}/api/session/${encodeURIComponent(bookCode)}/contact-book`, {
        method, headers:{"Content-Type":"application/json","X-Dashboard-Token":bookToken},
        ...(body ? {body:JSON.stringify(body)} : {})
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo guardar la base en MySQL.");
      return data;
    }).catch(() => {});
  }
  dashboardState.latestSessionState = st || {};
  const storageStatus = document.getElementById("storageStatus");
  if (storageStatus) {
    const pending = st.storage?.mode === "pending";
    storageStatus.hidden = !pending;
    storageStatus.textContent = pending
      ? "Hay datos pendientes de guardar. No se iniciarán nuevas llamadas hasta recuperar el guardado."
      : "";
  }
  const dashboardConnected = Boolean(st?.connected?.dashboard ?? dashboardState.sessionCode);

  const phoneConnected = Boolean(st?.connected?.phone);
  const phoneLinking   = Boolean(st?.connected?.linking);
  const phoneCount = Number(st?.connected?.phoneCount || 0);
  const phoneDeviceName = String(st?.phoneDevice?.name || "").trim();
  dashboardState.currentPhoneLinked = phoneConnected;

  if (refs.qrHintEl && phoneLinking) {
    refs.qrHintEl.innerHTML = `<strong>¡Celular detectado!</strong> Sincronizando datos...`;
    refs.qrHintEl.style.color = "var(--success)";
  }

  if (refs.qrBlockEl) {
    refs.qrBlockEl.classList.toggle("is-linked", phoneConnected);
  }

  if (refs.linkedBanner) {
    refs.linkedBanner.style.display = phoneConnected ? "flex" : "none";
  }
  if (refs.linkedDevice) {
    if (phoneConnected) {
      const deviceLabel = phoneDeviceName || (phoneCount > 1 ? `${phoneCount} dispositivos conectados` : "Dispositivo conectado");
      refs.linkedDevice.textContent = deviceLabel;
    } else {
      refs.linkedDevice.textContent = "Dispositivo conectado";
    }
  }
  if (refs.contactsSec) {
    refs.contactsSec.style.display = dashboardConnected ? "block" : "none";
  }
  if (refs.contactsDataSec) {
    refs.contactsDataSec.style.display = dashboardConnected ? "block" : "none";
  }
  if (refs.qrBlockEl) {
    // Keep the QR visible so more phones can join the same session.
    refs.qrBlockEl.style.display = dashboardConnected ? "flex" : "none";
  }

  if (dashboardConnected) {
    setStatus(phoneConnected ? `${phoneCount} teléfono(s) vinculado(s). Cada dispositivo utiliza su propio QR.` : "Tu espacio está listo. Escanea un QR diferente en cada teléfono.", true);
    dashboardActions.renderCampaignPanel();
  } else {
    setStatus("Conectando con tu espacio de trabajo...");
  }
}
return { saveSessionCode, getSavedSessionCode, getSavedDashboardToken, restoreSavedSession, requestAutomaticSession, updatePairingHint, updateSessionUi };
}
