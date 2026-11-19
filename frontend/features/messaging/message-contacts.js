import { openContactSendModal } from './message-templates.js';
import { getSendStatus, sendStatusKey, MESSAGE_SEND_STATUS_EVENT } from './message-send-status.js';
import { apiFetch, currentUser } from '../auth/auth-session.js';

let initialized = false;
let users = [];
let sendStatusBound = false;

const MAIL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 7 10-7"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;

function $(id) { return document.getElementById(id); }

function formatStatusDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

/** Chip de estado: Enviado / No contactado / Sin envío. */
function sendStatusChip(contact, escHtml) {
  const status = getSendStatus(contact?.phone);
  if (!status) {
    return `<span class="send-status-chip is-idle">— Sin envío</span>`;
  }
  const channel = status.channel === "email" ? "Correo" : "WhatsApp";
  const when = formatStatusDate(status.at);
  const title = escHtml(when ? `${channel} · ${when}` : channel);
  if (status.status === "sent") {
    return `<span class="send-status-chip is-sent" title="${title}">✔ Enviado</span>`;
  }
  return `<span class="send-status-chip is-failed" title="${title}">✕ No contactado</span>`;
}

/** Actualiza solo la celda de estado, sin re-renderizar toda la tabla. */
function bindSendStatusUpdates() {
  if (sendStatusBound) return;
  sendStatusBound = true;
  window.addEventListener(MESSAGE_SEND_STATUS_EVENT, event => {
    const phone = event.detail?.phone;
    if (!phone) return;
    const row = [...document.querySelectorAll("#messageContactsBody tr[data-phone]")]
      .find(item => sendStatusKey(item.dataset.phone) === phone);
    const cell = row?.querySelector("[data-status-cell]");
    if (cell) cell.innerHTML = sendStatusChip({ phone }, String);
  });
}

/**
 * createMessageContacts: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml, dashboardState.messageContacts.
 * Se construye una vez por dashboard.
 */
