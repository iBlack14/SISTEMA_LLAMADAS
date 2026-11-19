import { openContactSendModal } from './message-templates.js';
import { getSendStatus, sendStatusKey, MESSAGE_SEND_STATUS_EVENT } from './message-send-status.js';
import { apiFetch, currentUser } from '../auth/auth-session.js';

let initialized = false;
let users = [];
let sendStatusBound = false;

const MAIL_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 7 10-7"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
const WHATSAPP_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.198-.347.223-.644.075-.297-.149-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.372-.025-.521-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.273.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.29.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.002-5.45 4.437-9.884 9.888-9.884 2.64.001 5.12 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.946L0 24l6.335-1.662a11.882 11.882 0 0 0 5.711 1.455h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.412Z"/></svg>`;

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
          <button type="button" class="message-contact-wa" data-message-action="send" data-phone="${phone}" title="Enviar por WhatsApp" aria-label="Enviar WhatsApp a ${safeName(name)}">${WHATSAPP_ICON}</button>
          <button type="button" class="message-contact-icon message-contact-mail" data-message-action="mail" data-phone="${phone}" title="Enviar por correo" aria-label="Enviar correo a ${safeName(name)}">${MAIL_ICON}</button>
          <button type="button" class="message-contact-icon message-contact-delete" data-message-action="delete" data-phone="${phone}" title="Eliminar" aria-label="Eliminar contacto">${TRASH_ICON}</button>
        </div></td>
      </tr>`;
    }).join("");
  }

  return { renderMessageContacts, initMessageContactsAdmin };
}