import { openContactSendModal } from './message-templates.js';
import { apiFetch, currentUser } from '../auth/auth-session.js';

let initialized = false;
let users = [];

function $(id) { return document.getElementById(id); }

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
      body.innerHTML = `<tr><td colspan="3" class="muted">${hint}</td></tr>`;
      return;
    }
    body.innerHTML = dashboardState.messageContacts.map((contact) => {
      const phone = String(contact.phone || "").replace(/\D/g, "");
      return `<tr>
        <td>${dashboardActions.escHtml(contact.name || phone)}</td>
        <td>${dashboardActions.escHtml(phone)}</td>
        <td><div class="message-contact-actions" style="display:flex;gap:8px;justify-content:center">
          <button type="button" class="message-contact-wa" data-message-action="send" data-phone="${phone}" title="Enviar por WhatsApp" aria-label="Enviar WhatsApp a ${dashboardActions.escHtml(contact.name || phone)}" style="background:#25D366;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:600">💬 WhatsApp</button>
          <button type="button" class="message-contact-icon message-contact-delete" data-message-action="delete" data-phone="${phone}" title="Eliminar" aria-label="Eliminar contacto" style="background:#fee;color:#c00;border:1px solid #fcc;padding:6px 10px;border-radius:4px;cursor:pointer">🗑️</button>
        </div></td>
      </tr>`;
    }).join("");
  }

  return { renderMessageContacts, initMessageContactsAdmin };
}