import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import { apiFetch as fetch, currentUser, bindAccountControls } from '../auth/auth-session.js';

/**
 * createApkDownload: conserva los contratos y reglas existentes.
 * Dependencias: .
 * Se construye una vez por dashboard.
 */
export function createApkDownload(dashboardState, dashboardActions) {
async function loadApkInfo() {
  try {
    const res = await fetch(`${API_BASE}/api/apk/info`, { cache: "no-store" });
    const info = await res.json();
    if (info.ok) {
      refs.apkNameEl.textContent = "VOIP VC Android";
      const sizeMb = Number(info.size || 0) / (1024 * 1024);
      const modified = new Date(info.modified);
      const buildDate = Number.isNaN(modified.getTime()) ? "" : new Intl.DateTimeFormat("es-PE", {
        timeZone: "America/Lima", day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false
      }).format(modified);
      refs.apkMetaEl.textContent = `${sizeMb.toFixed(1)} MB${buildDate ? ` · Compilación ${buildDate} (Lima)` : ""}`;
      refs.apkDlBtn.href = `${API_BASE}/api/apk/download?build=${encodeURIComponent(info.modified || "")}`;
      refs.apkDlBtn.title = `Descargar ${info.name}`;
      return;
    }
    refs.apkMetaEl.textContent = "APK no disponible";
  } catch {
    refs.apkMetaEl.textContent = "No se pudo cargar la información del APK";
  }
}
return { loadApkInfo };
}
