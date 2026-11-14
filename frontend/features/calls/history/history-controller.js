import { refs, setStatus, setBadge, setAckBadge } from '../../../shared/ui/dom.js';
import * as Contacts from '../../contacts/contacts-repository.js';

/**
 * createHistoryController: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml, dashboardActions.formatCallDuration, dashboardActions.requestConfirmation, dashboardState.callHistory.
 * Se construye una vez por dashboard.
 */
export function createHistoryController(dashboardState, dashboardActions) {
function loadHistory() {
  dashboardState.callHistory = Contacts.getPreference("recentCalls", []);
}

function saveHistory() {
  Contacts.setPreference("recentCalls", dashboardState.callHistory);
}

function addHistoryEntry(phone, duration) {
  if (!phone) return;
  dashboardState.callHistory.unshift({
    phone,
    duration,
    timestamp: Date.now()
  });
  if (dashboardState.callHistory.length > 50) dashboardState.callHistory.pop();
  saveHistory();
}

function openHistory() {
  renderHistory();
  refs.historyModalEl.style.display = "flex";
}

async function clearHistory() {
  if (!await dashboardActions.requestConfirmation({ title: "Limpiar historial", message: "¿Deseas eliminar todo el historial reciente?", confirmLabel: "Limpiar" })) return;
  dashboardState.callHistory = [];
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list = refs.historyListEl;
  if (!list) return;
  if (dashboardState.callHistory.length === 0) {
    list.innerHTML = `<div class="muted" style="text-align:center;padding:40px;">Sin llamadas recientes.</div>`;
    return;
  }
  list.innerHTML = dashboardState.callHistory.map(h => `
    <div class="history-item">
      <div class="history-info">
        <div class="history-phone">${dashboardActions.escHtml(h.phone)}</div>
        <div class="history-meta">
          <span>📅 ${new Date(h.timestamp).toLocaleString()}</span>
          <span>⏱️ ${dashboardActions.formatCallDuration(h.duration)}</span>
        </div>
      </div>
      <div class="history-actions">
        <button class="history-call-btn" onclick="dialFromHistory('${dashboardActions.escHtml(h.phone)}')">📞 Llamar</button>
      </div>
    </div>
  `).join("");
}
return { loadHistory, saveHistory, addHistoryEntry, openHistory, clearHistory, renderHistory };
}
