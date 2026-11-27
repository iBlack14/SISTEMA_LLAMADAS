import { refs, setStatus, setBadge, setAckBadge } from '../../shared/ui/dom.js';
import * as Contacts from './contacts-repository.js';

/**
 * createContactsView: conserva los contratos y reglas existentes.
 * Dependencias: dashboardActions.contactActionButtons, dashboardActions.contactAnnualBlock, dashboardActions.escHtml, dashboardActions.getCampaignContactMap, dashboardActions.makeId, dashboardActions.normalizeImportedPhone, dashboardActions.normalizePhone, dashboardState.PAGE_SIZE, dashboardState.callCtx, dashboardState.campaignState, dashboardState.currentPage, dashboardState.currentState.
 * Se construye una vez por dashboard.
 */
export function createContactsView(dashboardState, dashboardActions) {
function addManualContact() {
  const name = String(refs.cNameIn?.value || "").trim();
  const phone = dashboardActions.normalizeImportedPhone(refs.cPhoneIn?.value || "");
  const note = String(refs.cNoteIn?.value || "").trim();

  if (!name || !phone) {
    setStatus("Completa nombre y teléfono.", true);
    return;
  }

  const added = Contacts.addContact({ id: dashboardActions.makeId(), name, phone, note }, Contacts.activeList);
  if (!added) {
    setStatus("El telefono no es valido o ya existe en esta lista.", true);
    return;
  }
  refs.cNameIn.value = "";
  refs.cPhoneIn.value = "";
  refs.cNoteIn.value = "";
  renderContacts();
  setStatus("Contacto agregado.", true);
}

function openAddContactModal() {
  if (!refs.addContactModalEl) return;
  refs.addNameInput.value = "";
  refs.addPhoneInput.value = "";
  refs.addNoteInput.value = "";
  refs.addContactModalEl.style.display = "flex";
  refs.addNameInput.focus();
}

function saveModalContact() {
  const name = String(refs.addNameInput?.value || "").trim();
  const phone = dashboardActions.normalizeImportedPhone(refs.addPhoneInput?.value || "");
  const note = String(refs.addNoteInput?.value || "").trim();
  if (!name || !phone) {
    setStatus("Completa nombre y telefono.", true);
    return;
  }
  const added = Contacts.addContact({ id: dashboardActions.makeId(), name, phone, note }, Contacts.activeList);
  if (!added) {
    setStatus("El telefono no es valido o ya existe en esta lista.", true);
    return;
  }
  refs.addContactModalEl.style.display = "none";
  dashboardState.currentPage = 1;
  renderContacts();
  setStatus("Contacto agregado.", true);
}

let _contactsRenderDirty = false;
let _contactsPanelListenerBound = false;
function renderContacts() {
  const contactsView = document.getElementById("contactsContent");
  if (!_contactsPanelListenerBound) {
    _contactsPanelListenerBound = true;
    document.addEventListener("panel:view", (e) => {
      if (e.detail === "contacts" && _contactsRenderDirty) {
        _contactsRenderDirty = false;
        renderContacts();
      }
    });
  }
  if (contactsView && contactsView.hidden) {
    _contactsRenderDirty = true;
    return;
  }
  _contactsRenderDirty = false;
  updateCalledContactsCounter();
  const cBodyEl = refs.cBodyEl;
  cBodyEl.innerHTML = "";

  // Filter by active list
  const allContacts = Contacts.contacts;
  const query = String(document.getElementById("filterInput")?.value || "").trim().toLocaleLowerCase();
  const contacts = allContacts.filter(c => {
    if (c.list !== Contacts.activeList) return false;
    if (!query) return true;
    return `${c.company || c.name || ""} ${c.phone || ""}`.toLocaleLowerCase().includes(query);
  });
  const allInList = allContacts.filter(c => c.list === Contacts.activeList).length;
  const activeTitle = document.getElementById("contactsActiveListTitle");
  const activeCount = document.getElementById("contactsActiveListCount");
  if (activeTitle) activeTitle.textContent = Contacts.activeList || "Mis contactos";
  if (activeCount) activeCount.textContent = `${allInList.toLocaleString("es-PE")} ${allInList === 1 ? "contacto" : "contactos"}`;
  const totalPages = Math.max(1, Math.ceil(contacts.length / dashboardState.PAGE_SIZE));
  if (dashboardState.currentPage > totalPages) dashboardState.currentPage = totalPages;

  if (!contacts.length) {
    cBodyEl.innerHTML = `<tr><td colspan="4" class="contacts-empty-state">${query ? "No hay contactos que coincidan con la búsqueda." : "Sin contactos en esta lista. Sube un archivo CSV o Excel para empezar."}</td></tr>`;
    refs.contactsPaginationEl.style.display = "none";
    renderReminderFloat();
    return;
  }

  const startIndex = (dashboardState.currentPage - 1) * dashboardState.PAGE_SIZE;
  const pageRows = contacts.slice(startIndex, startIndex + dashboardState.PAGE_SIZE);
  const activeContactIds = new Set(Object.values(dashboardState.campaignState?.assignments || {})
    .map(assignment => String(assignment.contactId || "")));

  const monthsShort = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  function formatDate(contact) {
    const raw = contact?.createdAt || contact?.created_at || contact?.date || contact?.fecha;
    if (!raw) return "—";
    // MySQL devuelve "2026-11-18 17:09:57"; normalizarlo evita fechas inválidas.
    const text = String(raw).trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.slice(0, 10));
    const normalized = text.replace(" ", "T").replace(/\s+.*$/, "");
    // YYYY-MM-DD se parsea por componentes para no correr un día en Lima (UTC-5).
    const d = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(normalized);
    if (isNaN(d.getTime())) return "—";
    return `${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
  }

  const fragment = document.createDocumentFragment();
  for (const c of pageRows) {
    const tr = document.createElement("tr");
    const callCount = Number(Contacts.calledCounts[c.id] || 0);
    const rowStatus = String(Contacts.contactRowStatus[c.id] || "").toLowerCase();
    const duration = Number(Contacts.callDurations[c.id] || 0);
    const isThisActiveCall = (dashboardState.currentState === "in_call" || dashboardState.currentState === "ringing" || dashboardState.currentState === "dialing") && dashboardActions.normalizePhone(dashboardState.callCtx?.phone) === dashboardActions.normalizePhone(c.phone);

    if (callCount > 0) tr.classList.add("contact-row-called");
    if (duration > 0) tr.classList.add("contact-row-answered");
    if (["r", "lc", "sc"].includes(rowStatus)) tr.classList.add(`contact-row-status-${rowStatus}`);

    const isCampaignActive = activeContactIds.has(String(c.id));
    if (isCampaignActive || isThisActiveCall) {
        tr.classList.add(dashboardState.currentState === "in_call" ? "contact-row-active-in-call" : "contact-row-active-call");
    }

    const company = c.company || c.name || "";
    const dateStr = formatDate(c);
    tr.innerHTML = `
      <td>${dashboardActions.escHtml(company)}${callCount ? `<span class="contacts-row-call-count">${callCount} llamadas</span>` : ""}</td>
      <td class="contacts-phone-cell">${dashboardActions.escHtml(c.phone)}</td>
      <td class="contacts-date-cell">${dashboardActions.escHtml(dateStr)}</td>
      <td class="contacts-action-cell">${dashboardActions.contactActionButtons(c)}</td>`;
    fragment.appendChild(tr);
  }
  cBodyEl.appendChild(fragment);

  refs.contactsPaginationEl.style.display = contacts.length ? "flex" : "none";
  refs.pageInfoEl.textContent = `Mostrando ${startIndex + 1}–${Math.min(startIndex + pageRows.length, contacts.length)} de ${contacts.length.toLocaleString("es-PE")} · Página ${dashboardState.currentPage} de ${totalPages}`;
  refs.prevPageBtn.disabled = dashboardState.currentPage <= 1;
  refs.nextPageBtn.disabled = dashboardState.currentPage >= totalPages;
  renderReminderFloat();
}

function updateCalledContactsCounter() {
  if (!refs.calledContactsValueEl) return;
  const count = Contacts.contacts.reduce((acc, c) => acc + (Number(Contacts.calledCounts[c.id] || 0) > 0 ? 1 : 0), 0);
  refs.calledContactsValueEl.textContent = String(count);
}

function renderReminderFloat() {
    if (!refs.reminderFloatContainer) return;
    refs.reminderFloatContainer.innerHTML = "";

    const now = Date.now();
    const reminders = Contacts.contacts.filter(c => {
        if (!c.note || Contacts.dismissedReminderIds[c.id]) return false;
        return c.note.toLowerCase().includes("llamar") || c.note.toLowerCase().includes("callback");
    });

    if (!reminders.length) return;

    reminders.slice(0, 3).forEach(c => {
        const div = document.createElement("div");
        div.className = "reminder-float-item";
        div.innerHTML = `
            <div class="reminder-content">
                <strong>Recordatorio: ${dashboardActions.escHtml(c.name)}</strong>
                <p>${dashboardActions.escHtml(c.note)}</p>
            </div>
            <div class="reminder-actions">
                <button onclick="dialManual('${dashboardActions.escHtml(c.phone)}', '${dashboardActions.escHtml(c.name)}')">📞</button>
                <button onclick="dismissReminder('${dashboardActions.escHtml(c.id)}')">✕</button>
            </div>
        `;
        refs.reminderFloatContainer.appendChild(div);
    });
}
return { addManualContact, openAddContactModal, saveModalContact, renderContacts, updateCalledContactsCounter, renderReminderFloat };
}
