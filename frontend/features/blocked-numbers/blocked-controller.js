import { socket, API_BASE } from '../../shared/realtime/socket.js';
import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import { currentUser } from '../auth/auth-session.js';

/**
 * createBlockedController: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml, dashboardState.latestSessionState, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createBlockedController(dashboardState, dashboardActions) {
function setBlockedNumbersFeedback(message, isError = false) {
  const feedback = document.getElementById("blockedNumbersFeedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.hidden = !message;
  feedback.dataset.error = String(isError);
  feedback.setAttribute("role", isError ? "alert" : "status");
}

function renderBlockedNumbers() {
  const body = document.getElementById("blockedNumbersBody");
  if (!body) return;
  const canRemove = currentUser?.role === "ADMINISTRADOR";
  document.getElementById("blockedNumbersActionHeader")?.toggleAttribute("hidden", !canRemove);
  document.querySelector("#blockedNumbersView .blocked-action-column")?.toggleAttribute("hidden", !canRemove);
  const entries = Array.isArray(dashboardState.latestSessionState.blockedNumbers) ? dashboardState.latestSessionState.blockedNumbers : [];
  const query = (document.getElementById("blockedNumbersSearch")?.value || "").trim().toLocaleLowerCase("es");
  const phoneQuery = query.replace(/\D/g, "");
  const filtered = entries.filter(entry =>
    [entry.name || "", entry.phone || ""].join(" ").toLocaleLowerCase("es").includes(query)
    || (phoneQuery && !/\p{L}/u.test(query) && String(entry.phone || "").replace(/\D/g, "").includes(phoneQuery))
  );
  const count = document.getElementById("blockedNumbersCount");
  if (count) count.textContent = query ? `${filtered.length} de ${entries.length}` : `${entries.length} ${entries.length === 1 ? "número" : "números"}`;
  body.innerHTML = filtered.length
    ? filtered.map(entry => `<tr>
        <td>${dashboardActions.escHtml(entry.name || entry.phone || "")}</td>
        <td>${dashboardActions.escHtml(entry.phone || "")}</td>
        ${canRemove ? `<td><button type="button" class="secondary" data-remove-blocked-number="${dashboardActions.escHtml(entry.phone || "")}">Quitar</button></td>` : ""}
      </tr>`).join("")
    : `<tr><td class="blocked-empty" colspan="${canRemove ? 3 : 2}">${query ? "No hay coincidencias con esa búsqueda." : "No hay números bloqueados."}</td></tr>`;
}

function changeBlockedNumber(action, name, phone) {
  if (action === "remove" && currentUser?.role !== "ADMINISTRADOR") {
    setBlockedNumbersFeedback("Solo el administrador puede quitar números bloqueados.", true);
    return false;
  }
  const normalizedPhone = String(phone || "").trim();
  if (!dashboardState.sessionCode || !socket.connected) {
    setStatus("Espera a que el panel esté conectado para actualizar los bloqueos.", true);
    setBlockedNumbersFeedback("Espera a que el panel esté conectado para actualizar los bloqueos.", true);
    return false;
  }
  const digitCount = normalizedPhone.replace(/\D/g, "").length;
  if (action === "add" && (!/^\+?[\d\s().-]{6,24}$/.test(normalizedPhone) || digitCount < 6 || digitCount > 15)) {
    setStatus("Ingresa un número válido.", true);
    setBlockedNumbersFeedback("Ingresa un número válido.", true);
    return false;
  }
  setBlockedNumbersFeedback("Guardando cambios…");
  socket.emit("blocked-numbers:change", {
    action,
    name: String(name || "").trim() || normalizedPhone,
    phone: normalizedPhone
  });
  return true;
}
return { setBlockedNumbersFeedback, renderBlockedNumbers, changeBlockedNumber };
}
