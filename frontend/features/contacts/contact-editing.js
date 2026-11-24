import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import * as Contacts from './contacts-repository.js';

/**
 * createContactEditing: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.emitCallActionWithAck, dashboardActions.escHtml, dashboardActions.loadPairingData, dashboardActions.openCallWindow, dashboardActions.renderCampaignPanel, dashboardActions.renderContacts, dashboardActions.requestConfirmation, dashboardState.currentCallingContactId, dashboardState.currentState, dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createContactEditing(dashboardState, dashboardActions) {
function renderTabs() {
  const container = refs.contactsTabsEl;
  if (!container) return;

  const lists = [...new Set([...(Contacts.lists || []), ...Contacts.contacts.map(contact => contact.list || "Principal")])];
  const listSearch = String(document.getElementById("contactsListSearch")?.value || "").trim().toLocaleLowerCase();
  const listCount = document.getElementById("contactsListCount");
  if (listCount) listCount.textContent = `${lists.length} ${lists.length === 1 ? "lista" : "listas"}`;
  container.innerHTML = lists.filter(list => !listSearch || list.toLocaleLowerCase().includes(listSearch)).map(list => {
    const count = Contacts.contacts.filter(contact => (contact.list || "Principal") === list).length;
    return `
    <div class="tab-item ${Contacts.activeList === list ? "active" : ""}" data-name="${dashboardActions.escHtml(list)}">
      <button type="button" class="contact-list-name" aria-pressed="${Contacts.activeList === list}" title="${dashboardActions.escHtml(list)}"><span class="contacts-folder-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 6.5h7l2 2H21v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 9h18"/></svg></span><span class="contacts-list-label"><strong>${dashboardActions.escHtml(list)}</strong><small>${count.toLocaleString("es-PE")} ${count === 1 ? "contacto" : "contactos"}</small></span></button>
      ${list !== "Principal" ? `<button type="button" class="delete-tab-btn" data-list="${dashboardActions.escHtml(list)}" aria-label="Eliminar lista ${dashboardActions.escHtml(list)}" title="Eliminar lista ${dashboardActions.escHtml(list)}">⋮</button>` : ""}
    </div>
  `}).join("") || `<p class="contacts-list-empty">${listSearch ? "No hay listas con ese nombre." : "Aún no hay listas."}</p>`;

  container.onclick = async (e) => {
    const tab = e.target.closest(".tab-item");
    const del = e.target.closest(".delete-tab-btn");

    if (del) {
      e.stopPropagation();
      const name = del.dataset.list;
      if (await dashboardActions.requestConfirmation({ title: "Eliminar lista", message: `¿Eliminar la lista "${name}" y todos sus contactos?`, confirmLabel: "Eliminar" })) {
        Contacts.deleteList(name);
        renderTabs();
        dashboardActions.renderContacts();
        dashboardActions.renderCampaignPanel();
        if (dashboardState.sessionCode) dashboardActions.loadPairingData(dashboardState.sessionCode);
      }
      return;
    }

    if (tab) {
      const name = tab.dataset.name;
      Contacts.setActiveList(name);
      dashboardState.currentPage = 1;
      renderTabs();
      dashboardActions.renderContacts();
      dashboardActions.renderCampaignPanel();
    }
  };
}

function dialManual(phone, name) {
  if (["dialing", "ringing", "in_call"].includes(dashboardState.currentState)) return;
  dashboardState.currentCallingContactId = null;
  dashboardActions.openCallWindow(phone, { contactName: name });
  dashboardActions.emitCallActionWithAck("dial", { phoneNumber: phone, contactName: name });
}

function openEditModal(contact) {
    if (!refs.editModalEl) return;
    refs.editNameInput.value = contact.name || "";
    refs.editPhoneInput.value = contact.phone || "";
    refs.editNoteInput.value = contact.note || "";

    refs.editSaveBtn.onclick = () => {
        const newData = {
            name: refs.editNameInput.value.trim(),
            phone: refs.editPhoneInput.value.trim(),
            note: refs.editNoteInput.value.trim()
        };
        if (Contacts.updateContact(contact.id, newData)) {
            refs.editModalEl.style.display = "none";
            dashboardActions.renderContacts();
            setStatus("Contacto actualizado.", true);
        }
    };

    refs.editCloseBtn.onclick = () => {
        refs.editModalEl.style.display = "none";
    };

    refs.editModalEl.style.display = "grid";
}
return { renderTabs, dialManual, openEditModal };
}
