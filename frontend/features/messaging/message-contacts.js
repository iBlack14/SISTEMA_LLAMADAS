import { openContactSendModal } from './message-templates.js';

/**
 * createMessageContacts: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.escHtml, dashboardState.messageContacts.
 * Se construye una vez por dashboard.
 */
export function createMessageContacts(dashboardState, dashboardActions) {
function renderMessageContacts(contacts = dashboardState.messageContacts) {
  dashboardState.messageContacts = Array.isArray(contacts) ? contacts : [];
  const body = document.getElementById("messageContactsBody");
  const count = document.getElementById("messageContactsCount");
  const status = document.getElementById("messageContactsStatus");
  if (count) count.textContent = `${dashboardState.messageContacts.length} contacto${dashboardState.messageContacts.length === 1 ? "" : "s"}`;
  if (status) status.textContent = dashboardState.messageContacts.length
    ? "Selecciona WhatsApp para redactar y enviar un mensaje."
    : "Los contactos que guardes desde el botón de WhatsApp de la APK aparecerán aquí.";
  if (!body) return;
  body.onclick = async (event) => {
    const button = event.target.closest("button[data-message-action]");
    if (!button || button.disabled) return;
    const contact = dashboardState.messageContacts.find(item => String(item.phone).replace(/\D/g, "") === button.dataset.phone);
    if (!contact) return;
    const action = button.dataset.messageAction;
    if (action === "send") { openContactSendModal(contact, "whatsapp"); return; }
    let name;
    if (action === "edit") {
      name = await dashboardActions.requestListName({ title: "Editar contacto", label: "Nombre del contacto", defaultValue: contact.name, confirmLabel: "Guardar" });
      if (name === null || !String(name || "").trim()) return;
    } else if (!await dashboardActions.requestConfirmation({ title: "Eliminar contacto", message: "¿Eliminar este contacto de Mensajes? No se borrará del teléfono.", confirmLabel: "Eliminar" })) return;
    button.disabled = true;
    try {
      const data = await dashboardActions.postCampaignAction("/message-contacts/update", { action, phone: contact.phone, name });
      if (data) renderMessageContacts(data.contacts);
    } finally { button.disabled = false; }
  };
  if (!dashboardState.messageContacts.length) {
    body.innerHTML = '<tr><td colspan="3">Todavía no hay contactos guardados.</td></tr>';
    return;
  }
  body.innerHTML = dashboardState.messageContacts.map((contact) => {
    const phone = String(contact.phone || "").replace(/\D/g, "");
    return `<tr>
      <td>${dashboardActions.escHtml(contact.name || phone)}</td>
      <td>${dashboardActions.escHtml(phone)}</td>
      <td><div class="message-contact-actions"><button type="button" class="message-contact-wa" data-message-action="send" data-phone="${phone}" title="Enviar por WhatsApp" aria-label="Enviar mensaje a ${dashboardActions.escHtml(contact.name || phone)}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.65 15L2 22l5.12-1.34A10 10 0 1 0 12 2Zm0 18a8 8 0 0 1-4.08-1.12l-.3-.18-3.04.8.81-2.96-.2-.31A8 8 0 1 1 12 20Zm4.4-5.96c-.24-.12-1.43-.7-1.65-.78-.22-.08-.38-.12-.54.12-.16.24-.62.78-.76.94-.14.16-.28.18-.52.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.21-1.44-1.35-1.68-.14-.24-.01-.37.1-.49l.36-.42c.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.54-1.3-.74-1.78-.2-.47-.4-.4-.54-.41h-.46c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2s.86 2.32.98 2.48c.12.16 1.69 2.58 4.1 3.62.57.24 1.02.39 1.37.5.57.18 1.1.15 1.51.09.46-.07 1.43-.59 1.63-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.46-.28Z"/></svg></button>
        <button type="button" class="message-contact-icon message-contact-send" data-message-action="send" data-phone="${phone}" title="Enviar mensaje" aria-label="Enviar mensaje"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h12v14H8M3 8h9M3 12h12M3 16h9m0-7 3 3-3 3"/></svg></button>
        <button type="button" class="message-contact-icon message-contact-edit" data-message-action="edit" data-phone="${phone}" title="Editar contacto" aria-label="Editar contacto"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5L9 20H4v-5L15 4Zm-3 3 5 5"/></svg></button>
        <button type="button" class="message-contact-icon message-contact-delete" data-message-action="delete" data-phone="${phone}" title="Eliminar contacto" aria-label="Eliminar contacto"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg></button>
      </div></td>
    </tr>`;
  }).join("");
}
return { renderMessageContacts };
}