export function createMessageContacts(dashboardState, dashboardActions) {
  async function initMessageContactsAdmin() {
    const authUser = currentUser || window.VOIP_VC_AUTH_USER;
    if (authUser?.role !== "ADMINISTRADOR") return;
    const selector = $("messageContactsUserSelector");
    if (selector) selector.style.display = "flex";
    if (!initialized) {
      initialized = true;
      $("messageContactsUser").addEventListener("change", onMessageUserChange);
      await loadMessageUsers();
    } else if (!users.length) {
      await loadMessageUsers();
    }
  }

  async function loadMessageUsers() {
    const status = $("messageContactsStatus");
    status.textContent = "Cargando vendedores…";
    try {
      const response = await apiFetch("/api/users/lists", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar los vendedores.");
      users = data.users;
      const select = $("messageContactsUser");
      select.replaceChildren(new Option("— Mis contactos —", "mine"));
      const myId = currentUser?.id || window.VOIP_VC_AUTH_USER?.id;
      for (const user of users) {
        const isMe = myId && String(user.id) === String(myId);
        select.add(new Option(`${user.username}${isMe ? " (tú)" : ""} · ${user.role === "ADMINISTRADOR" ? "Admin" : "Vendedor"}`, String(user.id)));
      }
      // Auto-select "Mis contactos" by default
      select.value = "mine";
      onMessageUserChange();
      status.textContent = users.length ? "Selecciona un vendedor para ver sus contactos." : "Solo tú tienes acceso.";
    } catch (error) {
      status.textContent = error.message || "No se pudieron cargar los vendedores.";
    }
  }

  async function onMessageUserChange() {
    const userId = $("messageContactsUser").value;
    const status = $("messageContactsStatus");
    if (!userId || userId === "mine") {
      // Show current user's contacts (from socket event)
      status.textContent = dashboardState.messageContacts.length 
        ? `Tus contactos: ${dashboardState.messageContacts.length}`
        : "Tus contactos del celular aparecerán aquí automáticamente.";
      return;
    }
    status.textContent = "Cargando contactos del vendedor…";
    try {
      const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}/message-contacts`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar los contactos.");
      dashboardActions.renderMessageContacts(data.contacts);
      status.textContent = data.contacts.length 
        ? `${data.contacts.length} contacto${data.contacts.length === 1 ? "" : "s"} de ${data.username}.`
        : `Sin contactos guardados en ${data.username}.`;
    } catch (error) {
      status.textContent = error.message || "Error al cargar contactos.";
    }
  }

  function renderMessageContacts(contacts = dashboardState.messageContacts) {
    dashboardState.messageContacts = Array.isArray(contacts) ? contacts : [];
    bindSendStatusUpdates();
    const body = $("messageContactsBody");
    const count = $("messageContactsCount");
    const status = $("messageContactsStatus");
    const userId = $("messageContactsUser")?.value;
    if (count) count.textContent = `${dashboardState.messageContacts.length} contacto${dashboardState.messageContacts.length === 1 ? "" : "s"}`;
    if (status && (!userId || userId === "mine")) {
      status.textContent = dashboardState.messageContacts.length 
        ? `Tus contactos: ${dashboardState.messageContacts.length}`
        : "Tus contactos del celular aparecerán aquí automáticamente.";
    }
    if (!body) return;
    body.onclick = async (event) => {
      const button = event.target.closest("button[data-message-action]");
      if (!button || button.disabled) return;
      const contact = dashboardState.messageContacts.find(item => String(item.phone).replace(/\D/g, "") === button.dataset.phone);
      if (!contact) return;
      const action = button.dataset.messageAction;
      if (action === "send") { openContactSendModal(contact, "whatsapp"); return; }
      if (action === "mail") { openContactSendModal(contact, "email"); return; }
      if (action === "delete") {
        if (!await dashboardActions.requestConfirmation({ 
          title: "Eliminar contacto", 
          message: `¿Eliminar a ${contact.name} (${contact.phone}) de la lista de WhatsApp?`, 
          confirmLabel: "Eliminar" 
        })) return;
        button.disabled = true;
        try {
          const data = await dashboardActions.postCampaignAction("/message-contacts/update", { action: "delete", phone: contact.phone });
          if (data) renderMessageContacts(data.contacts);
        } finally { button.disabled = false; }
      }
    };
    if (!dashboardState.messageContacts.length) {
      const hint = userId === "mine" 
        ? "Los contactos que guardes desde la APK aparecerán aquí."
        : "Este vendedor no tiene contactos guardados aún.";
      body.innerHTML = `<tr><td colspan="4" class="muted">${hint}</td></tr>`;
      return;
    }
    const safeName = value => dashboardActions.escHtml(value);
    body.innerHTML = dashboardState.messageContacts.map((contact) => {
      const phone = String(contact.phone || "").replace(/\D/g, "");
      const name = contact.name || phone;
      return `<tr data-phone="${phone}">
        <td>${safeName(name)}</td>
        <td>${safeName(phone)}</td>
        <td class="message-contact-status" data-status-cell>${sendStatusChip(contact, safeName)}</td>
        <td><div class="message-contact-actions">
          <button type="button" class="message-contact-wa" data-message-action="send" data-phone="${phone}" title="Enviar por WhatsApp" aria-label="Enviar WhatsApp a ${safeName(name)}">${dashboardActions.whatsappActionIcon()}</button>
          <button type="button" class="message-contact-icon message-contact-mail" data-message-action="mail" data-phone="${phone}" title="Enviar por correo" aria-label="Enviar correo a ${safeName(name)}">${MAIL_ICON}</button>
          <button type="button" class="message-contact-icon message-contact-delete" data-message-action="delete" data-phone="${phone}" title="Eliminar" aria-label="Eliminar contacto">${TRASH_ICON}</button>
        </div></td>
      </tr>`;
    }).join("");
  }

  return { renderMessageContacts, initMessageContactsAdmin };
}