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

  const lists = (Contacts.lists || []).filter((list) =>
    Contacts.contacts.some((contact) => (contact.list || "Principal") === list)
  );
  container.innerHTML = lists.map(list => `
    <div class="tab-item ${Contacts.activeList === list ? "active" : ""}" data-name="${dashboardActions.escHtml(list)}">
      <button type="button" class="contact-list-name" aria-pressed="${Contacts.activeList === list}" title="${dashboardActions.escHtml(list)}">${dashboardActions.escHtml(list)}</button>
      ${list !== "Principal" ? `<button type="button" class="delete-tab-btn" data-list="${dashboardActions.escHtml(list)}" aria-label="Eliminar lista ${dashboardActions.escHtml(list)}" title="Eliminar lista ${dashboardActions.escHtml(list)}">×</button>` : ""}
    </div>
  `).join("");

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
