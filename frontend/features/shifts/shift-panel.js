import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import * as Contacts from '../contacts/contacts-repository.js';

/**
 * createShiftPanel: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.contactActionButtons, dashboardActions.escHtml, dashboardActions.getPairingListAssignments, dashboardActions.normalizeValidPeruPhone, dashboardState.activePendingTeamId, dashboardState.campaignState, dashboardState.latestSessionState, dashboardState.pairingSlotsSnapshot, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createShiftPanel(dashboardState, dashboardActions) {
function turnPendingKey(contact = {}) {
  return `${String(contact.list || "Principal").trim().toLowerCase()}|${dashboardActions.normalizeValidPeruPhone(contact.phone)}`;
}

function loadTurnPendingContacts() {
  if (!dashboardState.sessionCode) return [];
  const serverPending = dashboardState.campaignState?.turn?.pendingContacts
    ?? dashboardState.latestSessionState?.shiftManagement?.pendingContacts;
  if (Array.isArray(serverPending)) {
    return serverPending.filter((item) => dashboardActions.normalizeValidPeruPhone(item.phone));
  }
  try {
    const parsed = Contacts.getPreference("turnPending", []);
    return Array.isArray(parsed) ? parsed.filter((item) => dashboardActions.normalizeValidPeruPhone(item.phone)) : [];
  } catch {
    return [];
  }
}

function saveTurnPendingContacts(contacts) {
  // El servidor y MySQL gestionan la lista de pendientes de turno en session.shiftManagement.
  // Evitamos reenviar el libro de contactos completo a MySQL en cada actualización de llamada.
}

function syncTurnPendingContacts() {
  // Los pendientes de turno ya se transmiten y sincronizan por WebSocket desde el backend.
}

function renderTurnPendingContacts() {
  const pending = loadTurnPendingContacts();
  const assignments = dashboardActions.getPairingListAssignments();
  const workers = Array.isArray(dashboardState.latestSessionState?.phoneWorkers) ? dashboardState.latestSessionState.phoneWorkers : [];
  const teamSources = dashboardState.pairingSlotsSnapshot
    .filter((slot) => Boolean(slot?.deviceId))
    .map((slot) => ({
      id: String(slot.deviceId),
      slot,
      worker: workers.find((item) => String(item.id) === String(slot.deviceId))
    }));
  for (const worker of workers) {
    const id = String(worker?.id || "");
    if (id && !teamSources.some((team) => team.id === id)) {
      teamSources.push({ id, slot: {}, worker });
    }
  }
  const teams = teamSources.map(({ id, slot, worker }, assignmentIndex) => {
    const assignedLists = assignments
      .filter((assignment) => String(assignment.slot.deviceId) === id)
      .map((assignment) => assignment.listName);
    return {
      id,
      name: worker?.lineLabel || slot.lineLabel || worker?.name || `Equipo ${assignmentIndex + 1}`,
      listNames: assignedLists
    };
  });
  const assignedLists = new Set(teams.flatMap((team) => team.listNames));
  const unassignedPending = pending.filter((contact) => !assignedLists.has(contact.list || "Principal"));
  const availableTabs = new Set(["all", ...teams.map((team) => team.id)]);
  if (unassignedPending.length) availableTabs.add("unassigned");
  if (!availableTabs.has(dashboardState.activePendingTeamId)) dashboardState.activePendingTeamId = "all";

  const filteredPending = dashboardState.activePendingTeamId === "all"
    ? pending
    : dashboardState.activePendingTeamId === "unassigned"
      ? unassignedPending
      : pending.filter((contact) =>
          teams.some((team) => team.id === dashboardState.activePendingTeamId && team.listNames.includes(contact.list || "Principal"))
        );
  const tabs = [
    { id: "all", name: "Todos", count: pending.length },
    ...teams.map((team) => ({
      id: team.id,
      name: team.name,
      count: pending.filter((contact) => team.listNames.includes(contact.list || "Principal")).length
    }))
  ];
  if (unassignedPending.length) tabs.push({ id: "unassigned", name: "Sin equipo", count: unassignedPending.length });
  const teamTabs = document.getElementById("pendingTurnTeamTabs");
  if (teamTabs) {
    teamTabs.innerHTML = tabs.map((tab) => `
      <button type="button" class="pending-turn-team-tab${tab.id === dashboardState.activePendingTeamId ? " is-active" : ""}"
        aria-pressed="${tab.id === dashboardState.activePendingTeamId}" data-pending-team="${dashboardActions.escHtml(tab.id)}">
        ${dashboardActions.escHtml(tab.name)} <span>${tab.count}</span>
      </button>
    `).join("");
    teamTabs.onclick = (event) => {
      const tab = event.target.closest("[data-pending-team]");
      if (!tab) return;
      dashboardState.activePendingTeamId = tab.dataset.pendingTeam;
      renderTurnPendingContacts();
    };
  }
  if (refs.pendingTurnCountEl) refs.pendingTurnCountEl.textContent = `${filteredPending.length} pendiente${filteredPending.length === 1 ? "" : "s"}`;
  if (refs.pendingTurnBodyEl) {
    refs.pendingTurnBodyEl.innerHTML = filteredPending.length
      ? filteredPending.map((contact) => {
          const sourceContact = Contacts.contacts.find((item) =>
            (item.list || "Principal") === (contact.list || "Principal")
            && dashboardActions.normalizeValidPeruPhone(item.phone) === dashboardActions.normalizeValidPeruPhone(contact.phone)
          ) || contact;
          return `<tr>
          <td>${dashboardActions.escHtml(contact.list || "Principal")}</td>
          <td>${dashboardActions.escHtml(contact.name || "Sin nombre")}</td>
          <td>${dashboardActions.escHtml(contact.phone || "-")}</td>
          <td>${dashboardActions.contactActionButtons(sourceContact, "turn-pending")}</td>
        </tr>`;
        }).join("")
      : `<tr><td colspan="4" class="pending-turn-empty">No hay números pendientes del turno.</td></tr>`;
  }
}

function currentShiftSnapshot() {
  return dashboardState.campaignState?.turn || dashboardState.latestSessionState?.shiftManagement || null;
}

function renderShiftManagement() {
  const snapshot = currentShiftSnapshot();
  const current = snapshot?.current;
  const detected = snapshot?.detected;
  if (refs.currentShiftLabelEl) {
    refs.currentShiftLabelEl.textContent = current?.label || detected?.label || "SIN TURNO ACTIVO";
  }
  if (refs.currentShiftScheduleEl) {
    const date = current?.date || detected?.date || "";
    refs.currentShiftScheduleEl.textContent = `${current?.schedule || detected?.schedule || "Horario de Lima"}${date ? ` · ${date}` : ""}`;
  }
  if (refs.finalizeTurnBtn) refs.finalizeTurnBtn.disabled = !current;
  if (refs.finalizeSessionBtn) refs.finalizeSessionBtn.disabled = !dashboardState.sessionCode;

  if (refs.shiftHistoryPanelEl) {
    const history = Array.isArray(snapshot?.history) ? snapshot.history.slice(0, 4) : [];
    refs.shiftHistoryPanelEl.innerHTML = history.length
      ? `<div class="shift-history-head"><strong>TURNOS FINALIZADOS</strong><span>${history.length} recientes</span></div>
        <div class="shift-history-list">${history.map((turn) => `
          <article>
            <div><strong>${dashboardActions.escHtml(turn.label || "Turno")}</strong><small>${dashboardActions.escHtml(turn.date || "")}</small></div>
            <span>${Number(turn.summary?.total || 0)} llamadas</span>
            <span>${Number(turn.summary?.answered || 0)} contestadas</span>
            <span>${Number(turn.summary?.failed || 0)} pendientes</span>
          </article>`).join("")}</div>`
      : "";
  }
}
return { turnPendingKey, loadTurnPendingContacts, saveTurnPendingContacts, syncTurnPendingContacts, renderTurnPendingContacts, currentShiftSnapshot, renderShiftManagement };
}
