import { socket, API_BASE } from './modules/socket.js?v=2';
import { validateReportPeriod, isInReportPeriod, reportPeriodLabel } from './modules/report-period.js?v=20261106-range';
import { refs, setStatus, setBadge, setAckBadge } from './modules/dom.js?v=20260810-list-data-order';
import * as Contacts from './modules/contacts.js?v=20261106-mysql-book';
import * as AudioBridge from './modules/audio-bridge.js?v=2';
import * as WhatsApp from './modules/whatsapp.js?v=20261106-mysql-book';
import { apiFetch as fetch, currentUser, bindAccountControls } from './modules/auth.js';
import { isAnsweredAttempt } from './modules/report-metrics.js';

// ── STATE ──────────────────────────────────────────────────────────────
let sessionCode = "";
let dashboardToken = "";
let pairQrObjectUrls = [];
let pairingStateSignature = "";
let pairingSlotsSnapshot = [];
let callCtx = null;
let callTimerId = null;
let callStartedAt = null;
let lastCallDuration = 0;
let currentState = "idle";
let micEnabled = false;
let speakerEnabled = false;
let importPreviewData = [];
let importPreviewBatches = [];
let currentPage = 1;
let currentCallingContactId = null;
let currentPhoneLinked = false;
let latestSessionState = {};
let campaignState = null;
let reportRowsCache = [];
let reportCacheSession = "";
let reportRequestSerial = 0;
let reportPeriod = { from: "", to: "" };
let reportShiftId = "";
let reportListFilter = "";
let reportWorkerFilter = "";
let reportResultFilter = "";
const pendingCommandTimeouts = new Map();
// The contact database is browsed inside a seven-row scroll area. Render the
// complete selected list so scrolling can reach every record without paging.
const PAGE_SIZE = 10000;
const DASHBOARD_SESSION_KEY = `voip vc.auth.${currentUser.id}.dashboardSessionCode`;
const DASHBOARD_TOKEN_PREFIX = `voip vc.auth.${currentUser.id}.dashboardToken.`;
const DASHBOARD_CLIENT_KEY = `voip vc.auth.${currentUser.id}.dashboardClientId`;
const dashboardClientId = (() => {
  let value = String(sessionStorage.getItem(DASHBOARD_CLIENT_KEY) || "").trim();
  if (!value) {
    value = globalThis.crypto?.randomUUID?.() || `dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(DASHBOARD_CLIENT_KEY, value);
  }
  return value;
})();
const TURN_PENDING_PREFIX = "voip vc.turnPending.";
const HIDDEN_ASSIGNED_RECORDS_PREFIX = "voip vc.hiddenAssignedRecords.";
const PAIRING_LIST_ASSIGNMENTS_PREFIX = "voip vc.pairingListAssignments.";
let restoreAttempted = false;
let autoSessionRequested = false;
let pendingRecoveryRunning = false;
let normalCampaignResumeRequested = false;

function getHiddenAssignedRecords() {
  if (!sessionCode) return new Set();
  try {
    const saved = Contacts.getPreference("hiddenAssignedRecords", []);
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  } catch {
    return new Set();
  }
}

function hideAssignedRecord(listName) {
  if (!sessionCode || !listName) return;
  const hidden = getHiddenAssignedRecords();
  hidden.add(String(listName));
  Contacts.setPreference("hiddenAssignedRecords", [...hidden]);
}

// ── INITIALIZATION ──────────────────────────────────────────────────
window.addEventListener("contact-book:loaded", () => {
  WhatsApp.loadWhatsAppPresetMessages();
  WhatsApp.saveWhatsAppPresetMessages();
  renderTabs(); renderContacts(); renderCampaignPanel();
});
window.addEventListener("contact-book:error", event => {
  setStatus(event.detail + " No cierres esta página; recarga para recuperar la base confirmada.", true);
});

async function init() {
  console.log("Dashboard init starting...");
  // Authenticated accounts only load data from their authorized MySQL session.
  // The anonymous legacy browser database is deliberately left untouched.
  bindAccountControls();
  WhatsApp.loadWhatsAppPresetMessages();
  
  renderContacts();
  loadApkInfo().catch(e => console.error("Error loading APK info:", e));
  bindEvents();
  syncAudioButtons();
  renderCampaignPanel();
  restoreSavedSession();
  
  setStatus("Listo.");
  console.log("Dashboard init complete.");
}

// ── UI RENDERING ──────────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function makeId() {
  return (typeof crypto.randomUUID === "function")
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function normalizePhone(input) {
  return String(input || "").replace(/[^\d+]/g, "").trim();
}

function normalizeImportedPhone(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  // Preserve malformed source values so they can be audited, but never dialed.
  if (/\p{L}/u.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return raw.startsWith("+") ? `+${digits}` : digits;
}

function normalizeValidPeruPhone(input) {
  const raw = String(input || "").trim();
  if (!raw || /\p{L}/u.test(raw)) return "";
  let digits = raw.replace(/\D/g, "");
  if ((raw.startsWith("+51") || (digits.length === 11 && digits.startsWith("51"))) && digits.startsWith("51")) {
    digits = digits.slice(2);
  }
  return /^\d{9}$/.test(digits) ? digits : "";
}

function whatsappActionIcon() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16.01 3C8.84 3 3 8.75 3 15.82c0 2.25.6 4.45 1.73 6.38L3 29l7.02-1.82a13.15 13.15 0 0 0 5.99 1.45H16c7.17 0 13-5.75 13-12.82S23.18 3 16.01 3Zm7.65 18.1c-.32.9-1.88 1.72-2.6 1.82-.67.1-1.52.15-2.45-.14-.57-.18-1.3-.42-2.24-.82-3.94-1.68-6.52-5.59-6.72-5.85-.19-.26-1.6-2.1-1.6-4.01 0-1.92 1.02-2.86 1.38-3.25.36-.39.79-.49 1.05-.49h.76c.24 0 .57-.09.89.67.32.77 1.1 2.68 1.2 2.87.1.19.16.42.03.68-.13.26-.2.42-.39.65-.2.23-.41.5-.59.67-.2.19-.4.4-.17.79.23.39 1.03 1.67 2.21 2.71 1.52 1.34 2.8 1.76 3.2 1.95.39.2.62.16.85-.1.23-.26.98-1.13 1.24-1.52.26-.39.53-.32.89-.19.36.13 2.3 1.07 2.69 1.26.39.19.66.29.75.45.1.16.1.94-.22 1.85Z"/></svg>`;
}

function mobileCallActionIcon() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M7.15 3.15 11.7 2c.88-.22 1.8.23 2.14 1.07l2.08 5.13c.3.74.08 1.6-.55 2.09l-2.66 2.12a19.05 19.05 0 0 0 6.88 6.88l2.12-2.66a1.82 1.82 0 0 1 2.09-.55l5.13 2.08c.84.34 1.29 1.26 1.07 2.14l-1.15 4.55a3.13 3.13 0 0 1-3.03 2.38C14.21 27.23 4.77 17.79 4.77 6.18a3.13 3.13 0 0 1 2.38-3.03Z" fill="currentColor"/></svg>`;
}

function contactAnnualBlock(contact) {
  const phone = normalizeValidPeruPhone(contact.phone);
  const restriction = latestSessionState?.callRestrictions?.[phone];
  if (restriction?.permanent || contact.doNotCall) return "permanent";
  const until = restriction?.nextAllowedAt || contact.callBlockedUntil;
  return until && Date.parse(until) > Date.now() ? until : null;
}

function contactActionButtons(contact, scope = "contacts") {
  const until = contactAnnualBlock(contact);
  const reason = until === "permanent" ? "NO VOLVER A LLAMAR: número inexistente o incorrecto" : until ? "Número llamado anteriormente. Disponible desde " + new Date(until).toLocaleDateString("es-PE",{timeZone:"America/Lima"}) : "";
  return `<div class="contact-action-buttons">
    <button type="button" class="wa-action-btn" data-action="whatsapp-direct" data-id="${escHtml(contact.id || "")}" data-list-contact-scope="${scope}" aria-label="Contactar por WhatsApp" title="Contactar por WhatsApp">${whatsappActionIcon()}<span>WHATSAPP</span></button>
    <button type="button" class="call-action-btn" data-action="call-direct" data-id="${escHtml(contact.id || "")}" data-list="${escHtml(contact.list || "Principal")}" data-list-contact-scope="${scope}" aria-label="Llamar a este contacto" title="${escHtml(reason || "Llamar desde el equipo asignado")}" ${until ? "disabled" : ""}>${mobileCallActionIcon()}<span>${until === "permanent" ? "NO VOLVER A LLAMAR" : until ? "YA LLAMADO" : "LLAMAR"}</span></button>
  </div>`;
}

function turnPendingKey(contact = {}) {
  return `${String(contact.list || "Principal").trim().toLowerCase()}|${normalizeValidPeruPhone(contact.phone)}`;
}

function loadTurnPendingContacts() {
  if (!sessionCode) return [];
  const serverPending = campaignState?.turn?.pendingContacts
    ?? latestSessionState?.shiftManagement?.pendingContacts;
  if (Array.isArray(serverPending)) {
    return serverPending.filter((item) => normalizeValidPeruPhone(item.phone));
  }
  try {
    const parsed = Contacts.getPreference("turnPending", []);
    return Array.isArray(parsed) ? parsed.filter((item) => normalizeValidPeruPhone(item.phone)) : [];
  } catch {
    return [];
  }
}

function saveTurnPendingContacts(contacts) {
  if (!sessionCode) return;
  Contacts.setPreference("turnPending", contacts);
}

function syncTurnPendingContacts() {
  if (!sessionCode) return;
  const serverPending = campaignState?.turn?.pendingContacts
    ?? latestSessionState?.shiftManagement?.pendingContacts;
  if (Array.isArray(serverPending)) saveTurnPendingContacts(serverPending);
}

function renderTurnPendingContacts() {
  const pending = loadTurnPendingContacts();
  if (refs.pendingTurnCountEl) refs.pendingTurnCountEl.textContent = `${pending.length} pendiente${pending.length === 1 ? "" : "s"}`;
  if (refs.pendingTurnBodyEl) {
    refs.pendingTurnBodyEl.innerHTML = pending.length
      ? pending.map((contact) => {
          const sourceContact = Contacts.contacts.find((item) =>
            (item.list || "Principal") === (contact.list || "Principal")
            && normalizeValidPeruPhone(item.phone) === normalizeValidPeruPhone(contact.phone)
          ) || contact;
          return `<tr>
          <td>${escHtml(contact.list || "Principal")}</td>
          <td>${escHtml(contact.name || "Sin nombre")}</td>
          <td>${escHtml(contact.phone || "-")}</td>
          <td>${contactActionButtons(sourceContact, "turn-pending")}</td>
        </tr>`;
        }).join("")
      : `<tr><td colspan="4" class="pending-turn-empty">No hay números pendientes del turno.</td></tr>`;
  }
}

function currentShiftSnapshot() {
  return campaignState?.turn || latestSessionState?.shiftManagement || null;
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
  if (refs.finalizeSessionBtn) refs.finalizeSessionBtn.disabled = !sessionCode;

  if (refs.shiftHistoryPanelEl) {
    const history = Array.isArray(snapshot?.history) ? snapshot.history.slice(0, 4) : [];
    refs.shiftHistoryPanelEl.innerHTML = history.length
      ? `<div class="shift-history-head"><strong>TURNOS FINALIZADOS</strong><span>${history.length} recientes</span></div>
        <div class="shift-history-list">${history.map((turn) => `
          <article>
            <div><strong>${escHtml(turn.label || "Turno")}</strong><small>${escHtml(turn.date || "")}</small></div>
            <span>${Number(turn.summary?.total || 0)} llamadas</span>
            <span>${Number(turn.summary?.answered || 0)} contestadas</span>
            <span>${Number(turn.summary?.failed || 0)} pendientes</span>
          </article>`).join("")}</div>`
      : "";
  }
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function mapRowByHeaders(row, headers) {
  const out = {};
  headers.forEach((header, index) => {
    out[header] = row[index];
  });
  return out;
}

function buildContactFromStructuredRow(row, fallbackIndex) {
  const entries = Object.entries(row || {});
  const normalized = Object.fromEntries(entries.map(([key, value]) => [normalizeHeader(key), String(value || "").trim()]));

  const rawName =
    normalized.name ||
    normalized.nombre ||
    normalized.company ||
    normalized.empresa ||
    normalized.businessname ||
    "";

  const rawPhone =
    normalized.mobilenumber ||
    normalized.mobile ||
    normalized.phone ||
    normalized.telefono ||
    normalized.telefono1 ||
    normalized.celular ||
    normalized.whatsapp ||
    normalized.tel ||
    "";

  const rawWebsite =
    normalized.website ||
    normalized.web ||
    normalized.url ||
    normalized.sitio ||
    "";

  const fallbackValues = entries.map(([, value]) => String(value || "").trim()).filter(Boolean);
  const detectedPhone = rawPhone || fallbackValues.find(v => /\+?\d[\d\s().-]{5,}/.test(v)) || "";
  if (!detectedPhone) return null;

  const detectedName =
    rawName ||
    fallbackValues.find(v => !/\+?\d[\d\s().-]{5,}/.test(v) && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(v) && !/^https?:\/\//i.test(v) && !/^tel:/i.test(v)) ||
    `Contacto ${fallbackIndex + 1}`;

  const noteParts = [];
  if (rawWebsite) noteParts.push(rawWebsite);
  for (const value of fallbackValues) {
    if (value === detectedName || value === detectedPhone || value === rawWebsite) continue;
    if (!noteParts.includes(value)) noteParts.push(value);
  }

  return {
    id: makeId(),
    name: detectedName,
    phone: normalizeImportedPhone(detectedPhone),
    note: noteParts.join(" ").trim()
  };
}

function buildContactFromTableArrayRow(row, fallbackIndex) {
  const values = (row || []).map((value) => String(value || "").trim());
  if (!values.length) return null;

  const first = values[0] || "";
  const second = values[1] || "";
  const third = values[2] || "";
  const fourth = values[3] || "";

  const firstIsPhone = /\+?\d[\d\s().-]{5,}/.test(first);
  const secondIsPhone = /\+?\d[\d\s().-]{5,}/.test(second);

  const detectedName = !firstIsPhone && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(first)
    ? first
    : (!secondIsPhone && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(second) ? second : `Contacto ${fallbackIndex + 1}`);

  const detectedPhone = secondIsPhone
    ? second
    : (firstIsPhone ? first : "");

  if (!detectedPhone) return null;

  const noteParts = [third, fourth]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return {
    id: makeId(),
    name: detectedName,
    phone: normalizeImportedPhone(detectedPhone),
    note: noteParts.join(" ").trim()
  };
}

function extractContactsFromHtmlTable(doc) {
  const tables = [...doc.querySelectorAll("table")];
  for (const table of tables) {
    const rows = [...table.querySelectorAll("tr")];
    if (rows.length < 2) continue;

    const headerCells = [...rows[0].querySelectorAll("th,td")].map((cell) => normalizeHeader(cell.textContent || ""));
    const nameIdx = headerCells.findIndex((header) => ["name", "nombre", "company", "empresa", "businessname"].includes(header));
    const phoneIdx = headerCells.findIndex((header) => ["mobilenumber", "mobile", "phone", "telefono", "celular", "tel", "whatsapp"].includes(header));
    const websiteIdx = headerCells.findIndex((header) => ["website", "web", "url", "sitio"].includes(header));

    if (nameIdx === -1 && phoneIdx === -1) continue;

    const contacts = [];
    for (const row of rows.slice(1)) {
      const cols = [...row.querySelectorAll("th,td")].map((cell) => String(cell.textContent || "").trim());
      if (!cols.some(Boolean)) continue;

      const name = String(cols[nameIdx] || "").trim();
      const phone = normalizeImportedPhone(cols[phoneIdx] || "");
      const website = websiteIdx >= 0 ? String(cols[websiteIdx] || "").trim() : "";

      if (!phone) continue;
      contacts.push({
        id: makeId(),
        name: name || `Contacto ${contacts.length + 1}`,
        phone,
        note: website
      });
    }

    if (contacts.length) return contacts;
  }

  return [];
}

function extractContactsFromRows(rows) {
  const out = [];
  const list = rows || [];
  if (!list.length) return out;

  const firstRow = list[0];
  const headerCandidates = Array.isArray(firstRow) ? firstRow.map(normalizeHeader) : Object.keys(firstRow || {}).map(normalizeHeader);
  const hasStructuredHeaders = headerCandidates.some((header) =>
    ["name", "nombre", "mobilenumber", "mobile", "phone", "telefono", "celular", "website", "web", "url"].includes(header)
  );

  const structuredRows = hasStructuredHeaders
    ? list.slice(1).map((row) => Array.isArray(row) ? mapRowByHeaders(row, firstRow) : row)
    : list;

  for (const row of structuredRows) {
    if (Array.isArray(row)) {
      const tableContact = buildContactFromTableArrayRow(row, out.length);
      if (tableContact?.phone) {
        out.push(tableContact);
        continue;
      }
    }
    const contact = buildContactFromStructuredRow(row, out.length);
    if (!contact?.phone) continue;
    out.push(contact);
  }
  return out;
}

function parseDelimitedText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const rows = lines.map((line) => {
    if (line.includes("\t")) return line.split("\t");
    if (line.includes(";")) return line.split(";");
    return line.split(",");
  });
  return extractContactsFromRows(rows);
}

function showImportPreview(items, listName = "") {
  importPreviewBatches = [];
  importPreviewData = items.slice(0, 500);
  refs.previewBody.innerHTML = "";
  refs.previewCountEl.textContent = String(importPreviewData.length);

  const fragment = document.createDocumentFragment();
  for (const item of importPreviewData) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escHtml(listName || "Por definir")}</td>
      <td>${escHtml(item.name)}</td>
      <td style="font-family:monospace;">${escHtml(item.phone)}</td>
    `;
    fragment.appendChild(tr);
  }
  refs.previewBody.appendChild(fragment);

  refs.importPreview.style.display = importPreviewData.length ? "block" : "none";
}

function resetImportPreview() {
  importPreviewData = [];
  importPreviewBatches = [];
  refs.previewBody.innerHTML = "";
  refs.previewCountEl.textContent = "0";
  refs.importPreview.style.display = "none";
  if (refs.importFileEl) refs.importFileEl.value = "";
  if (refs.importFileNameEl) refs.importFileNameEl.textContent = "Ninguno seleccionado";
}

let currentImportFileName = ""; // Global variable to store the current import file name

function requestListName({ title = "Nueva lista", defaultValue = "", label = "Nombre de la lista", placeholder = "Ej. Avícolas" } = {}) {
  return new Promise((resolve) => {
    const modal = refs.listNameModalEl;
    const input = refs.listNameInputEl;
    if (!modal || !input) return resolve(null);

    refs.listNameTitleEl.textContent = title;
    if (refs.listNameLabelEl) refs.listNameLabelEl.textContent = label;
    refs.listNameErrorEl.textContent = "";
    input.value = defaultValue;
    input.placeholder = placeholder;
    modal.style.display = "flex";

    const finish = (value) => {
      modal.style.display = "none";
      refs.listNameSaveBtn.onclick = null;
      refs.listNameCancelBtn.onclick = null;
      refs.listNameCloseBtn.onclick = null;
      input.onkeydown = null;
      resolve(value);
    };
    const save = () => {
      const value = input.value.trim();
      if (!value) {
        refs.listNameErrorEl.textContent = "Escribe un nombre para la lista.";
        input.focus();
        return;
      }
      finish(value);
    };

    refs.listNameSaveBtn.onclick = save;
    refs.listNameCancelBtn.onclick = () => finish(null);
    refs.listNameCloseBtn.onclick = () => finish(null);
    input.onkeydown = (event) => {
      if (event.key === "Enter") save();
      if (event.key === "Escape") finish(null);
    };
    setTimeout(() => input.focus(), 0);
  });
}

function requestConfirmation({ title = "Confirmar acción", message = "", confirmLabel = "Aceptar", cancelLabel = "Cancelar", showCancel = true } = {}) {
  return new Promise((resolve) => {
    const modal = refs.confirmModalEl;
    if (!modal) return resolve(false);
    refs.confirmTitleEl.textContent = title;
    refs.confirmMessageEl.textContent = message;
    refs.confirmAcceptBtn.textContent = confirmLabel;
    refs.confirmCancelBtn.textContent = cancelLabel;
    refs.confirmCancelBtn.style.display = showCancel ? "" : "none";
    modal.style.display = "flex";

    const finish = (accepted) => {
      modal.style.display = "none";
      refs.confirmAcceptBtn.onclick = null;
      refs.confirmCancelBtn.onclick = null;
      refs.confirmCloseBtn.onclick = null;
      resolve(accepted);
    };
    refs.confirmAcceptBtn.onclick = () => finish(true);
    refs.confirmCancelBtn.onclick = () => finish(false);
    refs.confirmCloseBtn.onclick = () => finish(false);
    setTimeout(() => refs.confirmAcceptBtn.focus(), 0);
  });
}

window.AppDialogs = {
  confirm: (message, title = "Confirmar acción") => requestConfirmation({ title, message }),
  alert: (message, title = "Aviso") => requestConfirmation({ title, message, confirmLabel: "Entendido", showCancel: false })
};

async function addImportedContacts() {
  try { await Contacts.flushDatabase(); }
  catch (error) { setStatus(error.message, true); return; }
  if (importPreviewBatches.length) {
    let totalAdded = 0;
    let processedLists = 0;
    let omitted = 0;
    for (const batch of importPreviewBatches) {
      Contacts.addList(batch.listName);
      const added = Contacts.addContacts(batch.contacts, batch.listName);
      totalAdded += added;
      omitted += Math.max(0, batch.contacts.length - added);
      processedLists += 1;
    }
    Contacts.setActiveList(importPreviewBatches[0].listName);
    try { await Contacts.flushDatabase(); }
    catch (error) { setStatus(error.message, true); return; }
    setStatus(`${processedLists} lista(s) procesada(s): ${totalAdded} contacto(s) agregado(s)${omitted ? ` y ${omitted} duplicado(s) omitido(s)` : ""}.`, true);
    resetImportPreview();
    renderTabs();
    renderContacts();
    renderCampaignPanel();
    if (sessionCode) loadPairingData(sessionCode);
    return;
  }
  if (!importPreviewData.length) return;
  
  const defaultTab = currentImportFileName ? currentImportFileName.split('.')[0] : "Lista Nueva";
  const listName = await requestListName({ title: "Guardar contactos importados", defaultValue: defaultTab });
  if (!listName) return;
  
  Contacts.addList(listName);
  Contacts.setActiveList(listName);
  const addedCount = Contacts.addContacts(importPreviewData, listName);
  try { await Contacts.flushDatabase(); }
  catch (error) { setStatus(error.message, true); return; }
  setStatus(`Lista "${listName}" creada con ${addedCount} contacto(s).`, true);
  resetImportPreview();
  renderTabs();
  renderContacts();
  renderCampaignPanel();
  if (sessionCode) loadPairingData(sessionCode);
}

async function parseContactsFromFile(file) {
  const lowerName = file.name.toLowerCase();
  let contacts = [];

  if (lowerName.endsWith(".csv") || lowerName.endsWith(".txt")) {
    contacts = parseDelimitedText(await file.text());
  } else if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
    const data = await file.arrayBuffer();
    const wb = window.XLSX.read(data, { type: "array" });
    const firstSheet = wb.SheetNames[0];
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[firstSheet], { header: 1 });
    contacts = extractContactsFromRows(rows);
  } else if (lowerName.endsWith(".docx")) {
    const data = await file.arrayBuffer();
    const htmlResult = await window.mammoth.convertToHtml({ arrayBuffer: data });
    const doc = new DOMParser().parseFromString(htmlResult.value || "", "text/html");
    contacts = extractContactsFromHtmlTable(doc);
    if (!contacts.length) {
      const textResult = await window.mammoth.extractRawText({ arrayBuffer: data });
      contacts = parseDelimitedText(textResult.value);
    }
  } else {
    throw new Error(`Formato no soportado: ${file.name}`);
  }
  return contacts;
}

function listNameFromFile(fileName) {
  return String(fileName || "Lista")
    .replace(/\.[^.]+$/, "")
    .trim()
    .replace(/\s+/g, " ") || "Lista";
}

async function handleImportFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  refs.importFileNameEl.textContent = files.length === 1 ? files[0].name : `${files.length} archivos seleccionados`;

  const results = await Promise.all(files.map(async (file) => {
    try {
      const contacts = await parseContactsFromFile(file);
      return { file, listName: listNameFromFile(file.name), contacts, error: null };
    } catch (error) {
      console.error("Import file error:", file.name, error);
      return { file, listName: listNameFromFile(file.name), contacts: [], error };
    }
  }));

  importPreviewBatches = results.filter((batch) => !batch.error && batch.contacts.length);
  importPreviewData = importPreviewBatches.flatMap((batch) =>
    batch.contacts.map((contact) => ({ ...contact, importListName: batch.listName }))
  );
  refs.previewBody.innerHTML = "";
  refs.previewCountEl.textContent = String(importPreviewData.length);
  const fragment = document.createDocumentFragment();
  for (const item of importPreviewData.slice(0, 500)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escHtml(item.importListName)}</td><td>${escHtml(item.name)}</td><td style="font-family:monospace;">${escHtml(item.phone)}</td>`;
    fragment.appendChild(tr);
  }
  refs.previewBody.appendChild(fragment);
  refs.importPreview.style.display = importPreviewData.length ? "block" : "none";

  const failed = results.filter((batch) => batch.error || !batch.contacts.length);
  const detail = failed.length ? ` ${failed.length} archivo(s) no tenían contactos válidos o no pudieron leerse.` : "";
  setStatus(importPreviewData.length
    ? `${importPreviewBatches.length} lista(s) preparada(s) con ${importPreviewData.length} contacto(s).${detail}`
    : `No se detectaron contactos válidos.${detail}`, true);
}

async function handleImportUrl() {
  const url = String(refs.importUrlEl.value || "").trim();
  if (!url) {
    setStatus("Pega una URL para importar.", true);
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/fetch-url?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok || !data.ok || !data.html) {
      setStatus(data.error || "No se pudo leer la URL.", true);
      return;
    }

    const doc = new DOMParser().parseFromString(data.html, "text/html");
    const directTableContacts = extractContactsFromHtmlTable(doc);
    if (directTableContacts.length) {
      showImportPreview(directTableContacts);
      setStatus(`Se detectaron ${directTableContacts.length} contactos desde la URL.`, true);
      return;
    }

    const rows = [];
    doc.querySelectorAll("table tr").forEach((tr) => {
      const cols = [...tr.querySelectorAll("th,td")].map((el) => el.textContent?.trim() || "");
      if (cols.some(Boolean)) rows.push(cols);
    });
    if (!rows.length) {
      doc.querySelectorAll("li, p").forEach((el) => {
        const text = el.textContent?.trim() || "";
        if (text) rows.push([text]);
      });
    }

    const contacts = extractContactsFromRows(rows);
    showImportPreview(contacts);
    setStatus(contacts.length ? `Se detectaron ${contacts.length} contactos desde la URL.` : "No se detectaron contactos en la URL.", true);
  } catch (error) {
    console.error("Import URL error:", error);
    setStatus("No se pudo importar desde la URL.", true);
  }
}

function addManualContact() {
  const name = String(refs.cNameIn?.value || "").trim();
  const phone = normalizeImportedPhone(refs.cPhoneIn?.value || "");
  const note = String(refs.cNoteIn?.value || "").trim();

  if (!name || !phone) {
    setStatus("Completa nombre y teléfono.", true);
    return;
  }

  const added = Contacts.addContact({ id: makeId(), name, phone, note }, Contacts.activeList);
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
  const phone = normalizeImportedPhone(refs.addPhoneInput?.value || "");
  const note = String(refs.addNoteInput?.value || "").trim();
  if (!name || !phone) {
    setStatus("Completa nombre y telefono.", true);
    return;
  }
  const added = Contacts.addContact({ id: makeId(), name, phone, note }, Contacts.activeList);
  if (!added) {
    setStatus("El telefono no es valido o ya existe en esta lista.", true);
    return;
  }
  refs.addContactModalEl.style.display = "none";
  currentPage = 1;
  renderContacts();
  setStatus("Contacto agregado.", true);
}

function renderContacts() {
  updateCalledContactsCounter();
  const cBodyEl = refs.cBodyEl;
  cBodyEl.innerHTML = "";
  
  // Filter by active list
  const allContacts = Contacts.contacts;
  const contacts = allContacts.filter(c => c.list === Contacts.activeList);
  
  const totalPages = Math.max(1, Math.ceil(contacts.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  if (!contacts.length) {
    cBodyEl.innerHTML = `<tr><td colspan="3" class="muted" style="text-align:center;padding:18px;">Sin contactos. Importa un archivo para crear la primera lista.</td></tr>`;
    refs.contactsPaginationEl.style.display = "none";
    renderReminderFloat();
    return;
  }

  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const pageRows = contacts.slice(startIndex, startIndex + PAGE_SIZE);

  const fragment = document.createDocumentFragment();
  for (const c of pageRows) {
    const tr = document.createElement("tr");
    const callCount = Number(Contacts.calledCounts[c.id] || 0);
    const rowStatus = String(Contacts.contactRowStatus[c.id] || "").toLowerCase();
    const duration = Number(Contacts.callDurations[c.id] || 0);
    const campaignContact = getCampaignContactMap().get(c.id);
    
    const isThisActiveCall = (currentState === "in_call" || currentState === "ringing" || currentState === "dialing") && normalizePhone(callCtx?.phone) === normalizePhone(c.phone);

    if (callCount > 0) tr.classList.add("contact-row-called");
    if (duration > 0) tr.classList.add("contact-row-answered");
    if (["r", "lc", "sc"].includes(rowStatus)) tr.classList.add(`contact-row-status-${rowStatus}`);
    
    const isCampaignActive = Object.values(campaignState?.assignments || {}).some((assignment) => assignment.contactId === c.id);
    if (isCampaignActive || isThisActiveCall) {
        tr.classList.add(currentState === "in_call" ? "contact-row-active-in-call" : "contact-row-active-call");
    }
    
    tr.innerHTML = `
      <td>${escHtml(c.name)}</td>
      <td style="font-family:monospace;font-size:13px;">${escHtml(c.phone)}${contactAnnualBlock(c) ? '<small style="display:block;font-family:inherit;">' + (contactAnnualBlock(c) === "permanent" ? "NO VOLVER A LLAMAR: número inexistente o incorrecto" : "Número llamado anteriormente") + '</small>' : ""}</td>
      <td class="actions-cell contact-direct-cell">${contactActionButtons(c)}</td>`;
    fragment.appendChild(tr);
  }
  cBodyEl.appendChild(fragment);

  refs.contactsPaginationEl.style.display = totalPages > 1 ? "flex" : "none";
  refs.pageInfoEl.textContent = `Página ${currentPage} de ${totalPages}`;
  refs.prevPageBtn.disabled = currentPage <= 1;
  refs.nextPageBtn.disabled = currentPage >= totalPages;
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
                <strong>Recordatorio: ${escHtml(c.name)}</strong>
                <p>${escHtml(c.note)}</p>
            </div>
            <div class="reminder-actions">
                <button onclick="dialManual('${escHtml(c.phone)}', '${escHtml(c.name)}')">📞</button>
                <button onclick="dismissReminder('${escHtml(c.id)}')">✕</button>
            </div>
        `;
        refs.reminderFloatContainer.appendChild(div);
    });
}

window.dismissReminder = (id) => {
    Contacts.dismissedReminderIds[id] = true;
    Contacts.saveDismissedReminders();
    renderReminderFloat();
};

function syncAudioButtons() {
  if (refs.muteBtnEl) {
    refs.muteBtnEl.textContent = micEnabled ? "🎙️ Micrófono" : "🔇 Micrófono";
    refs.muteBtnEl.classList.toggle("btn-audio-active", micEnabled);
  }
  if (refs.speakerBtnEl) {
    refs.speakerBtnEl.textContent = speakerEnabled ? "🔊 Altavoz activo" : "🔈 Altavoz";
    refs.speakerBtnEl.classList.toggle("btn-audio-active", speakerEnabled);
  }
  if (refs.micBadgeEl) {
    refs.micBadgeEl.textContent = micEnabled ? "🎙️ Mic activo" : "🔇 Mic apagado";
    refs.micBadgeEl.classList.toggle("is-active", micEnabled);
    refs.micBadgeEl.classList.toggle("muted", !micEnabled);
  }
}

function saveSessionCode(code, token = dashboardToken) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return;
  localStorage.setItem(DASHBOARD_SESSION_KEY, normalized);
  if (token) localStorage.setItem(`${DASHBOARD_TOKEN_PREFIX}${normalized}`, String(token));
}

function getSavedSessionCode() {
  return String(localStorage.getItem(DASHBOARD_SESSION_KEY) || "").trim().toUpperCase();
}

function getSavedDashboardToken(code) {
  const normalized = String(code || "").trim().toUpperCase();
  return normalized ? String(localStorage.getItem(`${DASHBOARD_TOKEN_PREFIX}${normalized}`) || "").trim() : "";
}

function getCampaignContactMap() {
  return new Map((campaignState?.contacts || []).map((contact) => [contact.id, contact]));
}

function getActiveCampaignContact() {
  if (!campaignState?.activeContactId) return null;
  return getCampaignContactMap().get(campaignState.activeContactId) || null;
}

function campaignCounter(label, value, tone = "") {
  return `<div class="campaign-counter ${tone}"><span>${escHtml(label)}</span><strong>${value}</strong></div>`;
}

function renderWorkersPanelLegacy() {
  const workers = Array.isArray(latestSessionState?.phoneWorkers) ? latestSessionState.phoneWorkers : [];
  const connected = workers.filter((worker) => worker?.connected);
  if (refs.workersSummaryEl) refs.workersSummaryEl.textContent = `${connected.length} conectados`;
  if (!refs.workersListEl) return;

  if (!connected.length) {
    refs.workersListEl.innerHTML = `<div class="campaign-list-empty">Sin workers conectados.</div>`;
    return;
  }

  refs.workersListEl.innerHTML = connected.map((worker) => `
    <div class="worker-chip ${worker.active ? "is-active" : ""}">
      <strong>${escHtml(worker.name || "Android")}</strong>
      <span>${escHtml(worker.id || "worker")}</span>
      <small>${escHtml(worker.callState || "idle")}</small>
    </div>
  `).join("");
}

function workerStateLabel(worker) {
  if (!worker.connected) return "Desconectado";
  if (worker.paused) return "Pausado";
  const labels = {
    idle: "Disponible",
    ended: "Disponible",
    failed: "Error",
    dialing: "Llamando",
    ringing: "Sonando",
    in_call: "En llamada"
  };
  return labels[worker.callState] || worker.callState || "Disponible";
}

function formatSeconds(value) {
  const total = Math.max(0, Number(value || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderWorkersPanel() {
  const workers = Array.isArray(latestSessionState?.phoneWorkers) ? latestSessionState.phoneWorkers : [];
  const connected = workers.filter((worker) => worker?.connected);
  if (refs.workersSummaryEl) refs.workersSummaryEl.textContent = `${connected.length} conectados`;
  if (!refs.workersListEl) return;
  if (!workers.length) {
    refs.workersListEl.innerHTML = `<div class="campaign-list-empty">Sin teléfonos vinculados.</div>`;
    return;
  }

  refs.workersListEl.innerHTML = workers.map((worker) => {
    const busy = ["dialing", "ringing", "in_call"].includes(worker.callState);
    const stateClass = worker.paused ? "is-paused" : busy ? "is-busy" : worker.connected ? "is-ready" : "is-offline";
    return `
      <article class="worker-card ${stateClass}" data-worker-id="${escHtml(worker.id)}">
        <div class="worker-card-head">
          <div><strong>${escHtml(worker.name || "Android")}</strong><small>${escHtml(worker.lineLabel || worker.id || "Teléfono")}</small></div>
          <span class="worker-state">${escHtml(workerStateLabel(worker))}</span>
        </div>
        ${busy ? `
          <div class="worker-contact"><strong>${escHtml(worker.companyName || "Contacto")}</strong><span>${escHtml(worker.phoneNumber || "-")}</span></div>
          <div class="worker-duration">${formatSeconds(worker.answeredAt ? Math.floor((Date.now() - Date.parse(worker.answeredAt)) / 1000) : (worker.durationSeconds || 0))}</div>
        ` : `<div class="worker-empty">${worker.paused ? "No recibirá nuevas llamadas" : "Esperando asignación"}</div>`}
        <div class="worker-actions">
          <button class="secondary" data-worker-action="pause" data-worker-id="${escHtml(worker.id)}">${worker.paused ? "Reanudar" : "Pausar"}</button>
          <button class="danger-soft" data-worker-action="hangup" data-worker-id="${escHtml(worker.id)}" ${busy ? "" : "disabled"}>Colgar</button>
          <button class="worker-disconnect-btn" data-worker-action="disconnect" data-worker-id="${escHtml(worker.id)}">Cerrar sesión</button>
        </div>
      </article>`;
  }).join("");

  refs.workersListEl.querySelectorAll("[data-worker-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const workerId = button.dataset.workerId;
      const worker = workers.find((item) => item.id === workerId);
      if (button.dataset.workerAction === "pause") await setWorkerPause(workerId, !worker?.paused);
      if (button.dataset.workerAction === "hangup") await hangupWorker(workerId);
      if (button.dataset.workerAction === "disconnect") await disconnectWorker(workerId, worker?.name);
    });
  });
}

function renderCampaignPanel() {
  syncTurnPendingContacts();
  renderTurnPendingContacts();
  renderShiftManagement();
  renderWorkersPanel();
  renderCampaignReport();
  renderAssignedListsPanel();
  const campaignStatus = String(campaignState?.status || "idle");
  const assignmentsCount = Object.keys(campaignState?.assignments || {}).length;
  const availableLists = Contacts.lists.filter((name) =>
    Contacts.contacts.some((contact) => (contact.list || "Principal") === name && normalizeValidPeruPhone(contact.phone))
  );
  const availableWorkers = (latestSessionState?.phoneWorkers || []).filter((worker) => worker.connected && !worker.paused).length;
  if (refs.campaignStartBtn) {
    const campaignBusy = campaignStatus === "running" || assignmentsCount > 0;
    refs.campaignStartBtn.disabled = campaignBusy || !availableLists.length || !availableWorkers;
    refs.campaignStartBtn.title = !availableLists.length
      ? "Importa una lista de contactos primero."
      : !availableWorkers ? "Vincula al menos un telefono." : campaignBusy ? "Deten o completa la campana actual antes de iniciar otra." : "";
  }
  if (refs.campaignStartBtn) refs.campaignStartBtn.textContent = "▶ Iniciar llamada general";
  if (refs.pendingTurnCallBtn) {
    const pendingCount = loadTurnPendingContacts().length;
    const campaignBusy = campaignStatus === "running" || assignmentsCount > 0;
    refs.pendingTurnCallBtn.disabled = !pendingCount || campaignBusy || !availableWorkers;
    refs.pendingTurnCallBtn.title = !pendingCount
      ? "No hay números que hayan agotado sus intentos."
      : !availableWorkers ? "No hay equipos disponibles." : campaignBusy ? "Espera a que termine la campaña actual." : "";
  }
  const counts = campaignState?.counts || {};
  const active = getActiveCampaignContact();
  const callbacks = campaignState?.callbacks || [];
  const pendingCallbacks = callbacks.filter(c => c.status === "pending").length;

  if (refs.callbacksSummaryEl) {
    refs.callbacksSummaryEl.textContent = `${pendingCallbacks} pendientes`;
  }

  if (refs.campaignStatusLineEl) {
    const status = String(campaignState?.status || "idle");
    const labelMap = {
      idle: "Sin campaña activa.",
      running: "Campaña corriendo.",
      paused: "Campaña pausada.",
      completed: "Campaña completada."
    };
    refs.campaignStatusLineEl.textContent = labelMap[status] || `Campaña ${status}`;
  }

  if (refs.campaignCountersEl) {
    refs.campaignCountersEl.innerHTML = [
      campaignCounter("Pendientes", counts.pending || 0),
      campaignCounter("Reintentos", counts.retry_pending || 0, "accent"),
      campaignCounter("Llamando", (counts.dialing || 0) + (counts.ringing || 0), "warn"),
      campaignCounter("En llamada", counts.in_call || 0, "ok"),
      campaignCounter("Callbacks", counts.awaiting_callback || 0, "accent"),
      campaignCounter("Completados", counts.completed || 0, "ok"),
      campaignCounter("Fallidos", counts.failed || 0, "danger")
    ].join("");
  }

  if (refs.campaignActiveCardEl) {
    refs.campaignActiveCardEl.innerHTML = active
      ? `
        <div class="campaign-active-card">
          <strong>${escHtml(active.name)}</strong>
          <span>${escHtml(active.phone)}</span>
          <small>${escHtml(active.note || "Sin nota")}</small>
          <small>Intentos: ${active.attempts || 0}${active.assignedWorkerId ? ` · Worker: ${escHtml(active.assignedWorkerId)}` : ""}</small>
        </div>
      `
      : `<div class="campaign-list-empty">Sin contacto activo.</div>`;
  }

  const disableResult = !active;
  if (refs.campaignResultAgendaBtn) refs.campaignResultAgendaBtn.disabled = disableResult;
  if (refs.campaignResultNoBtn) refs.campaignResultNoBtn.disabled = disableResult;
  if (refs.campaignResultAdvisorBtn) refs.campaignResultAdvisorBtn.disabled = disableResult;
  if (refs.campaignResultRetryBtn) refs.campaignResultRetryBtn.disabled = disableResult;
  if (refs.campaignPauseBtn) refs.campaignPauseBtn.disabled = campaignState?.status !== "running";
  if (refs.campaignResumeBtn) refs.campaignResumeBtn.disabled = !["paused", "idle"].includes(String(campaignState?.status || "idle"));
  if (refs.campaignSkipBtn) refs.campaignSkipBtn.disabled = disableResult;
  if (refs.campaignStopBtn) refs.campaignStopBtn.style.display = ["running", "paused"].includes(campaignStatus) || assignmentsCount ? "" : "none";
  if (refs.campaignPauseBtn) refs.campaignPauseBtn.style.display = campaignStatus === "running" ? "" : "none";
  if (refs.campaignResumeBtn) refs.campaignResumeBtn.style.display = campaignStatus === "paused" ? "" : "none";
  if (refs.campaignSkipBtn) refs.campaignSkipBtn.style.display = active ? "" : "none";

  if (refs.callbacksListEl) {
    refs.callbacksListEl.innerHTML = callbacks.length
      ? callbacks.map((item) => `
          <div class="callback-item ${item.status === "completed" ? "is-completed" : ""}">
            <strong>${escHtml(item.name || "Contacto")}</strong>
            <span>${escHtml(item.phone || "-")}</span>
            <small>${escHtml(item.reason || "Sin motivo")}</small>
            <small>${escHtml(item.advisor ? `Asesor: ${item.advisor}` : "Asesor sin asignar")}</small>
          </div>
        `).join("")
      : `<div class="campaign-list-empty">Sin callbacks pendientes.</div>`;
  }
}

async function fetchCampaignState(code = sessionCode) {
  if (!code) return;
  try {
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(code)}/campaign`, {
      headers: { "X-Dashboard-Token": dashboardToken }
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return;
    campaignState = data.campaign || null;
    renderCampaignPanel();
  } catch (error) {
    console.error("Campaign state fetch error:", error);
  }
}

async function postCampaignAction(path, body = {}) {
  if (!sessionCode) {
    setStatus("Espera a que cargue tu espacio de trabajo.", true);
    return null;
  }

  try {
    if (/\/(start|resume|dispatch|start-independent|call-contact|continue|switch-list)$/.test(path)) await Contacts.flushDatabase();
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(sessionCode)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Token": dashboardToken },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setStatus(data.error || "No se pudo ejecutar la acción de campaña.", true);
      return null;
    }
    campaignState = data.campaign || campaignState;
    renderCampaignPanel();
    return data;
  } catch (error) {
    console.error("Campaign action error:", error);
    setStatus(error.message || "No se pudo comunicar la acción de campaña.", true);
    return null;
  }
}

async function setWorkerPause(workerId, paused) {
  const data = await postCampaignAction(`/workers/${encodeURIComponent(workerId)}/pause`, { paused });
  if (data) setStatus(paused ? "Teléfono pausado; no recibirá nuevas llamadas." : "Teléfono reanudado.", true);
}

async function hangupWorker(workerId) {
  const data = await postCampaignAction(`/workers/${encodeURIComponent(workerId)}/hangup`);
  if (data) setStatus("Orden de colgar enviada al teléfono.", true);
}

async function startIndependentWorker(workerId) {
  if (!workerId) return;
  const worker = (latestSessionState?.phoneWorkers || [])
    .find((item) => String(item.id) === String(workerId));
  if (!worker?.connected) {
    setStatus("Este teléfono está desconectado. Vincula el celular actual con el QR de este equipo antes de iniciar.", true);
    await loadPairingData(sessionCode);
    return;
  }
  const data = await postCampaignAction(`/workers/${encodeURIComponent(workerId)}/start-independent`);
  if (data) setStatus(data.dispatched ? "Llamada independiente iniciada." : "Este teléfono no tiene contactos pendientes.", true);
}

async function skipWorkerList(slotId, workerId, currentList) {
  if (!slotId || !workerId || !currentList) return;
  const assignments = getPairingListAssignments();
  const usedLists = new Set(assignments.map((item) => item.listName));
  const nextList = Contacts.lists.find((listName) =>
    listName !== currentList
    && !usedLists.has(listName)
    && Contacts.contacts.some((contact) =>
      (contact.list || "Principal") === listName
      && normalizeValidPeruPhone(contact.phone)
      && !["completed", "failed", "awaiting_callback"].includes(String(contact.campaignStatus || ""))
    )
  ) || "";
  if (!nextList) {
    setStatus("No hay otra lista libre con contactos pendientes.", true);
    return;
  }
  const accepted = await requestConfirmation({
    title: "Saltar lista",
    message: `¿Liberar "${currentList}" y asignar "${nextList}" a este equipo? Los contactos pendientes de la lista actual se conservarán.`,
    confirmLabel: "Saltar lista"
  });
  if (!accepted) return;
  if (Array.isArray(campaignState?.contacts) && campaignState.contacts.length) {
    const data = await postCampaignAction(`/workers/${encodeURIComponent(workerId)}/switch-list`, { currentList, nextList });
    if (!data) return;
  }
  const storageKey = `${PAIRING_LIST_ASSIGNMENTS_PREFIX}${sessionCode}`;
  let saved = {};
  try { saved = Contacts.getPreference("pairingListAssignments", {}); } catch { saved = {}; }
  saved[slotId] = nextList;
  Contacts.setPreference("pairingListAssignments", saved);
  setStatus(`Lista saltada. Ahora el equipo tiene asignada "${nextList}".`, true);
  await loadPairingData(sessionCode);
}

function getPairingListAssignments() {
  const listNames = Contacts.lists.filter((name) =>
    Contacts.contacts.some((contact) =>
      (contact.list || "Principal") === name && normalizeValidPeruPhone(contact.phone)
    )
  );
  const linkedSlots = pairingSlotsSnapshot.map((slot, slotIndex) => ({ slot, slotIndex }))
    .filter(({ slot }) => Boolean(slot?.deviceId));
  const linkedSlotIds = new Set(linkedSlots.map(({ slot }) => String(slot.id)));
  const campaignContacts = Array.isArray(campaignState?.contacts) ? campaignState.contacts : [];
  const completedLists = new Set(listNames.filter((listName) => {
    const contacts = campaignContacts.filter((contact) => String(contact.list || "Principal") === listName);
    return contacts.length > 0 && contacts.every((contact) =>
      ["completed", "failed", "awaiting_callback"].includes(String(contact.status || ""))
    );
  }));
  const validLists = new Set(listNames.filter((listName) => !completedLists.has(listName)));
  const storageKey = `${PAIRING_LIST_ASSIGNMENTS_PREFIX}${sessionCode}`;
  let saved = {};
  try { saved = Contacts.getPreference("pairingListAssignments", {}); } catch { saved = {}; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};

  const usedLists = new Set();
  for (const [slotId, listName] of Object.entries(saved)) {
    if (!linkedSlotIds.has(slotId) || !validLists.has(listName) || usedLists.has(listName)) {
      delete saved[slotId];
    } else {
      usedLists.add(listName);
    }
  }

  const unassignedSlots = linkedSlots
    .filter(({ slot }) => !saved[slot.id])
    .sort((a, b) => (Date.parse(a.slot.linkedAt || 0) || a.slotIndex) - (Date.parse(b.slot.linkedAt || 0) || b.slotIndex));
  for (const { slot } of unassignedSlots) {
    const nextList = listNames.find((listName) => !usedLists.has(listName));
    if (!nextList) break;
    saved[slot.id] = nextList;
    usedLists.add(nextList);
  }
  if (sessionCode) Contacts.setPreference("pairingListAssignments", saved);

  return listNames.flatMap((listName, assignmentIndex) => {
    const linked = linkedSlots.find(({ slot }) => saved[slot.id] === listName);
    return linked ? [{ ...linked, assignmentIndex, listName }] : [];
  });
}

function getPairingListAssignmentByName(listName) {
  return getPairingListAssignments().find((assignment) => assignment.listName === (listName || "Principal")) || null;
}

async function stopIndependentWorker(workerId) {
  if (!workerId) return;
  const data = await postCampaignAction(`/workers/${encodeURIComponent(workerId)}/stop-independent`);
  if (data) setStatus(`Llamada detenida${data.heldContact?.phone ? `: ${data.heldContact.phone}` : ""}. No consumió un intento.`, true);
}

async function callContactFromAssignedList(contactId, listName) {
  const slot = getPairingListAssignmentByName(listName)?.slot || null;
  if (!slot?.deviceId) {
    setStatus(`La lista "${listName || "Principal"}" no tiene un equipo vinculado.`, true);
    return;
  }
  const contact = Contacts.contacts.find((item) => item.id === contactId);
  const data = await postCampaignAction(`/workers/${encodeURIComponent(slot.deviceId)}/call-contact`, {
    contactId,
    contact: contact ? {
      id: contact.id,
      name: contact.name,
      phone: normalizeValidPeruPhone(contact.phone),
      note: contact.note || "",
      list: contact.list || "Principal",
      targetWorkerId: slot.deviceId
    } : null
  });
  if (data) setStatus("Llamada manual enviada al equipo asignado.", true);
}

async function hangupWorkerWithResult(workerId) {
  if (!workerId) return;
  const answered = await requestConfirmation({
    title: "Resultado de la llamada",
    message: "¿Contestó una persona? Pulsa Cancelar si no contestó o fue buzón de voz.",
    confirmLabel: "Sí contestó",
    cancelLabel: "No contestó / buzón"
  });
  const worker = (latestSessionState?.phoneWorkers || []).find((item) => item.id === workerId);
  if (worker?.activeContactId) {
    await postCampaignAction("/campaign/result", { contactId: worker.activeContactId, result: answered ? "contesto" : "sin_respuesta" });
  }
  await hangupWorker(workerId);
}

async function disconnectWorker(workerId, workerName = "este teléfono") {
  const accepted = window.confirm(`¿Desvincular ${workerName || "este teléfono"}?`);
  if (!accepted) return;
  const data = await postCampaignAction(`/workers/${encodeURIComponent(workerId)}/disconnect`);
  if (data) setStatus("Teléfono desvinculado correctamente.", true);
}

async function stopCampaignRun() {
  const data = await postCampaignAction("/campaign/stop");
  if (data) setStatus("Campaña detenida. El historial se conservó.", true);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function downloadCampaignReport() {
  if (!await loadUnifiedReportRows()) return;
  const reportRows = getVisibleReportRows();
  if (!reportRows.length) {
    setStatus("Aún no hay intentos para exportar.", true);
    return;
  }
  const shift = currentShiftSnapshot()?.current || currentShiftSnapshot()?.detected || {};
  const selectedShift = reportShiftId ? reportRows[0]?.shiftLabel || "Turno seleccionado" : "Todos los turnos";
  const pdf = await buildCallReportPdf("Historial de llamadas", reportRows, {
    ...shift, label: selectedShift, date: reportPeriodLabel(reportPeriod), schedule: ""
  });
  const blob = new Blob([pdf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `reporte_llamadas_${reportPeriod.from ? reportPeriod.from + "_a_" + reportPeriod.to : "todo_el_historial"}.pdf`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`Reporte PDF generado con ${reportRows.length} llamada${reportRows.length === 1 ? "" : "s"}.`, true);
}

function mapCampaignReportRow(item, fallbackList = "") {
  const workerId = String(item.workerId || "").trim();
  const workerName = String(item.workerName || item.worker || workerId || "").trim();
  return {
    reportDate: item.reportDate || reportDateKey(item.startedAt),
    shiftId: item.shiftId || ((Date.parse(item.startedAt) || 0) >= (Date.parse(currentShiftSnapshot()?.current?.startedAt) || Infinity) ? currentShiftSnapshot()?.current?.id || "" : ""),
    shiftLabel: item.shiftLabel || "",
    attemptId: item.attemptId || "",
    contactId: item.contactId || "",
    list: item.list || fallbackList || "",
    name: item.name || "",
    phone: item.phone || "",
    workerId,
    workerName,
    worker: workerName || workerId,
    attemptNumber: Number(item.attemptNumber || 0),
    startedAt: item.startedAt || "",
    answeredAt: item.answeredAt || "",
    endedAt: item.endedAt || "",
    waitingSeconds: Number(item.waitingSeconds ?? (item.startedAt && (item.answeredAt || item.endedAt)
      ? Math.max(0, Math.round((Date.parse(item.answeredAt || item.endedAt) - Date.parse(item.startedAt)) / 1000)) : 0)),
    totalSeconds: Number(item.totalSeconds ?? (item.startedAt && item.endedAt
      ? Math.max(0, Math.round((Date.parse(item.endedAt) - Date.parse(item.startedAt)) / 1000)) : 0)),
    durationSeconds: Number(item.durationSeconds || 0),
    technicalResult: item.technicalResult || "",
    disposition: item.disposition || ""
  };
}

function reportWorkerKey(row) {
  return String(row?.workerId || row?.worker || "Sin equipo").trim() || "Sin equipo";
}

function reportWorkerLabel(row) {
  return String(row?.workerName || row?.worker || row?.workerId || "Sin equipo").trim() || "Sin equipo";
}


function reportDateKey(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}

function getUnifiedReportRows() {
  const rows = new Map();
  for (const row of [...(reportCacheSession === sessionCode ? reportRowsCache : []), ...getCampaignReportRows()]) {
    const key = row.attemptId || [row.contactId, row.phone, row.workerId, row.attemptNumber, row.startedAt].join("|");
    const previous = rows.get(key);
    rows.set(key, { ...previous, ...row,
      shiftId: row.shiftId || previous?.shiftId || "",
      shiftLabel: row.shiftLabel || previous?.shiftLabel || ""
    });
  }
  return [...rows.values()].sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
}

function getVisibleReportRows() {
  const query = String(refs.campaignReportFilterEl?.value || "").trim().toLocaleLowerCase("es");
  return getUnifiedReportRows().filter(row =>
    isInReportPeriod(row.reportDate, reportPeriod) &&
    (!reportShiftId || row.shiftId === reportShiftId) &&
    (!reportListFilter || String(row.list || "") === reportListFilter) &&
    (!reportWorkerFilter || reportWorkerKey(row) === reportWorkerFilter) &&
    (!reportResultFilter || String(row.disposition || row.technicalResult || "") === reportResultFilter) &&
    (!query || [row.name, row.phone, row.list, row.worker,
      reportResultLabel(row.technicalResult), reportResultLabel(row.disposition)]
      .some(value => String(value || "").toLocaleLowerCase("es").includes(query))));
}

async function loadUnifiedReportRows() {
  const status = document.getElementById("reportsLoadStatus");
  if (!sessionCode || !dashboardToken) {
    if (status) status.textContent = "Espera a que cargue tu historial.";
    return false;
  }
  const code = sessionCode;
  const request = ++reportRequestSerial;
  if (reportCacheSession !== code) {
    reportRowsCache = [];
    reportCacheSession = code;
  }
  if (status) status.textContent = "Cargando historial…";
  try {
    const response = await fetch(API_BASE + "/api/session/" + encodeURIComponent(code) + "/reports/attempts", {
      headers: { "X-Dashboard-Token": dashboardToken }
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo cargar el historial");
    if (sessionCode !== code || request !== reportRequestSerial) return false;
    reportRowsCache = (data.rows || []).map(item => mapCampaignReportRow(item));
    if (status) status.textContent = "";
    renderCampaignReport();
    document.dispatchEvent(new CustomEvent("reports:data", { detail: { rows: getUnifiedReportRows() } }));
    return true;
  } catch (error) {
    if (sessionCode === code && request === reportRequestSerial && status) {
      status.textContent = "No se pudo cargar el historial completo. Vuelve a abrir Reportes para reintentar.";
    }
    return false;
  }
}

function getCampaignReportRows() {
  const sources = [campaignState?.turn?.currentReport, campaignState?.history];
  const rows = new Map();
  for (const source of sources) {
    for (const item of Array.isArray(source) ? source : []) {
      const key = item.attemptId || [item.contactId, item.workerId, item.attemptNumber, item.startedAt].join("|");
      rows.set(key, mapCampaignReportRow(item, campaignState?.listName || ""));
    }
  }
  return [...rows.values()].sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
}

async function getAllCampaignReportRows() {
  const rows = [];
  // Combina todas las fuentes disponibles. Esto evita perder las llamadas de un
  // equipo cuando el snapshot del turno llega unos instantes antes que el
  // historial más reciente de la campaña.
  const reportSources = [
    campaignState?.turn?.currentReport,
    latestSessionState?.shiftManagement?.currentReport,
    campaignState?.history,
    latestSessionState?.campaign?.history
  ];
  reportSources.forEach((source) => {
    if (!Array.isArray(source)) return;
    for (const item of source) rows.push(mapCampaignReportRow(item, campaignState?.listName || ""));
  });
  const unique = new Map();
  rows.forEach((row, index) => {
    const key = row.attemptId || [row.list, row.phone, reportWorkerKey(row), row.attemptNumber, row.startedAt, row.endedAt, index].join("|");
    unique.set(key, row);
  });
  const currentTurn = campaignState?.turn?.current || latestSessionState?.shiftManagement?.current;
  const turnStart = Date.parse(currentTurn?.startedAt || "") || 0;
  return [...unique.values()].filter((row) => !turnStart || (Date.parse(row.startedAt || "") || 0) >= turnStart).sort((left, right) => {
    const workerOrder = reportWorkerKey(left).localeCompare(reportWorkerKey(right), "es", {
      sensitivity: "base",
      numeric: true
    });
    if (workerOrder !== 0) return workerOrder;
    const leftAnswered = Boolean(left.answeredAt || left.technicalResult === "contesto");
    const rightAnswered = Boolean(right.answeredAt || right.technicalResult === "contesto");
    if (leftAnswered !== rightAnswered) return leftAnswered ? -1 : 1;
    const leftTime = new Date(left.startedAt || 0).getTime() || 0;
    const rightTime = new Date(right.startedAt || 0).getTime() || 0;
    return leftTime - rightTime;
  });
}

function formatLimaReportDate(value, compact = false) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("es-PE", compact
    ? { timeZone: "America/Lima", year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
    : { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
  ).format(date).replace(",", "");
}

function formatReportDate(value) {
  return value ? `${formatLimaReportDate(value)} (Lima)` : "—";
}

function reportResultLabel(value) {
  const labels = {
    buzon_de_voz: "Buzón de voz",
    sin_servicio: "Sin servicio",
    numero_inexistente: "NO VOLVER A LLAMAR · Número inexistente o incorrecto",
    numero_llamado_anteriormente: "Número llamado anteriormente",
    no_disponible: "No disponible",
    contesto: "Conectada",
    sin_respuesta: "Sin respuesta",
    no_contactado: "No contactado",
    reintentar: "Reintentar",
    no_interesado: "Sin interés",
    interesado: "Interesado",
    agendado: "Agendado",
    requiere_asesor: "Requiere asesor",
    numero_incorrecto: "Número incorrecto"
  };
  return labels[value] || String(value || "—").replaceAll("_", " ");
}

function reportResultClass(value) {
  const normalized = String(value || "empty").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `result-${normalized}`;
}

function renderCampaignReport() {
  if (!refs.campaignReportBodyEl) return;
  const query = String(refs.campaignReportFilterEl?.value || "").trim().toLocaleLowerCase("es");
  const shiftSelect = document.getElementById("reportShiftFilter");
  const periodRows = getUnifiedReportRows().filter(row => isInReportPeriod(row.reportDate, reportPeriod));
  const shifts = new Map(periodRows
    .filter(row => row.shiftId)
    .map(row => [row.shiftId, row.shiftLabel || "Turno"]));
  if (reportShiftId && !shifts.has(reportShiftId)) reportShiftId = "";
  if (shiftSelect) {
    const options = '<option value="">Todos los turnos</option>' + [...shifts].map(([id, label]) =>
      '<option value="' + escHtml(id) + '">' + escHtml(label) + '</option>').join("");
    if (shiftSelect.innerHTML !== options) shiftSelect.innerHTML = options;
    shiftSelect.value = reportShiftId;
  }
  const fillSelect = (id, allLabel, values, current) => {
    const select = document.getElementById(id);
    if (!select) return;
    const options = '<option value="">' + allLabel + '</option>' + [...values].sort((a, b) => a.localeCompare(b, "es")).map(value =>
      '<option value="' + escHtml(value) + '">' + escHtml(value) + '</option>').join("");
    if (select.innerHTML !== options) select.innerHTML = options;
    select.value = current;
  };
  const lists = new Set(periodRows.map(row => String(row.list || "").trim()).filter(Boolean));
  if (reportListFilter && !lists.has(reportListFilter)) reportListFilter = "";
  fillSelect("reportListFilter", "Todas las listas", lists, reportListFilter);
  const workers = new Set(periodRows.map(row => reportWorkerKey(row)).filter(key => key !== "Sin equipo"));
  if (reportWorkerFilter && !workers.has(reportWorkerFilter)) reportWorkerFilter = "";
  fillSelect("reportWorkerFilter", "Todos los equipos", workers, reportWorkerFilter);
  const results = new Map();
  for (const row of periodRows) {
    const value = String(row.disposition || row.technicalResult || "").trim();
    if (value) results.set(value, reportResultLabel(value));
  }
  if (reportResultFilter && !results.has(reportResultFilter)) reportResultFilter = "";
  const resultSelect = document.getElementById("reportResultFilter");
  if (resultSelect) {
    const options = '<option value="">Todos los resultados</option>' + [...results].map(([value, label]) =>
      '<option value="' + escHtml(value) + '">' + escHtml(label) + '</option>').join("");
    if (resultSelect.innerHTML !== options) resultSelect.innerHTML = options;
    resultSelect.value = reportResultFilter;
  }
  const rows = getVisibleReportRows();
  if (refs.campaignReportBtn) refs.campaignReportBtn.disabled = !rows.length;
  if (refs.campaignReportCountEl) {
    refs.campaignReportCountEl.textContent = `${rows.length} ${rows.length === 1 ? "registro" : "registros"}`;
  }
  if (refs.campaignReportEmptyEl) {
    refs.campaignReportEmptyEl.style.display = rows.length ? "none" : "block";
    refs.campaignReportEmptyEl.textContent = query
      ? "No hay llamadas que coincidan con tu búsqueda."
      : reportPeriod.from || reportShiftId || reportListFilter || reportWorkerFilter || reportResultFilter ? "No hay llamadas con estos filtros. Prueba otras fechas, turnos o listas." : "Todavía no hay llamadas registradas.";
  }
  const reportTable = document.getElementById("campaignReportTableWrap");
  if (reportTable) reportTable.hidden = !rows.length;
  refs.campaignReportBodyEl.innerHTML = [...rows].reverse().map((item) => `
    <tr class="campaign-report-row ${reportResultClass(item.disposition || item.technicalResult)}">
      <td>${escHtml(item.list || "—")}</td>
      <td><strong>${escHtml(item.name || "—")}</strong></td>
      <td class="campaign-report-phone">${escHtml(item.phone || "—")}</td>
      <td>${escHtml(item.worker || "—")}</td>
      <td>${item.attemptNumber || "—"}</td>
      <td>${escHtml(formatReportDate(item.startedAt))}</td>
      <td>${escHtml(formatReportDate(item.answeredAt))}</td>
      <td>${escHtml(formatReportDate(item.endedAt))}</td>
      <td>${escHtml(formatCallDuration(item.waitingSeconds))}</td>
      <td>${escHtml(formatCallDuration(item.durationSeconds))}</td>
      <td>${escHtml(formatCallDuration(item.totalSeconds))}</td>
      <td><span class="campaign-report-result technical ${reportResultClass(item.technicalResult)}">${escHtml(reportResultLabel(item.technicalResult))}</span></td>
      <td><span class="campaign-report-result commercial ${reportResultClass(item.disposition)}">${escHtml(reportResultLabel(item.disposition))}</span></td>
      <td><button type="button" class="secondary" data-report-attempt="${escHtml(item.attemptId)}">Volver a llamar</button></td>
    </tr>
  `).join("");
}

async function saveVoiceAgentConfig(enabled) {
  void enabled;
  setStatus("Agente de voz desactivado por ahora.");
  return null;
}

async function startCampaignRunLegacy() {
  if (!Contacts.contacts.length) {
    setStatus("Importa o agrega contactos antes de iniciar la campaña.", true);
    return;
  }
  const data = await postCampaignAction("/campaign/start", {
    contacts: Contacts.contacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      note: contact.note || ""
    }))
  });
  if (data) setStatus("Campaña iniciada.", true);
}

async function startCampaignRun() {
  const eligibleForGeneral = (contact) => !["completed", "failed", "awaiting_callback"].includes(String(contact.campaignStatus || ""))
    && contact.technicalResult !== "no_contactado";
  const orderedLists = Contacts.lists.filter((name) => Contacts.contacts.some((contact) =>
    (contact.list || "Principal") === name && normalizeValidPeruPhone(contact.phone)
  ));
  const listAssignments = getPairingListAssignments();
  const workerByList = new Map(listAssignments.map(({ listName, slot }) => [listName, slot.deviceId]));
  const assignedListNames = new Set(workerByList.keys());
  const selectedContacts = Contacts.contacts.filter((contact) =>
    normalizeValidPeruPhone(contact.phone) && eligibleForGeneral(contact)
  );
  const listName = "Asignación automática";
  if (!selectedContacts.length) {
    setStatus(`La lista ${listName} no tiene contactos.`, true);
    return;
  }
  const connectedCount = (latestSessionState?.phoneWorkers || []).filter((worker) => worker.connected && !worker.paused).length;
  if (!connectedCount) {
    setStatus("Vincula al menos un teléfono disponible antes de iniciar.", true);
    return;
  }
  const data = await postCampaignAction("/campaign/start", {
    listName,
    maxAttempts: 2,
    contacts: selectedContacts.map((contact) => ({
      id: contact.id,
      name: contact.name,
      phone: normalizeValidPeruPhone(contact.phone),
      note: contact.note || "",
      list: contact.list || "Principal",
      targetWorkerId: assignedListNames.has(contact.list || "Principal")
        ? (workerByList.get(contact.list || "Principal") || "")
        : ""
    }))
  });
  if (data) {
    const dispatched = Number(data.dispatched || 0);
    if (!dispatched) {
      setStatus("La campaña se preparó, pero ningún equipo estaba disponible para recibir la primera llamada. Revisa el estado de los equipos e inténtalo nuevamente.", true);
      return;
    }
    setStatus(`Llamada general iniciada: ${selectedContacts.length} contactos y ${dispatched} llamadas enviadas.`, true);
  }
}

async function startPendingTurnRun() {
  const pending = loadTurnPendingContacts().filter((contact) =>
    String(contact.status || "pending_next_shift") !== "exhausted"
    && Number(contact.recoveryAttempts || 0) < 2
  );
  if (!pending.length) {
    setStatus("No hay números pendientes del turno.", true);
    return;
  }
  const workers = Array.isArray(latestSessionState?.phoneWorkers) ? latestSessionState.phoneWorkers : [];
  const firstAvailableSlot = pairingSlotsSnapshot.find((slot) => {
    if (!slot.deviceId) return false;
    const worker = workers.find((item) => String(item.id) === String(slot.deviceId));
    return worker?.connected && !worker.paused
      && ["idle", "failed", "available"].includes(String(worker.callState || "idle"));
  });
  const fallbackWorker = workers.find((worker) => worker.connected && !worker.paused
    && ["idle", "failed", "available"].includes(String(worker.callState || "idle")));
  const workerId = firstAvailableSlot?.deviceId || fallbackWorker?.id || "";
  if (!workerId) {
    setStatus("No hay ningún equipo disponible para llamar los pendientes.", true);
    return;
  }
  const data = await postCampaignAction("/campaign/start", {
    listName: "Pendientes del turno",
    maxAttempts: 2,
    contacts: pending.map((contact, index) => ({
      id: `turn-pending-${Date.now()}-${index}`,
      name: contact.name,
      phone: normalizeValidPeruPhone(contact.phone),
      list: contact.list || "Principal",
      targetWorkerId: workerId
    }))
  });
  if (data) {
    pendingRecoveryRunning = true;
    normalCampaignResumeRequested = false;
    setStatus(`Llamando ${pending.length} número${pending.length === 1 ? "" : "s"} pendiente${pending.length === 1 ? "" : "s"} desde el primer equipo disponible.`, true);
  }
}

async function finalizeWorkTurn() {
  const snapshot = currentShiftSnapshot();
  if (!snapshot?.current) {
    setStatus("No hay un turno activo para finalizar.", true);
    return;
  }
  const accepted = await requestConfirmation({
    title: "Finalizar turno",
    message: `Se archivará ${snapshot.current.label || "el turno"}, se detendrán las llamadas y se desvincularán todos los equipos. Los pendientes se conservarán para el siguiente turno.`,
    confirmLabel: "Finalizar turno"
  });
  if (!accepted) return;
  const data = await postCampaignAction("/turn/finalize");
  if (!data) return;
  const finalizedRows = Array.isArray(data.finalizedTurn?.report)
    ? data.finalizedTurn.report.map((item) => mapCampaignReportRow(item))
    : [];
  if (finalizedRows.length) {
    try {
      const pdf = await buildCallReportPdf(data.finalizedTurn.label || "Turno finalizado", finalizedRows, data.finalizedTurn);
      const blob = new Blob([pdf], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `reporte_final_${data.finalizedTurn.type || "turno"}_${data.finalizedTurn.date || new Date().toISOString().slice(0, 10)}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error("No se pudo descargar el reporte final:", error);
      setStatus("El turno se cerró, pero el PDF no pudo descargarse. El reporte quedó archivado para recuperarlo.", true);
    }
  }
  campaignState = data.campaign || campaignState;
  await loadPairingData(sessionCode);
  renderCampaignPanel();
  setStatus("Turno finalizado. Reporte archivado y pendientes conservados.", true);
}

async function finalizeOperationalSession() {
  const accepted = await requestConfirmation({
    title: "Desvincular todos los equipos",
    message: "Se colgarán las llamadas, se desvincularán los teléfonos y se generarán nuevos códigos QR. El turno, sus listas, avance, pendientes y reportes se conservarán.",
    confirmLabel: "Desvincular equipos"
  });
  if (!accepted) return;
  const data = await postCampaignAction("/session/finalize");
  if (!data) return;
  campaignState = data.campaign || campaignState;
  pairingStateSignature = "";
  await loadPairingData(sessionCode);
  renderCampaignPanel();
  setStatus("Equipos desvinculados. Tu cuenta, bases e historial se conservan.", true);
}

async function pauseCampaignRun() {
  const data = await postCampaignAction("/campaign/pause");
  if (data) setStatus("Campaña pausada.", true);
}

async function resumeCampaignRun() {
  const data = await postCampaignAction("/campaign/resume");
  if (data) setStatus("Campaña reanudada.", true);
}

async function skipCampaignContact() {
  const data = await postCampaignAction("/campaign/skip");
  if (data) setStatus("Contacto saltado y marcado para reintento.", true);
}

async function markCampaignResult(result) {
  const active = getActiveCampaignContact();
  if (!active) {
    setStatus("No hay contacto activo en campaña.", true);
    return;
  }

  const payload = { contactId: active.id, result };
  if (result === "requiere_asesor") {
    const callbackReason = await requestListName({
      title: "Derivar a un asesor",
      label: "Motivo de derivación",
      placeholder: "Ej. Solicita información comercial",
      defaultValue: active.callbackReason || "Solicitó asesor"
    });
    if (!callbackReason) return;
    const assignedAdvisor = await requestListName({
      title: "Asignar asesor",
      label: "Nombre del asesor",
      placeholder: "Ej. Alonso",
      defaultValue: active.assignedAdvisor || "Sin asignar"
    });
    if (assignedAdvisor === null) return;
    payload.callbackReason = callbackReason;
    payload.assignedAdvisor = assignedAdvisor === "Sin asignar" ? "" : assignedAdvisor;
  }

  const data = await postCampaignAction("/campaign/result", payload);
  if (!data) return;

  const labels = {
    agendado: "Contacto marcado como agendado.",
    no_interesado: "Contacto marcado como no interesado.",
    requiere_asesor: "Contacto derivado a callback.",
    reintentar: "Contacto marcado para reintento."
  };
  setStatus(labels[result] || "Resultado de campaña actualizado.", true);
}

async function markContactDisposition(contactId, result) {
  const data = await postCampaignAction("/campaign/result", { contactId, result });
  if (data) setStatus("Resultado comercial actualizado.", true);
}

function restoreSavedSession() {
  if (restoreAttempted) return;
  restoreAttempted = true;
  requestAutomaticSession();
}

function requestAutomaticSession() {
  if (autoSessionRequested || !socket.connected) return;
  autoSessionRequested = true;
  setStatus("Cargando tu espacio de trabajo...");
  // MySQL selects the same account workspace on every browser. The old code
  // is only a migration hint; the server checks ownership before using it.
  socket.emit("workspace:open", { dashboardClientId, previousCode: getSavedSessionCode() });
}

// ── EVENT BINDING ────────────────────────────────────────────────────
function bindEvents() {
  document.addEventListener("reports:open", loadUnifiedReportRows);
  document.addEventListener("reports:filter", event => {
    const nextPeriod = { from: event.detail?.from || "", to: event.detail?.to || "" };
    if (validateReportPeriod(nextPeriod.from, nextPeriod.to)) return;
    reportPeriod = nextPeriod;
    reportShiftId = "";
    reportListFilter = "";
    reportWorkerFilter = "";
    reportResultFilter = "";
    renderCampaignReport();
  });
  const shiftSelect = document.getElementById("reportShiftFilter");
  if (shiftSelect) shiftSelect.onchange = () => { reportShiftId = shiftSelect.value; renderCampaignReport(); };
  const listSelect = document.getElementById("reportListFilter");
  if (listSelect) listSelect.onchange = () => { reportListFilter = listSelect.value; renderCampaignReport(); };
  const workerSelect = document.getElementById("reportWorkerFilter");
  if (workerSelect) workerSelect.onchange = () => { reportWorkerFilter = workerSelect.value; renderCampaignReport(); };
  const resultSelect = document.getElementById("reportResultFilter");
  if (resultSelect) resultSelect.onchange = () => { reportResultFilter = resultSelect.value; renderCampaignReport(); };
  if (refs.campaignReportFilterEl) refs.campaignReportFilterEl.oninput = renderCampaignReport;
  if (refs.campaignReportBodyEl) refs.campaignReportBodyEl.onclick = async (event) => {
    const button = event.target.closest("button[data-report-attempt]");
    if (!button || button.disabled) return;
    const row = getUnifiedReportRows().find((item) => item.attemptId === button.dataset.reportAttempt);
    if (!row) return;
    const slot = getPairingListAssignmentByName(row.list)?.slot;
    const workerId = slot?.deviceId || row.workerId;
    if (!workerId) return setStatus("Vincula un equipo a esta lista para volver a llamar.", true);
    button.disabled = true;
    try {
      const data = await postCampaignAction(`/workers/${encodeURIComponent(workerId)}/call-contact`, {
        contactId: row.contactId,
        contact: { id: row.contactId, name: row.name, phone: row.phone, list: row.list }
      });
      if (data) setStatus("Rellamada enviada. El intento anterior permanece en el reporte.", true);
    } finally {
      button.disabled = false;
    }
  };
  if (refs.createBtn) refs.createBtn.onclick = () => requestAutomaticSession();
  if (refs.joinBtn) refs.joinBtn.onclick = () => {
    const code = refs.sessionCodeIn.value.trim().toUpperCase();
    if (code) {
      dashboardToken = getSavedDashboardToken(code);
      if (!dashboardToken) {
        setStatus("Recarga para recuperar el acceso de tu cuenta.", true);
        return;
      }
      socket.emit("session:join", { code, role: "dashboard", token: dashboardToken, dashboardClientId });
      loadPairingData(code);
    }
  };
  
  refs.cBodyEl.onclick = async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const contact = Contacts.contacts.find(c => c.id === id);
    if (!contact) return;
    
    if (action === "dial") startDialForContact(contact);
    if (action === "result-interested") markContactDisposition(id, "interesado");
    if (action === "result-no-interest") markContactDisposition(id, "no_interesado");
    if (action === "result-callback") markContactDisposition(id, "reintentar");
    if (action === "whatsapp") WhatsApp.openWhatsAppModal(contact);
    if (action === "whatsapp-direct") {
      const phone = normalizeValidPeruPhone(contact.phone);
      if (!phone) {
        setStatus("Este contacto no tiene un número peruano válido para WhatsApp.", true);
      } else {
        window.open(`https://wa.me/51${phone}`, "_blank", "noopener,noreferrer");
      }
    }
    if (action === "call-direct") await callContactFromAssignedList(contact.id, contact.list || "Principal");
    if (action === "edit") {
       openEditModal(contact);
    }
    if (action === "delete") {
      if (await requestConfirmation({ title: "Eliminar contacto", message: `¿Eliminar a ${contact.name}?`, confirmLabel: "Eliminar" })) {
        Contacts.deleteContact(id);
        renderContacts();
      }
    }
  };

  refs.hangupBtnEl.onclick = () => {
    emitCallActionWithAck("hangup");
    applyState("ended", callCtx?.phone || "");
  };

  refs.muteBtnEl.onclick = toggleMute;
  if (refs.addContactBtn) refs.addContactBtn.onclick = addManualContact;
  if (refs.openAddContactBtn) refs.openAddContactBtn.onclick = openAddContactModal;
  if (refs.floatingAddContactBtn) refs.floatingAddContactBtn.onclick = openAddContactModal;
  if (refs.addCloseBtn) refs.addCloseBtn.onclick = () => { refs.addContactModalEl.style.display = "none"; };
  if (refs.addSaveBtn) refs.addSaveBtn.onclick = saveModalContact;
  if (refs.addPhoneInput) refs.addPhoneInput.onkeydown = (event) => { if (event.key === "Enter") saveModalContact(); };
  if (refs.importFileEl) refs.importFileEl.onchange = (e) => handleImportFiles(e.target.files);
  if (refs.importUrlBtn) refs.importUrlBtn.onclick = handleImportUrl;
  if (refs.importConfirm) refs.importConfirm.onclick = addImportedContacts;
  if (refs.importCancel) refs.importCancel.onclick = resetImportPreview;
  if (refs.tabWord) refs.tabWord.onclick = () => {
    refs.tabWord.classList.add("active");
    refs.tabUrl.classList.remove("active");
    refs.panelWord.style.display = "block";
    refs.panelUrl.style.display = "none";
  };
  if (refs.tabUrl) refs.tabUrl.onclick = () => {
    refs.tabUrl.classList.add("active");
    refs.tabWord.classList.remove("active");
    refs.panelUrl.style.display = "block";
    refs.panelWord.style.display = "none";
  };
  if (refs.prevPageBtn) refs.prevPageBtn.onclick = () => {
    currentPage = Math.max(1, currentPage - 1);
    renderContacts();
  };
  if (refs.nextPageBtn) refs.nextPageBtn.onclick = () => {
    currentPage += 1;
    renderContacts();
  };
  if (refs.campaignStartBtn) refs.campaignStartBtn.onclick = startCampaignRun;
  if (refs.pendingTurnCallBtn) refs.pendingTurnCallBtn.onclick = startPendingTurnRun;
  if (refs.pendingTurnBodyEl) refs.pendingTurnBodyEl.onclick = async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const contact = Contacts.contacts.find((item) => item.id === button.dataset.id);
    if (!contact) return;
    if (button.dataset.action === "call-direct") {
      await callContactFromAssignedList(contact.id, contact.list || "Principal");
    } else if (button.dataset.action === "whatsapp-direct") {
      const phone = normalizeValidPeruPhone(contact.phone);
      if (phone) window.open(`https://wa.me/51${phone}`, "_blank", "noopener,noreferrer");
      else setStatus("Este contacto no tiene un número peruano válido para WhatsApp.", true);
    }
  };
  if (refs.finalizeTurnBtn) refs.finalizeTurnBtn.onclick = finalizeWorkTurn;
  if (refs.finalizeSessionBtn) refs.finalizeSessionBtn.onclick = finalizeOperationalSession;
  if (refs.addPairingQrBtn) refs.addPairingQrBtn.onclick = createPairingQr;
  if (refs.assignedListsPanelEl) refs.assignedListsPanelEl.onclick = async (event) => {
    const contactButton = event.target.closest("button[data-action]");
    if (contactButton) {
      const contact = Contacts.contacts.find((item) => item.id === contactButton.dataset.id);
      if (!contact) return;
      if (contactButton.dataset.action === "call-direct") {
        await callContactFromAssignedList(contact.id, contact.list || "Principal");
      } else if (contactButton.dataset.action === "whatsapp-direct") {
        const phone = normalizeValidPeruPhone(contact.phone);
        if (phone) window.open(`https://wa.me/51${phone}`, "_blank", "noopener,noreferrer");
        else setStatus("Este contacto no tiene un número peruano válido para WhatsApp.", true);
      }
      return;
    }
    const downloadButton = event.target.closest("button[data-download-assigned-list]");
    if (downloadButton) {
      downloadAssignedListReport(downloadButton.dataset.downloadAssignedList);
      return;
    }
    const deleteButton = event.target.closest("button[data-delete-assigned-list]");
    if (!deleteButton) return;
    const listName = deleteButton.dataset.deleteAssignedList;
    const accepted = await requestConfirmation({
      title: "Eliminar registro terminado",
      message: `¿Quitar el registro terminado de "${listName}"? La lista original y todos sus contactos se conservarán.`,
      confirmLabel: "Eliminar registro"
    });
    if (!accepted) return;
    hideAssignedRecord(listName);
    renderAssignedListsPanel();
    setStatus(`Registro terminado de "${listName}" eliminado. La base original se conserva.`, true);
  };
  if (refs.pairingSlotsEl) refs.pairingSlotsEl.onclick = async (event) => {
    const skipListButton = event.target.closest("button[data-skip-list-slot]");
    if (skipListButton) {
      await skipWorkerList(skipListButton.dataset.skipListSlot, skipListButton.dataset.workerId, skipListButton.dataset.currentList);
      return;
    }
    const independentButton = event.target.closest("button[data-independent-pairing-slot]");
    if (independentButton) {
      await startIndependentWorker(independentButton.dataset.workerId);
      return;
    }
    const stopButton = event.target.closest("button[data-stop-pairing-slot]");
    if (stopButton) {
      await stopIndependentWorker(stopButton.dataset.workerId);
      return;
    }
    const hangupButton = event.target.closest("button[data-hangup-pairing-slot]");
    if (hangupButton) {
      await hangupWorkerWithResult(hangupButton.dataset.workerId);
      return;
    }
    const disconnectButton = event.target.closest("button[data-disconnect-pairing-slot]");
    if (disconnectButton) {
      await disconnectWorker(disconnectButton.dataset.workerId, disconnectButton.dataset.workerName || "este teléfono");
      return;
    }
    const button = event.target.closest("button[data-delete-pairing-slot]");
    if (!button) return;
    const confirmed = await requestConfirmation({
      title: "Eliminar código QR",
      message: `¿Eliminar ${button.dataset.slotLabel || "este QR"}?`,
      confirmLabel: "Eliminar"
    });
    if (confirmed) await deletePairingQr(button.dataset.deletePairingSlot);
  };
  if (refs.campaignPauseBtn) refs.campaignPauseBtn.onclick = pauseCampaignRun;
  if (refs.campaignResumeBtn) refs.campaignResumeBtn.onclick = resumeCampaignRun;
  if (refs.campaignStopBtn) refs.campaignStopBtn.onclick = stopCampaignRun;
  if (refs.campaignReportBtn) refs.campaignReportBtn.onclick = downloadCampaignReport;
  if (refs.campaignSkipBtn) refs.campaignSkipBtn.onclick = skipCampaignContact;
  if (refs.campaignResultAgendaBtn) refs.campaignResultAgendaBtn.onclick = () => markCampaignResult("agendado");
  if (refs.campaignResultNoBtn) refs.campaignResultNoBtn.onclick = () => markCampaignResult("no_interesado");
  if (refs.campaignResultAdvisorBtn) refs.campaignResultAdvisorBtn.onclick = () => markCampaignResult("requiere_asesor");
  if (refs.campaignResultRetryBtn) refs.campaignResultRetryBtn.onclick = () => markCampaignResult("reintentar");
  if (refs.agentDisableBtn) {
    refs.agentDisableBtn.onclick = () => saveVoiceAgentConfig(false);
    refs.agentDisableBtn.disabled = true;
    refs.agentDisableBtn.title = "Agente de voz desactivado temporalmente";
  }
  
  // History
  if (refs.openHistoryBtn) refs.openHistoryBtn.onclick = openHistory;
  if (refs.historyCloseBtn) refs.historyCloseBtn.onclick = () => { refs.historyModalEl.style.display = "none"; };
  if (refs.clearHistoryBtn) refs.clearHistoryBtn.onclick = clearHistory;

  // Tabs
  renderTabs();

  loadHistory();
  
  
  // Missing button handlers
  if (refs.exportWordBtn) refs.exportWordBtn.onclick = exportContactsToWord;
  if (refs.deleteAllContactsBtn) {
    refs.deleteAllContactsBtn.onclick = async () => {
      if (!await requestConfirmation({ title: "Eliminar todos los contactos", message: "Se eliminarán todos los contactos y todas las listas. Esta acción no se puede deshacer.", confirmLabel: "Eliminar todo" })) return;
      Contacts.clearAllContacts();
      Contacts.lists.length = 0;
      Contacts.lists.push("Principal");
      Contacts.setActiveList("Principal");
      Contacts.saveLists();
      renderTabs();
      renderContacts();
      setStatus("Todos los contactos y listas han sido eliminados.");
    };
  }
  if (refs.connectWhatsAppBtn) refs.connectWhatsAppBtn.onclick = WhatsApp.openWhatsAppConnectModal;
  
  // WhatsApp modal handlers
  if (refs.whatsappCloseBtn) refs.whatsappCloseBtn.onclick = WhatsApp.closeWhatsAppModal;
  if (refs.whatsappSendBtn) refs.whatsappSendBtn.onclick = WhatsApp.sendWhatsAppMessage;
  if (refs.whatsappLogoutBtn) refs.whatsappLogoutBtn.onclick = WhatsApp.logoutWhatsAppAccount;
  if (refs.whatsappTemplateSaveBtn) refs.whatsappTemplateSaveBtn.onclick = WhatsApp.saveNewWhatsAppPresetMessage;
  
  // WhatsApp file drop zone handlers
  if (refs.whatsappDropZone) {
    refs.whatsappDropZone.onclick = () => refs.whatsappFileInput?.click();
    
    refs.whatsappDropZone.ondragover = (e) => {
      e.preventDefault();
      refs.whatsappDropZone.classList.add("drag-over");
    };
    
    refs.whatsappDropZone.ondragleave = () => {
      refs.whatsappDropZone.classList.remove("drag-over");
    };
    
    refs.whatsappDropZone.ondrop = (e) => {
      e.preventDefault();
      refs.whatsappDropZone.classList.remove("drag-over");
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        refs.whatsappFileInput.files = files;
        WhatsApp.updateWhatsAppFileLabel();
      }
    };
    
    if (refs.whatsappFileInput) {
      refs.whatsappFileInput.onchange = WhatsApp.updateWhatsAppFileLabel;
    }
  }
}

// ── MISSING BUTTON FUNCTIONS ─────────────────────────────────────────────
async function exportContactsToWord() {
  if (!Contacts.contacts.length) {
    setStatus("No hay contactos para exportar.", true);
    return;
  }

  try {
    setStatus("Generando documento Word...", true);
    
    // Create HTML content that can be converted to Word
    let htmlContent = `
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Lista de Contactos</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          h1 { color: #333; }
          table { border-collapse: collapse; width: 100%; margin-top: 20px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; font-weight: bold; }
          .call-count { background-color: #e8f5e8; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
        </style>
      </head>
      <body>
        <h1>Lista de Contactos - ${new Date().toLocaleDateString()}</h1>
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Teléfono</th>
              <th>Nota</th>
              <th>Llamadas</th>
            </tr>
          </thead>
          <tbody>
    `;

    Contacts.contacts.forEach(contact => {
      const callCount = Number(Contacts.calledCounts[contact.id] || 0);
      htmlContent += `
        <tr>
          <td>${escHtml(contact.name)}</td>
          <td>${escHtml(contact.phone)}</td>
          <td>${escHtml(contact.note || "")}</td>
          <td>${callCount > 0 ? `<span class="call-count">${callCount}</span>` : "0"}</td>
        </tr>
      `;
    });

    htmlContent += `
          </tbody>
        </table>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">
          Total de contactos: ${Contacts.contacts.length} | 
          Contactos llamados: ${Contacts.contacts.reduce((acc, c) => acc + (Number(Contacts.calledCounts[c.id] || 0) > 0 ? 1 : 0), 0)}
        </p>
      </body>
      </html>
    `;

    // Create a Blob with the HTML content
    const blob = new Blob([htmlContent], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    
    // Create download link
    const a = document.createElement('a');
    a.href = url;
    a.download = `contactos_${new Date().toISOString().split('T')[0]}.doc`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus("Documento Word descargado.", true);
  } catch (error) {
    console.error("Error exporting to Word:", error);
    setStatus("Error al exportar a Word.", true);
  }
}

// ── CALL LOGIC ────────────────────────────────────────────────────────
function startDialForContact(c) {
  if (["dialing", "ringing", "in_call"].includes(currentState)) return;
  currentCallingContactId = c.id;
  Contacts.calledCounts[c.id] = (Contacts.calledCounts[c.id] || 0) + 1;
  Contacts.saveCalledCounts();
  renderContacts();
  openCallWindow(c.phone, { contactName: c.name, note: c.note });
  emitCallActionWithAck("dial", { phoneNumber: c.phone, contactName: c.name, contactId: c.id });
}

function openCallWindow(phone, opts = {}) {
  callCtx = {
    phone: phone || "",
    contactName: opts.contactName || "Sin contacto",
    note: opts.note || "",
    answered: false
  };
  if (callTimerId) {
    clearInterval(callTimerId);
    callTimerId = null;
  }
  callStartedAt = null;
  if (refs.callKickerEl) refs.callKickerEl.textContent = "Enviando orden...";
  if (refs.callNameEl) refs.callNameEl.textContent = callCtx.contactName || "Sin contacto";
  if (refs.callNumberEl) refs.callNumberEl.textContent = callCtx.phone || "-";
  if (refs.callNoteEl) refs.callNoteEl.textContent = callCtx.note || "-";
  if (refs.callDurEl) refs.callDurEl.textContent = "00:00";
  refs.callModalEl.style.display = "grid";
  setBadge("idle", refs.callBadgeEl);
  if (refs.callHintEl) {
    refs.callHintEl.textContent = "Enviando orden al celular...";
  }
}

function formatCallDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Number(totalSeconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    const remMinutes = minutes % 60;
    return [hours, remMinutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  }
  return [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function stopCallTimer(clearStart = true) {
  if (callTimerId) {
    clearInterval(callTimerId);
    callTimerId = null;
  }
  if (clearStart) callStartedAt = null;
}

function startCallTimer() {
  stopCallTimer();
  if (!callStartedAt) callStartedAt = Date.now();
  if (refs.callDurEl) {
    refs.callDurEl.textContent = formatCallDuration(Math.floor((Date.now() - callStartedAt) / 1000));
  }
    callTimerId = setInterval(() => {
        if (!callStartedAt || !refs.callDurEl) return;
        const dur = Math.floor((Date.now() - callStartedAt) / 1000);
        refs.callDurEl.textContent = formatCallDuration(dur);
        lastCallDuration = dur; // Store the last duration
    }, 1000);
}

async function toggleMute() {
  micEnabled = !micEnabled;

  if (micEnabled) {
    await AudioBridge.startMic();
    if (currentState === "in_call") {
      await AudioBridge.startWebMicStreaming();
    }
    emitCallActionWithAck("unmute");
  } else {
    AudioBridge.stopMic();
    emitCallActionWithAck("mute");
  }

  syncAudioButtons();
}

function toggleSpeaker() {
  speakerEnabled = !speakerEnabled;
  AudioBridge.setPhoneAudioEnabled(speakerEnabled && currentState === "in_call");
  
  // Enviar comando al APK para el altavoz físico
  emitCallActionWithAck(speakerEnabled ? "speaker_on" : "speaker_off");
  
  syncAudioButtons();
}

function applyState(state, lastNum, opts = {}) {
  const previousState = currentState;
  currentState = state;
  
  if (opts.micMuted !== undefined) {
    const newMicEnabled = !opts.micMuted;
    if (newMicEnabled !== micEnabled) {
      micEnabled = newMicEnabled;
      if (!micEnabled) {
        AudioBridge.stopMic();
      }
    }
  }
  if (opts.isSpeakerOn !== undefined) {
    const newSpeakerEnabled = opts.isSpeakerOn;
    if (newSpeakerEnabled !== speakerEnabled) {
      speakerEnabled = newSpeakerEnabled;
      AudioBridge.setPhoneAudioEnabled(speakerEnabled && state === "in_call");
    }
  }
  
  syncAudioButtons();

  setBadge(state, refs.callBadgeEl);
  if (refs.callNumberEl && lastNum) refs.callNumberEl.textContent = lastNum;
  if (refs.callNameEl && opts.contactName) refs.callNameEl.textContent = opts.contactName;
  if (refs.callKickerEl) {
    refs.callKickerEl.className = `call-kicker state-${state}`;
    const kickerMap = {
      idle: "Listo",
      dialing: "Llamando...",
      ringing: "Sonando...",
      in_call: "Contestada",
      ended: callStartedAt ? "Llamada finalizada" : "No contestó",
      failed: "No se pudo llamar"
    };
    refs.callKickerEl.textContent = kickerMap[state] || "Estado";
  }
  if (refs.callHintEl) {
    const hints = {
      idle: "Esperando acción del celular.",
      dialing: "El celular inició el marcado.",
      ringing: "La llamada está sonando.",
      in_call: "Llamada contestada y en curso.",
      ended: callStartedAt ? `Duración: ${refs.callDurEl?.textContent || "00:00"}` : "La llamada no fue contestada.",
      failed: "No se pudo iniciar la llamada."
    };
    refs.callHintEl.textContent = hints[state] || "";
  }

  // New state handling logic
    if (state === "in_call") {
        if (!callStartedAt) { 
            callStartedAt = Date.now();
            startCallTimer();
        }
        refs.callModalEl.classList.add("is-active-call");
        refs.callModalEl.classList.remove("is-ringing");
        refs.callRingEl.classList.add("is-in-call");
    } else if (state === "idle" || state === "ended" || state === "failed") {
        stopCallTimer(false); // Stop but don't clear Last Duration yet
        refs.callModalEl.classList.remove("is-active-call");
        refs.callModalEl.classList.remove("is-ringing");
        refs.callRingEl.classList.remove("is-in-call");
        
        if (state === "ended" && lastCallDuration > 0) {
            if (currentCallingContactId) {
                Contacts.callDurations[currentCallingContactId] = (Contacts.callDurations[currentCallingContactId] || 0) + lastCallDuration;
                Contacts.saveCallDurations();
            }
            
            // Add to history
            addHistoryEntry(lastNum || callCtx?.phone, lastCallDuration);

            refs.callHintEl.textContent = `Llamada finalizada. Duración: ${formatCallDuration(lastCallDuration)}`;
            // Keep duration visible in the badge for a moment
            if (refs.callDurEl) refs.callDurEl.textContent = formatCallDuration(lastCallDuration);
            lastCallDuration = 0;
            renderContacts();
        }

        if (state === "idle" || state === "ended" || state === "failed") {
            if (state === "idle") {
              callStartedAt = null;
              if (refs.callDurEl) refs.callDurEl.textContent = "00:00";
            }
            AudioBridge.stopPhoneAudio();
            AudioBridge.stopMic();
            micEnabled = false;
            syncAudioButtons();
            
            // Close modal faster (2s instead of 4s) to keep campaign moving
            setTimeout(() => { 
                if (currentState === "idle" || currentState === "ended" || currentState === "failed") {
                    refs.callModalEl.style.display = "none"; 
                }
            }, 2000);
        }
    } else {
        refs.callModalEl.classList.remove("is-active-call");
        if (state === "ringing" || state === "dialing") {
          refs.callModalEl.classList.add("is-ringing");
        } else {
          refs.callModalEl.classList.remove("is-ringing");
        }
        refs.callRingEl.classList.remove("is-in-call");
    }

    if (state === "ringing" || state === "dialing") {
        refs.callRingEl.classList.add("is-calling");
    } else {
        refs.callRingEl.classList.remove("is-calling");
    }
    syncAudioButtons();
}

function emitCallActionWithAck(action, payload = {}) {
  const commandId = (typeof crypto.randomUUID === 'function') 
    ? crypto.randomUUID() 
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  const existing = pendingCommandTimeouts.get(commandId);
  if (existing) clearTimeout(existing);
  socket.emit("call:action", { action, commandId, ...payload });
  setAckBadge(refs.apkAckBadgeEl, "pending", `APK · ${action}...`);
  const timeoutId = setTimeout(() => {
    pendingCommandTimeouts.delete(commandId);
    setAckBadge(refs.apkAckBadgeEl, "warn", `APK · sin respuesta`);
    if (refs.callHintEl && action === "dial" && ["idle", "failed", "ended"].includes(currentState)) {
      refs.callHintEl.textContent = "El celular no confirmó la orden. Revisa permisos, marcador predeterminado o conexión del APK.";
    }
  }, 8000);
  pendingCommandTimeouts.set(commandId, timeoutId);
  return commandId;
}

function updatePairingHint(link) {
  if (!refs.qrHintEl) return;
  if (currentPhoneLinked) return;

  try {
    const parsed = new URL(link);
    const apiBase = String(parsed.searchParams.get("apiBase") || "").trim();
    if (!apiBase) {
      refs.qrHintEl.textContent = "QR generado, pero no incluye apiBase.";
      return;
    }

    const apiUrl = new URL(apiBase);
    const host = apiUrl.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      refs.qrHintEl.textContent = `Advertencia: el QR apunta a ${apiBase}. Ese host no sirve para el celular; usa IP LAN o dominio público.`;
      return;
    }

    refs.qrHintEl.textContent = `QR listo. La APK se conectará a ${apiBase}`;
  } catch {
    refs.qrHintEl.textContent = "QR listo. Verifica que la URL del servidor sea accesible desde el celular.";
  }
}

function updateSessionUi(st = {}) {
  if (sessionCode && dashboardToken) {
    const bookCode = sessionCode;
    const bookToken = dashboardToken;
    Contacts.connectDatabase(bookCode, async (method,body) => {
      const response = await fetch(`${API_BASE}/api/session/${encodeURIComponent(bookCode)}/contact-book`, {
        method, headers:{"Content-Type":"application/json","X-Dashboard-Token":bookToken},
        ...(body ? {body:JSON.stringify(body)} : {})
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo guardar la base en MySQL.");
      return data;
    }).catch(() => {});
  }
  latestSessionState = st || {};
  const storageStatus = document.getElementById("storageStatus");
  if (storageStatus) {
    const pending = st.storage?.mode === "pending";
    storageStatus.hidden = !pending;
    storageStatus.textContent = pending
      ? "Hay datos pendientes de guardar. No se iniciarán nuevas llamadas hasta recuperar el guardado."
      : "";
  }
  const dashboardConnected = Boolean(st?.connected?.dashboard ?? sessionCode);

  const phoneConnected = Boolean(st?.connected?.phone);
  const phoneLinking   = Boolean(st?.connected?.linking);
  const phoneCount = Number(st?.connected?.phoneCount || 0);
  const phoneDeviceName = String(st?.phoneDevice?.name || "").trim();
  currentPhoneLinked = phoneConnected;

  if (refs.qrHintEl && phoneLinking) {
    refs.qrHintEl.innerHTML = `<strong>¡Celular detectado!</strong> Sincronizando datos...`;
    refs.qrHintEl.style.color = "var(--success)";
  }

  if (refs.qrBlockEl) {
    refs.qrBlockEl.classList.toggle("is-linked", phoneConnected);
  }

  if (refs.linkedBanner) {
    refs.linkedBanner.style.display = phoneConnected ? "flex" : "none";
  }
  if (refs.linkedDevice) {
    if (phoneConnected) {
      const deviceLabel = phoneDeviceName || (phoneCount > 1 ? `${phoneCount} dispositivos conectados` : "Dispositivo conectado");
      refs.linkedDevice.textContent = deviceLabel;
    } else {
      refs.linkedDevice.textContent = "Dispositivo conectado";
    }
  }
  if (refs.contactsSec) {
    refs.contactsSec.style.display = dashboardConnected ? "block" : "none";
  }
  if (refs.contactsDataSec) {
    refs.contactsDataSec.style.display = dashboardConnected ? "block" : "none";
  }
  if (refs.qrBlockEl) {
    // Keep the QR visible so more phones can join the same session.
    refs.qrBlockEl.style.display = dashboardConnected ? "flex" : "none";
  }

  if (dashboardConnected) {
    setStatus(phoneConnected ? `${phoneCount} teléfono(s) vinculado(s). Cada dispositivo utiliza su propio QR.` : "Tu espacio está listo. Escanea un QR diferente en cada teléfono.", true);
    renderCampaignPanel();
  } else {
    setStatus("Cargando tu espacio de trabajo...");
  }
}

// ── APK & PAIRING ────────────────────────────────────────────────────
async function loadPairingData(code) {
  try {
    const res = await fetch(`${API_BASE}/api/pairing/${code}`, {
      headers: { "X-Dashboard-Token": dashboardToken }
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo generar la vinculación.");
    const slots = Array.isArray(data.pairingSlots) ? data.pairingSlots : [];
    pairingSlotsSnapshot = slots;
    pairQrObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    pairQrObjectUrls = [];

    const listAssignmentBySlotId = new Map(getPairingListAssignments().map((assignment) => [assignment.slot.id, assignment]));
    const workers = Array.isArray(latestSessionState?.phoneWorkers) ? latestSessionState.phoneWorkers : [];
    const renderedSlots = await Promise.all(slots.map(async (slot, index) => {
      const slotDisplayLabel = `EQUIPO ${index + 1}`;
      let qrUrl = "";
      try {
        const qrResponse = await fetch(`${API_BASE}/api/pairing-qr/${code}.svg?slot=${encodeURIComponent(slot.id)}`, {
          headers: { "X-Dashboard-Token": dashboardToken }
        });
        if (!qrResponse.ok) throw new Error(`HTTP ${qrResponse.status}`);
        qrUrl = URL.createObjectURL(await qrResponse.blob());
        pairQrObjectUrls.push(qrUrl);
      } catch {
        qrUrl = "";
      }
      const assigned = Boolean(slot.deviceId);
      const activeWorkerList = slot.deviceId
        ? (campaignState?.contacts || []).find((contact) =>
            contact.targetWorkerId === slot.deviceId && !["completed", "failed", "awaiting_callback"].includes(contact.status)
          )?.list
        : "";
      const assignedList = activeWorkerList || listAssignmentBySlotId.get(slot.id)?.listName || "";
      const worker = workers.find((item) => String(item.id) === String(slot.deviceId));
      const connected = Boolean(worker?.connected);
      const callState = String(worker?.callState || "idle");
      const calling = Boolean(connected && ["dialing", "ringing", "in_call"].includes(callState));
      const ringing = ["dialing", "ringing"].includes(callState);
      const answered = callState === "in_call";
      const ended = Boolean(worker && ["ended", "failed"].includes(callState));
      const heldContact = (campaignState?.contacts || []).find((contact) =>
        contact.targetWorkerId === slot.deviceId && contact.status === "held"
      );
      const statusIcon = ringing
        ? { src: "./assets/call-status/timbrando.png", label: "Timbrando", effect: "is-vibrating" }
        : answered
          ? { src: "./assets/call-status/contesto.png", label: "Llamada contestada", effect: "is-pulsing" }
          : ended || heldContact
            ? { src: "./assets/call-status/rechazado.png", label: "Llamada rechazada o finalizada", effect: "is-rejected" }
            : null;
      return `
        <article class="pairing-slot-card ${assigned ? "is-assigned" : ""}">
          <div class="pairing-slot-top">
            <strong>${slotDisplayLabel}</strong>
            <span class="pairing-slot-state">${assigned ? (connected ? "Conectado" : "Desconectado") : "Disponible"}</span>
          </div>
          ${qrUrl
            ? `<img class="pairing-slot-qr" src="${qrUrl}" alt="QR independiente para ${slotDisplayLabel}" />`
            : `<div class="pairing-slot-qr-error">No se pudo cargar este QR. Actualiza la página.</div>`}
          <div class="pairing-slot-details">
            <span>Teléfono</span>
            <strong>${assigned ? escHtml(slot.deviceName || "Teléfono vinculado") : "Sin vincular"}</strong>
            <span>Lista asignada</span>
            <strong>${assignedList ? escHtml(assignedList) : "Sin lista asignada"}</strong>
          </div>
          <div class="pairing-slot-current-call ${ringing ? "is-ringing" : answered ? "is-answered" : ended || heldContact ? "is-ended" : ""}">
            <span>${ringing ? "Teléfono timbrando" : answered ? "Llamada contestada" : heldContact ? "Llamada detenida" : ended ? "Llamada finalizada" : "Estado de llamada"}</span>
            <div class="pairing-call-number-row">
              <strong class="pairing-call-number">${calling || ended ? escHtml(worker.phoneNumber || "Sin número") : heldContact ? escHtml(heldContact.phone || "") : "Esperando llamada"}</strong>
              ${statusIcon ? `<img class="pairing-call-status-icon ${statusIcon.effect}" src="${statusIcon.src}" alt="${statusIcon.label}" />` : ""}
            </div>
            <small class="pairing-call-company">${calling || ended ? escHtml(worker.companyName || "Empresa") : heldContact ? escHtml(heldContact.name || "Empresa") : ""}</small>
          </div>
          <div class="pairing-slot-call-actions">
            <button type="button" class="pairing-slot-independent" data-independent-pairing-slot="${escHtml(slot.id)}" data-worker-id="${escHtml(slot.deviceId || "")}" ${connected && assignedList && !calling ? "" : "disabled"}>▶ Iniciar</button>
            <button type="button" class="pairing-slot-stop" data-stop-pairing-slot="${escHtml(slot.id)}" data-worker-id="${escHtml(slot.deviceId || "")}" ${calling ? "" : "disabled"}>■ Detener</button>
            <button type="button" class="pairing-slot-hangup" data-hangup-pairing-slot="${escHtml(slot.id)}" data-worker-id="${escHtml(slot.deviceId || "")}" ${calling ? "" : "disabled"}>☎ Colgar</button>
          </div>
          <button type="button" class="pairing-slot-skip-list" data-skip-list-slot="${escHtml(slot.id)}" data-worker-id="${escHtml(slot.deviceId || "")}" data-current-list="${escHtml(assignedList)}" ${connected && assignedList ? "" : "disabled"}>SALTAR LISTA</button>
          ${assigned ? `<button type="button" class="pairing-slot-disconnect" data-disconnect-pairing-slot="${escHtml(slot.id)}" data-worker-id="${escHtml(slot.deviceId || "")}" data-worker-name="${escHtml(slot.deviceName || "Teléfono vinculado")}">Desvincular teléfono</button>` : ""}
          ${assigned ? "" : `<button type="button" class="pairing-slot-delete" data-delete-pairing-slot="${escHtml(slot.id)}" data-slot-label="${slotDisplayLabel}">Eliminar QR</button>`}
        </article>`;
    }));

    if (refs.pairingSlotsEl) {
      refs.pairingSlotsEl.innerHTML = renderedSlots.length
        ? renderedSlots.join("")
        : `<div class="campaign-list-empty">No hay códigos QR disponibles.</div>`;
    }
    renderAssignedListsPanel();
  } catch (error) {
    if (refs.pairingSlotsEl) refs.pairingSlotsEl.innerHTML = `<div class="campaign-list-empty">${escHtml(error.message || "No se pudieron cargar los códigos QR.")}</div>`;
  }
}

function renderAssignedListsPanel() {
  const container = refs.assignedListsPanelEl;
  if (!container) return;

  const hiddenRecords = getHiddenAssignedRecords();
  const listAssignments = getPairingListAssignments()
    .filter(({ listName }) => !hiddenRecords.has(String(listName)));

  if (!listAssignments.length) {
    container.innerHTML = `<div class="assigned-lists-empty">Todavía no hay listas asignadas.</div>`;
    return;
  }

  const history = Array.isArray(campaignState?.history) ? campaignState.history : [];
  const latestHistoryByContact = new Map();
  for (const entry of history) {
    const key = String(entry.contactId || "");
    if (!key) continue;
    const previous = latestHistoryByContact.get(key);
    if (!previous || Date.parse(entry.startedAt || 0) >= Date.parse(previous.startedAt || 0)) {
      latestHistoryByContact.set(key, entry);
    }
  }

  container.innerHTML = listAssignments.map(({ listName, slotIndex }, listIndex) => {
    const contacts = Contacts.contacts.filter((contact) =>
      (contact.list || "Principal") === listName && normalizeValidPeruPhone(contact.phone)
    );
    const called = contacts.filter((contact) => Number(contact.attempts || 0) > 0 || latestHistoryByContact.has(String(contact.id)));
    const campaignContactById = new Map((campaignState?.contacts || []).map((contact) => [String(contact.id), contact]));
    const pending = contacts.filter((contact) => {
      const status = campaignContactById.get(String(contact.id))?.status || contact.campaignStatus || "";
      return !called.includes(contact) || ["pending", "retry_pending", "held"].includes(status);
    });
    const finished = contacts.length > 0 && pending.length === 0;
    const slot = pairingSlotsSnapshot[slotIndex];

    const pendingRows = pending.map((contact) => `
      <tr>
        <td>${contacts.indexOf(contact) + 1}</td>
        <td>${escHtml(contact.name || "Sin nombre")}</td>
        <td><span class="pending-contact-phone"><span>${escHtml(contact.phone || "-")}</span><img src="./assets/call-status/contacto-pendiente.png" alt="Contacto pendiente" /></span></td>
        <td>${contactActionButtons(contact, "assigned-pending")}</td>
      </tr>`).join("");

    const calledRows = called.map((contact) => {
      const attempt = latestHistoryByContact.get(String(contact.id)) || {};
      const answered = Boolean(attempt.answeredAt || attempt.technicalResult === "contesto" || contact.technicalResult === "contesto");
      const duration = Number(attempt.durationSeconds ?? contact.callDurationSeconds ?? 0);
      return `
        <tr>
          <td>${contacts.indexOf(contact) + 1}</td>
          <td>${escHtml(contact.name || attempt.name || "Sin nombre")}</td>
          <td>${escHtml(contact.phone || attempt.phone || "-")}</td>
          <td><span class="answered-badge ${answered ? "yes" : "no"}">${answered ? "Sí" : "No"}</span></td>
          <td>${escHtml(formatCallDuration(duration))}</td>
          <td>${contactActionButtons(contact, "assigned")}</td>
        </tr>`;
    }).join("");

    return `
      <article class="assigned-list-card">
        <div class="assigned-list-head">
          <div>
            <span>ASIGNACIÓN ${listIndex + 1} · EQUIPO ${slotIndex + 1}</span>
            <h3>${escHtml(listName)}</h3>
          </div>
          <div class="assigned-list-head-actions">
            <strong class="assigned-list-status ${finished ? "finished" : ""}">${finished ? "Lista terminada" : `${contacts.length} contactos`}</strong>
            ${finished && listName !== "Principal" ? `<button type="button" class="assigned-list-delete" data-delete-assigned-list="${escHtml(listName)}">Eliminar registro</button>` : ""}
          </div>
        </div>
        <div class="assigned-list-group">
          <h4>Pendientes por llamar <span>${pending.length}</span></h4>
          <div class="assigned-list-table-wrap">
            <table><thead><tr><th>N.º</th><th>Empresa</th><th>Teléfono</th><th>Contacto</th></tr></thead>
            <tbody>${pendingRows || `<tr><td colspan="4" class="assigned-list-none">No quedan contactos pendientes.</td></tr>`}</tbody></table>
          </div>
        </div>
        <div class="assigned-list-group called">
          <h4>Contactos llamados <span>${called.length}</span></h4>
          <div class="assigned-list-table-wrap">
            <table><thead><tr><th>N.º</th><th>Empresa</th><th>Teléfono</th><th>Contestó</th><th>Duración</th><th>Contacto</th></tr></thead>
            <tbody>${calledRows || `<tr><td colspan="6" class="assigned-list-none">Todavía no se realizaron llamadas.</td></tr>`}</tbody></table>
          </div>
        </div>
      </article>`;
  }).join("");
}

async function downloadAssignedListReport(listName) {
  const rows = getCampaignReportRows()
    .filter((item) => (item.list || "") === listName)
    .sort((left, right) => (new Date(left.startedAt || 0).getTime() || 0) - (new Date(right.startedAt || 0).getTime() || 0));
  const shift = currentShiftSnapshot()?.current || currentShiftSnapshot()?.detected || {};
  const pdf = await buildCallReportPdf(listName, rows, shift);
  const blob = new Blob([pdf], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `reporte_${String(listName || "lista").replace(/[^a-z0-9_-]+/gi, "_")}_${new Date().toISOString().slice(0, 10)}.pdf`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pdfSafeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function pdfClipText(value, maxLength) {
  const text = pdfSafeText(value).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function buildAssignedListPdf(listName, rows) {
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 38;
  const pages = [];
  let commands = [];
  let y = 0;
  let pageNumber = 0;

  const text = (value, x, baseline, size = 9, bold = false, color = "0.12 0.03 0.18") => {
    commands.push(`${color} rg BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x} ${baseline} Tm (${pdfSafeText(value)}) Tj ET`);
  };
  const rect = (x, bottom, width, height, fill, stroke = null) => {
    commands.push(`${fill} rg${stroke ? ` ${stroke} RG` : ""} ${x} ${bottom} ${width} ${height} re ${stroke ? "B" : "f"}`);
  };
  const line = (x1, y1, x2, y2, color = "0.88 0.76 0.90") => {
    commands.push(`${color} RG 0.5 w ${x1} ${y1} m ${x2} ${y2} l S`);
  };
  const startPage = () => {
    if (commands.length) pages.push(commands.join("\n"));
    commands = [];
    pageNumber += 1;
    rect(0, 0, pageWidth, pageHeight, "0.985 0.975 0.992");
    rect(0, pageHeight - 15, pageWidth, 15, "0.91 0.00 0.67");
    text("VIAVOX VC - GESTION DE LLAMADAS", margin, pageHeight - 42, 9, true, "0.43 0.03 0.55");
    text(`Pagina ${pageNumber}`, pageWidth - 82, 24, 8, false, "0.42 0.33 0.46");
    y = pageHeight - 70;
  };
  const tableHeader = () => {
    const headers = ["N.", "EMPRESA", "TELEFONO", "EQUIPO", "INT.", "CONTESTO", "DURACION"];
    const widths = [28, 132, 78, 103, 42, 67, 66];
    let x = margin;
    rect(margin, y - 22, 516, 25, "0.38 0.02 0.46");
    headers.forEach((header, index) => {
      text(header, x + 5, y - 14, 7.5, true, "1 1 1");
      x += widths[index];
    });
    y -= 25;
  };

  const answeredRows = rows.filter(isAnsweredAttempt);
  const totalSeconds = rows.reduce((total, row) => total + Number(row.durationSeconds || 0), 0);
  const equipmentCounts = new Map();
  rows.forEach((row) => {
    const equipment = String(row.worker || "Sin equipo").trim() || "Sin equipo";
    equipmentCounts.set(equipment, (equipmentCounts.get(equipment) || 0) + 1);
  });

  startPage();
  text("REPORTE DE LLAMADAS", margin, y, 22, true, "0.24 0.01 0.31");
  y -= 26;
  text(`Lista: ${listName || "Sin nombre"}`, margin, y, 13, true, "0.72 0.00 0.59");
  text(`Generado: ${new Date().toLocaleString("es-PE")}`, 345, y, 8, false, "0.42 0.33 0.46");
  y -= 44;

  const summary = [
    ["LLAMADAS", rows.length],
    ["CONTESTADAS", answeredRows.length],
    ["NO CONTESTADAS", Math.max(0, rows.length - answeredRows.length)],
    ["DURACION TOTAL", formatCallDuration(totalSeconds)]
  ];
  summary.forEach(([label, value], index) => {
    const x = margin + index * 130;
    rect(x, y - 38, 119, 46, "0.95 0.91 0.97", "0.88 0.20 0.72");
    text(label, x + 8, y - 7, 7, true, "0.45 0.05 0.50");
    text(value, x + 8, y - 28, 15, true, "0.18 0.02 0.25");
  });
  y -= 68;

  text("CANTIDAD DE LLAMADAS POR EQUIPO", margin, y, 11, true, "0.35 0.02 0.43");
  y -= 20;
  if (!equipmentCounts.size) {
    text("Todavia no hay llamadas registradas.", margin, y, 9, false, "0.42 0.33 0.46");
    y -= 22;
  } else {
    [...equipmentCounts.entries()].forEach(([equipment, count], index) => {
      if (y < 135) startPage();
      rect(margin, y - 14, 516, 22, index % 2 ? "0.98 0.96 0.99" : "0.94 0.90 0.96");
      text(pdfClipText(equipment, 66), margin + 8, y - 7, 8.5, true);
      text(`${count} llamada${count === 1 ? "" : "s"}`, pageWidth - 119, y - 7, 8.5, true, "0.72 0.00 0.59");
      y -= 22;
    });
  }
  y -= 22;
  text("DETALLE DEL REGISTRO", margin, y, 11, true, "0.35 0.02 0.43");
  y -= 18;
  tableHeader();

  if (!rows.length) {
    text("No hay llamadas registradas para esta lista.", margin + 8, y - 18, 9, false, "0.42 0.33 0.46");
  } else {
    rows.forEach((row, index) => {
      if (y < 66) {
        startPage();
        text(`REPORTE: ${pdfClipText(listName, 55)}`, margin, y, 12, true, "0.35 0.02 0.43");
        y -= 24;
        tableHeader();
      }
      const answered = isAnsweredAttempt(row);
      const values = [
        index + 1,
        pdfClipText(row.name || "Sin nombre", 25),
        pdfClipText(row.phone || "-", 14),
        pdfClipText(row.worker || "Sin equipo", 19),
        row.attemptNumber || 1,
        answered ? "SI" : "NO",
        formatCallDuration(Number(row.durationSeconds || 0))
      ];
      const widths = [28, 132, 78, 103, 42, 67, 66];
      let x = margin;
      if (index % 2) rect(margin, y - 20, 516, 24, "0.975 0.955 0.982");
      values.forEach((value, valueIndex) => {
        const color = valueIndex === 5 ? (answered ? "0.00 0.48 0.35" : "0.78 0.05 0.36") : "0.12 0.03 0.18";
        text(value, x + 5, y - 13, 7.8, valueIndex === 0 || valueIndex === 5, color);
        x += widths[valueIndex];
      });
      line(margin, y - 20, margin + 516, y - 20);
      y -= 24;
    });
  }
  pages.push(commands.join("\n"));

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"
  ];
  const kids = [];
  pages.forEach((content, index) => {
    const pageObject = 5 + index * 2;
    const contentObject = pageObject + 1;
    kids.push(`${pageObject} 0 R`);
    objects[pageObject - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObject} 0 R >>`;
    objects[contentObject - 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  let documentText = "%PDF-1.4\n%PDFREPORT\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = documentText.length;
    documentText += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = documentText.length;
  documentText += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    documentText += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  documentText += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new TextEncoder().encode(documentText);
}

let pdfLogoDataPromise = null;

function loadPdfLogoData() {
  if (pdfLogoDataPromise) return pdfLogoDataPromise;
  pdfLogoDataPromise = new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 220;
        canvas.height = 150;
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const ratio = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
        const width = image.naturalWidth * ratio;
        const height = image.naturalHeight * ratio;
        context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      } catch (error) {
        console.warn("No se pudo preparar el logo para el PDF:", error);
        resolve("");
      }
    };
    image.onerror = () => resolve("");
    image.src = `/logo-vc-color.png?v=pdf-${Date.now()}`;
  });
  return pdfLogoDataPromise;
}

function limaClockParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value || 0));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(values.hour || 0), minute: Number(values.minute || 0) };
}

function reportTimeBand(startedAt, shiftType = "") {
  const { hour, minute } = limaClockParts(startedAt);
  const total = hour * 60 + minute;
  const morning = [450, 480, 540, 600, 660, 720, 780, 840];
  const afternoon = [810, 870, 930, 990, 1050, 1110, 1170, 1230];
  const boundaries = shiftType === "afternoon" ? afternoon : morning;
  const colors = ["#f9c9ea", "#e2d1f9", "#cfe0fb", "#ccefee", "#d9f1d2", "#fff1bf", "#f9dcc4"];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    if (total >= boundaries[index] && total < boundaries[index + 1]) return colors[index];
  }
  return "#ffffff";
}

function reportResult(row) {
  const answered = isAnsweredAttempt(row);
  if (row.technicalResult === "buzon_de_voz") return "BUZON DE VOZ";
  if (row.technicalResult === "sin_servicio") return "SIN SERVICIO";
  if (row.technicalResult === "no_disponible") return "NO DISPONIBLE";
  return answered ? "CONTESTO" : "NO CONTESTO";
}

async function buildCallReportPdf(listName, sourceRows, shift = {}) {
  const JsPdf = window.jspdf?.jsPDF;
  if (!JsPdf) throw new Error("No se pudo cargar el generador PDF.");
  const rows = [...(sourceRows || [])].sort((left, right) => {
    const worker = reportWorkerKey(left).localeCompare(reportWorkerKey(right), "es", { numeric: true });
    if (worker) return worker;
    const leftAnswered = reportResult(left) === "CONTESTO";
    const rightAnswered = reportResult(right) === "CONTESTO";
    if (leftAnswered !== rightAnswered) return leftAnswered ? -1 : 1;
    return (Date.parse(left.startedAt || 0) || 0) - (Date.parse(right.startedAt || 0) || 0);
  });
  const groups = new Map();
  rows.forEach((row) => {
    const workerKey = reportWorkerKey(row);
    if (!groups.has(workerKey)) groups.set(workerKey, []);
    groups.get(workerKey).push(row);
  });
  if (!groups.size) groups.set("Sin equipo", []);

  const totalCalls = rows.length;
  const answeredCalls = rows.filter((row) => reportResult(row) === "CONTESTO").length;
  const unansweredCalls = totalCalls - answeredCalls;
  const equipmentLabels = new Map(
    [...groups.keys()].map((workerKey, index) => [workerKey, `EQUIPO ${index + 1}`])
  );

  const pdf = new JsPdf({ unit: "pt", format: "a4", orientation: "landscape" });
  const logo = await loadPdfLogoData();
  const width = pdf.internal.pageSize.getWidth();
  const height = pdf.internal.pageSize.getHeight();
  const margin = 30;
  const columns = [
    ["N.", 24], ["BASE", 74], ["EMPRESA", 128], ["TELEFONO", 72],
    ["EQUIPO", 65], ["HORA LIMA", 105], ["INT.", 32], ["DURACION", 57], ["RESULTADO", 105]
  ];
  const tableWidth = columns.reduce((sum, column) => sum + column[1], 0);
  const reportRight = margin + tableWidth;
  let page = 0;
  const clip = (value, max) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  };
  const header = (workerKey, workerName, count, continuation = false) => {
    page += 1;
    pdf.setFillColor("#fbf7fc"); pdf.rect(0, 0, width, height, "F");
    pdf.setFillColor("#e800a8"); pdf.rect(0, 0, width, 12, "F");
    if (logo) pdf.addImage(logo, "JPEG", margin, 20, 56, 38);
    pdf.setFont("helvetica", "bold"); pdf.setTextColor("#4b075a"); pdf.setFontSize(18);
    pdf.text("REPORTE DE LLAMADAS", logo ? 98 : margin, 39);
    pdf.setFontSize(11); pdf.setTextColor("#c0008e");
    const equipmentLabel = equipmentLabels.get(workerKey) || "EQUIPO 1";
    pdf.text(`${equipmentLabel}: ${workerName.toUpperCase()}${continuation ? " (CONTINUACION)" : ""}`, margin, 78);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor("#3a2440");
    pdf.text(`${shift.label || listName || "TURNO"} | ${shift.date || formatLimaReportDate(new Date()).slice(0, 10)} | ${count} llamada${count === 1 ? "" : "s"}`, margin, 94);
    pdf.text("Lima - Peru", reportRight, 39, { align: "right" });
    pdf.text(`Pagina ${page}`, reportRight, height - 14, { align: "right" });
    if (page === 1) {
      const cards = [
        ["LLAMADAS TOTALES", totalCalls, "#650073"],
        ["CONTESTADAS", answeredCalls, "#00764f"],
        ["NO CONTESTADAS", unansweredCalls, "#a40055"]
      ];
      const cardWidth = 128;
      const startX = reportRight - cards.length * cardWidth - (cards.length - 1) * 8;
      cards.forEach(([label, value, color], index) => {
        const x = startX + index * (cardWidth + 8);
        pdf.setFillColor("#ffffff");
        pdf.setDrawColor(color);
        pdf.roundedRect(x, 60, cardWidth, 38, 4, 4, "FD");
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(6.5); pdf.setTextColor(color);
        pdf.text(label, x + 8, 73);
        pdf.setFontSize(13);
        pdf.text(String(value), x + 8, 91);
      });
    }
    // Mantiene una separacion visual clara entre el encabezado/resumen y la tabla
    // en la primera pagina, las paginas por equipo y las continuaciones.
    return 128;
  };
  const tableHeader = (y) => {
    pdf.setFillColor("#650073"); pdf.roundedRect(margin, y, tableWidth, 25, 3, 3, "F");
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(7); pdf.setTextColor("#ffffff");
    let x = margin;
    columns.forEach(([label, columnWidth]) => { pdf.text(label, x + 4, y + 16); x += columnWidth; });
    return y + 25;
  };

  let firstPage = true;
  for (const [workerKey, workerRows] of groups.entries()) {
    const workerName = workerRows.length ? reportWorkerLabel(workerRows[0]) : "Sin equipo";
    if (!firstPage) pdf.addPage();
    firstPage = false;
    let y = tableHeader(header(workerKey, workerName, workerRows.length));
    if (!workerRows.length) {
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor("#49384d");
      pdf.text("No hay llamadas registradas para este equipo.", margin + 6, y + 20);
      continue;
    }
    for (let index = 0; index < workerRows.length; index += 1) {
      const row = workerRows[index];
      if (y + 26 > height - 30) {
        pdf.addPage();
        y = tableHeader(header(workerKey, workerName, workerRows.length, true));
      }
      pdf.setFillColor(index % 2 === 0 ? "#ffffff" : "#fbf7fc");
      pdf.rect(margin, y, tableWidth, 25, "F");
      const result = reportResult(row);
      const equipmentLabel = equipmentLabels.get(workerKey) || "EQUIPO 1";
      const values = [
        String(index + 1), clip(row.list || "Sin lista", 16), clip(row.name || "Sin nombre", 28),
        clip(row.phone || "-", 12), equipmentLabel, formatLimaReportDate(row.startedAt, true), String(row.attemptNumber || 1),
        formatCallDuration(Number(row.durationSeconds || 0)), result
      ];
      let x = margin;
      pdf.setFontSize(7.2);
      values.forEach((value, valueIndex) => {
        const resultIndex = values.length - 1;
        const timeIndex = 5;
        if (valueIndex === timeIndex) {
          const dateTime = String(value || "").trim();
          const separator = dateTime.lastIndexOf(" ");
          const datePart = separator > 0 ? dateTime.slice(0, separator) : "";
          const timePart = separator > 0 ? dateTime.slice(separator + 1) : dateTime;
          pdf.setFont("helvetica", "normal");
          pdf.setTextColor("#24102b");
          if (datePart) pdf.text(datePart, x + 4, y + 16);
          const timeX = x + 4 + (datePart ? pdf.getTextWidth(`${datePart} `) : 0);
          pdf.setFont("helvetica", "bold");
          pdf.setTextColor("#d00095");
          pdf.text(timePart, timeX, y + 16);
          x += columns[valueIndex][1];
          return;
        }
        pdf.setFont(
          "helvetica",
          valueIndex === 0 || valueIndex === resultIndex ? "bold" : "normal"
        );
        pdf.setTextColor(
          valueIndex === resultIndex
            ? (result === "CONTESTO" ? "#00764f" : "#a40055")
            : "#24102b"
        );
        pdf.text(value, x + 4, y + 16);
        x += columns[valueIndex][1];
      });
      pdf.setDrawColor("#dcb9df"); pdf.line(margin, y + 25, margin + tableWidth, y + 25);
      y += 25;
    }
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}

async function legacyBuildCallReportPdf(listName, sourceRows) {
  const JsPdf = window.jspdf?.jsPDF;
  if (!JsPdf) throw new Error("No se pudo cargar el generador PDF.");

  const rows = [...(sourceRows || [])].sort((left, right) => {
    const workerOrder = String(left.worker || "Sin equipo").localeCompare(String(right.worker || "Sin equipo"), "es", {
      sensitivity: "base",
      numeric: true
    });
    if (workerOrder !== 0) return workerOrder;
    const leftAnswered = Boolean(left.answeredAt || left.technicalResult === "contesto");
    const rightAnswered = Boolean(right.answeredAt || right.technicalResult === "contesto");
    if (leftAnswered !== rightAnswered) return leftAnswered ? -1 : 1;
    return (new Date(left.startedAt || 0).getTime() || 0) - (new Date(right.startedAt || 0).getTime() || 0);
  });
  const documentPdf = new JsPdf({ unit: "pt", format: "a4", orientation: "portrait" });
  const logoData = await loadPdfLogoData();
  const pageWidth = documentPdf.internal.pageSize.getWidth();
  const pageHeight = documentPdf.internal.pageSize.getHeight();
  const margin = 34;
  const tableWidth = pageWidth - margin * 2;
  const columns = [
    { label: "N.", width: 20 },
    { label: "BASE", width: 61 },
    { label: "EMPRESA", width: 82 },
    { label: "TELEFONO", width: 57 },
    { label: "EQUIPO", width: 78 },
    { label: "HORA (LIMA)", width: 79 },
    { label: "INT.", width: 27 },
    { label: "CONTESTO", width: 52 },
    { label: "DURACION", width: 54 }
  ];
  const answeredRows = rows.filter(isAnsweredAttempt);
  const totalSeconds = rows.reduce((total, row) => total + Number(row.durationSeconds || 0), 0);
  const equipmentCounts = new Map();
  rows.forEach((row) => {
    const equipment = String(row.worker || "Sin equipo").trim() || "Sin equipo";
    equipmentCounts.set(equipment, (equipmentCounts.get(equipment) || 0) + 1);
  });

  let y = 0;
  let pageNumber = 0;
  const setTextColor = (hex) => documentPdf.setTextColor(hex);
  const clip = (value, max) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
  };
  const drawPageFrame = () => {
    pageNumber += 1;
    documentPdf.setFillColor("#fbf7fc");
    documentPdf.rect(0, 0, pageWidth, pageHeight, "F");
    documentPdf.setFillColor("#e800a8");
    documentPdf.rect(0, 0, pageWidth, 13, "F");
    if (logoData) documentPdf.addImage(logoData, "JPEG", margin, 22, 62, 42);
    documentPdf.setFont("helvetica", "bold");
    documentPdf.setFontSize(9);
    setTextColor("#6d087d");
    documentPdf.text("VC - GESTION DE LLAMADAS", logoData ? 104 : margin, 44);
    documentPdf.setFont("helvetica", "normal");
    documentPdf.setFontSize(7.5);
    setTextColor("#6b5b70");
    documentPdf.text(`Pagina ${pageNumber}`, pageWidth - margin, pageHeight - 18, { align: "right" });
    y = 78;
  };
  const ensureSpace = (height, continuationTitle = "DETALLE DEL REGISTRO") => {
    if (y + height <= pageHeight - 34) return false;
    documentPdf.addPage();
    drawPageFrame();
    documentPdf.setFont("helvetica", "bold");
    documentPdf.setFontSize(11);
    setTextColor("#59066b");
    documentPdf.text(continuationTitle, margin, y);
    y += 15;
    return true;
  };
  const drawTableHeader = () => {
    documentPdf.setFillColor("#650073");
    documentPdf.roundedRect(margin, y, tableWidth, 25, 3, 3, "F");
    documentPdf.setFont("helvetica", "bold");
    documentPdf.setFontSize(6.6);
    setTextColor("#ffffff");
    let x = margin;
    columns.forEach((column) => {
      documentPdf.text(column.label, x + 4, y + 16);
      x += column.width;
    });
    y += 25;
  };

  drawPageFrame();
  documentPdf.setFont("helvetica", "bold");
  documentPdf.setFontSize(21);
  setTextColor("#3d064d");
  documentPdf.text("REPORTE DE LLAMADAS", margin, y);
  y += 22;
  documentPdf.setFontSize(12);
  setTextColor("#c0008e");
  documentPdf.text(`Reporte: ${listName || "Sin nombre"}`, margin, y);
  documentPdf.setFont("helvetica", "normal");
  documentPdf.setFontSize(8);
  setTextColor("#6b5b70");
  documentPdf.text(`Generado: ${formatLimaReportDate(new Date())} (Lima - Peru)`, pageWidth - margin, y, { align: "right" });
  y += 27;

  const summary = [
    ["LLAMADAS", rows.length],
    ["CONTESTADAS", answeredRows.length],
    ["NO CONTESTADAS", Math.max(0, rows.length - answeredRows.length)],
    ["DURACION TOTAL", formatCallDuration(totalSeconds)]
  ];
  summary.forEach(([label, value], index) => {
    const x = margin + index * (tableWidth / 4);
    documentPdf.setFillColor("#f1e5f4");
    documentPdf.setDrawColor("#df38b1");
    documentPdf.roundedRect(x + 2, y, tableWidth / 4 - 8, 43, 5, 5, "FD");
    documentPdf.setFont("helvetica", "bold");
    documentPdf.setFontSize(7);
    setTextColor("#720565");
    documentPdf.text(label, x + 10, y + 14);
    documentPdf.setFontSize(14);
    setTextColor("#2e0738");
    documentPdf.text(String(value), x + 10, y + 33);
  });
  y += 62;

  documentPdf.setFont("helvetica", "bold");
  documentPdf.setFontSize(10);
  setTextColor("#59066b");
  documentPdf.text("CANTIDAD DE LLAMADAS POR EQUIPO", margin, y);
  y += 13;
  if (!equipmentCounts.size) {
    documentPdf.setFont("helvetica", "normal");
    documentPdf.setFontSize(8);
    setTextColor("#6b5b70");
    documentPdf.text("Todavia no hay llamadas registradas.", margin, y + 9);
    y += 25;
  } else {
    for (const [equipment, count] of equipmentCounts.entries()) {
      ensureSpace(22, "CANTIDAD DE LLAMADAS POR EQUIPO");
      documentPdf.setFillColor("#f5edf7");
      documentPdf.roundedRect(margin, y, tableWidth, 20, 3, 3, "F");
      documentPdf.setFont("helvetica", "bold");
      documentPdf.setFontSize(8);
      setTextColor("#2e0738");
      documentPdf.text(clip(equipment, 70), margin + 7, y + 13);
      setTextColor("#c0008e");
      documentPdf.text(`${count} llamada${count === 1 ? "" : "s"}`, margin + tableWidth - 7, y + 13, { align: "right" });
      y += 22;
    }
  }
  y += 17;
  documentPdf.setFont("helvetica", "bold");
  documentPdf.setFontSize(11);
  setTextColor("#59066b");
  documentPdf.text("DETALLE DEL REGISTRO", margin, y);
  y += 15;
  drawTableHeader();

  if (!rows.length) {
    documentPdf.setFont("helvetica", "normal");
    documentPdf.setFontSize(8.5);
    setTextColor("#6b5b70");
    documentPdf.text("No hay llamadas registradas para este reporte.", margin + 7, y + 18);
  } else {
    let previousWorker = "";
    rows.forEach((row, index) => {
      if (ensureSpace(28)) drawTableHeader();
      const currentWorker = String(row.worker || "Sin equipo");
      const currentList = String(row.list || "Sin lista");
      if (previousWorker && currentWorker !== previousWorker) {
        documentPdf.setDrawColor("#e800a8");
        documentPdf.setLineWidth(1.2);
        documentPdf.line(margin, y, margin + tableWidth, y);
      }
      previousWorker = currentWorker;
      if (index % 2) {
        documentPdf.setFillColor("#f6eef8");
        documentPdf.rect(margin, y, tableWidth, 24, "F");
      }
      const answered = isAnsweredAttempt(row);
      const values = [
        String(index + 1),
        clip(currentList, 13),
        clip(row.name || "Sin nombre", 18),
        clip(row.phone || "-", 12),
        clip(row.worker || "Sin equipo", 17),
        formatLimaReportDate(row.startedAt, true),
        String(row.attemptNumber || 1),
        answered ? "SI" : "NO",
        formatCallDuration(Number(row.durationSeconds || 0))
      ];
      let x = margin;
      documentPdf.setFontSize(6.8);
      values.forEach((value, valueIndex) => {
        documentPdf.setFont("helvetica", valueIndex === 0 || valueIndex === 7 ? "bold" : "normal");
        setTextColor(valueIndex === 7 ? (answered ? "#00845f" : "#cc075c") : "#24102b");
        documentPdf.text(value, x + 4, y + 15);
        x += columns[valueIndex].width;
      });
      documentPdf.setDrawColor("#e8cee9");
      documentPdf.setLineWidth(0.4);
      documentPdf.line(margin, y + 24, margin + tableWidth, y + 24);
      y += 24;
    });
  }

  return new Uint8Array(documentPdf.output("arraybuffer"));
}

async function createPairingQr() {
  if (!sessionCode || !dashboardToken) return;
  if (refs.addPairingQrBtn) refs.addPairingQrBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(sessionCode)}/pairing-slots`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Token": dashboardToken },
      body: "{}"
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo crear el QR.");
    await loadPairingData(sessionCode);
    setStatus("Nuevo código QR creado.", true);
  } catch (error) {
    setStatus(error.message || "No se pudo crear el QR.", true);
  } finally {
    if (refs.addPairingQrBtn) refs.addPairingQrBtn.disabled = false;
  }
}

async function deletePairingQr(slotId) {
  if (!sessionCode || !dashboardToken || !slotId) return;
  try {
    const res = await fetch(`${API_BASE}/api/session/${encodeURIComponent(sessionCode)}/pairing-slots/${encodeURIComponent(slotId)}`, {
      method: "DELETE",
      headers: { "X-Dashboard-Token": dashboardToken }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo eliminar el QR.");
    await loadPairingData(sessionCode);
    setStatus("Código QR eliminado.", true);
  } catch (error) {
    setStatus(error.message || "No se pudo eliminar el QR.", true);
  }
}

async function loadApkInfo() {
  try {
    const res = await fetch(`${API_BASE}/api/apk/info`, { cache: "no-store" });
    const info = await res.json();
    if (info.ok) {
      refs.apkNameEl.textContent = "VOIP VC Android";
      const sizeMb = Number(info.size || 0) / (1024 * 1024);
      const modified = new Date(info.modified);
      const buildDate = Number.isNaN(modified.getTime()) ? "" : new Intl.DateTimeFormat("es-PE", {
        timeZone: "America/Lima", day: "2-digit", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false
      }).format(modified);
      refs.apkMetaEl.textContent = `${sizeMb.toFixed(1)} MB${buildDate ? ` · Compilación ${buildDate} (Lima)` : ""}`;
      refs.apkDlBtn.href = `${API_BASE}/api/apk/download?build=${encodeURIComponent(info.modified || "")}`;
      refs.apkDlBtn.title = `Descargar ${info.name}`;
      return;
    }
    refs.apkMetaEl.textContent = "APK no disponible";
  } catch {
    refs.apkMetaEl.textContent = "No se pudo cargar la información del APK";
  }
}

// ── SOCKET HANDLERS ──────────────────────────────────────────────────
socket.on("call:error", ({message}) => setStatus(message || "No se permite llamar a este número.", true));
socket.on("state:changed", st => {
  updateSessionUi(st);
  renderShiftManagement();
  applyState(st.callState, st.lastNumber, st);
  renderContacts();
  const nextPairingSignature = JSON.stringify((st.phoneWorkers || []).map((worker) => [
    worker.id,
    Boolean(worker.connected),
    worker.callState || "idle",
    worker.companyName || "",
    worker.phoneNumber || "",
    Boolean(worker.speakerOn)
  ]));
  if (nextPairingSignature !== pairingStateSignature) {
    pairingStateSignature = nextPairingSignature;
    if (sessionCode) loadPairingData(sessionCode);
  }
});

function syncCampaignResultsToContacts() {
  const campaignContacts = Array.isArray(campaignState?.contacts) ? campaignState.contacts : [];
  let changed = false;
  for (const result of campaignContacts) {
    const local = Contacts.contacts.find((contact) => contact.id === result.id);
    if (!local) continue;
    local.campaignStatus = result.status || "";
    local.campaignResult = result.result || "";
    local.technicalResult = result.technicalResult || "";
    local.attempts = Number(result.attempts || 0);
    local.lastAttemptAt = result.lastAttemptAt || null;
    local.callDurationSeconds = Number(result.durationSeconds || 0);
    local.lastWorkerName = result.assignedWorkerName || local.lastWorkerName || "";
    changed = true;
  }
  if (changed) Contacts.saveContacts();
}

socket.on("campaign:state", st => {
  if (String(st?.listName || "") === "Pendientes del turno" && String(st?.status || "") === "running") {
    pendingRecoveryRunning = true;
  }
  const pendingCampaignFinished = pendingRecoveryRunning
    && String(st?.listName || "") === "Pendientes del turno"
    && String(st?.status || "") === "completed";
  campaignState = st;
  syncCampaignResultsToContacts();
  syncTurnPendingContacts();
  renderCampaignPanel();
  renderContacts();
  if (pendingCampaignFinished && !normalCampaignResumeRequested) {
    pendingRecoveryRunning = false;
    normalCampaignResumeRequested = true;
    setTimeout(async () => {
      try {
        await startCampaignRun();
      } finally {
        normalCampaignResumeRequested = false;
      }
    }, 400);
  }
});

setInterval(() => {
  if ((latestSessionState?.phoneWorkers || []).some((worker) => worker.callState === "in_call")) renderWorkersPanel();
}, 1000);

socket.on("session:created", ({ code, dashboardToken: createdToken }) => {
  autoSessionRequested = false;
  sessionCode = code;
  dashboardToken = String(createdToken || "");
  refs.sessionCodeIn.value = code;
  saveSessionCode(code, dashboardToken);
  updateSessionUi({ connected: { dashboard: true, phone: false } });
  loadPairingData(code);
  fetchCampaignState(code);
});

socket.on("session:joined", ({ code, role }) => {
  if (role === "dashboard") {
    sessionCode = code;
    refs.sessionCodeIn.value = code;
    saveSessionCode(code);
    updateSessionUi({ connected: { dashboard: true, phone: currentPhoneLinked } });
    loadPairingData(code);
    fetchCampaignState(code);
  }
});

socket.on("session:error", ({ message, reason }) => {
  if (["AUTH_REQUIRED", "AUTH_ORIGIN", "AUTH_UNAVAILABLE", "FORBIDDEN", "SESSION_FORBIDDEN", "WORKSPACE_UNAVAILABLE"].includes(reason)) {
    autoSessionRequested = false;
    setStatus(message || "No se pudo validar el acceso.", true);
    if (reason === "AUTH_REQUIRED") window.location.replace("/login");
    return;
  }
  if (sessionCode && !autoSessionRequested) {
    if (reason === "dashboard_in_use") {
      localStorage.removeItem(DASHBOARD_SESSION_KEY);
      localStorage.removeItem(`${DASHBOARD_TOKEN_PREFIX}${sessionCode}`);
      setStatus(message || "Recuperando el espacio de tu cuenta...", true);
    }
    sessionCode = "";
    dashboardToken = "";
    requestAutomaticSession();
    return;
  }
  autoSessionRequested = false;
  setStatus(message || "No se pudo cargar tu espacio de trabajo.", true);
});

socket.on("connect", () => {
  autoSessionRequested = false;
  requestAutomaticSession();
});

socket.on("phone:command_ack", ({ commandId, action, ok, message }) => {
  const timeoutId = pendingCommandTimeouts.get(commandId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    pendingCommandTimeouts.delete(commandId);
  }
  setAckBadge(
    refs.apkAckBadgeEl,
    ok ? "ok" : "error",
    ok ? `APK · ${action} ok` : `APK · ${action} error`
  );
  if (refs.callHintEl) {
    refs.callHintEl.textContent = message || (ok ? "Orden recibida por el celular." : "El celular rechazó la orden.");
  }
  if (!ok && action === "dial") {
    applyState("failed", callCtx?.phone || "");
  }
});

// START

/* ── HISTORY LOGIC ────────────────────────────────────── */
let callHistory = [];
function loadHistory() {
  callHistory = Contacts.getPreference("recentCalls", []);
}

function saveHistory() {
  Contacts.setPreference("recentCalls", callHistory);
}

function addHistoryEntry(phone, duration) {
  if (!phone) return;
  callHistory.unshift({
    phone,
    duration,
    timestamp: Date.now()
  });
  if (callHistory.length > 50) callHistory.pop();
  saveHistory();
}

function openHistory() {
  renderHistory();
  refs.historyModalEl.style.display = "flex";
}

async function clearHistory() {
  if (!await requestConfirmation({ title: "Limpiar historial", message: "¿Deseas eliminar todo el historial reciente?", confirmLabel: "Limpiar" })) return;
  callHistory = [];
  saveHistory();
  renderHistory();
}

function renderHistory() {
  const list = refs.historyListEl;
  if (!list) return;
  if (callHistory.length === 0) {
    list.innerHTML = `<div class="muted" style="text-align:center;padding:40px;">Sin llamadas recientes.</div>`;
    return;
  }
  list.innerHTML = callHistory.map(h => `
    <div class="history-item">
      <div class="history-info">
        <div class="history-phone">${escHtml(h.phone)}</div>
        <div class="history-meta">
          <span>📅 ${new Date(h.timestamp).toLocaleString()}</span>
          <span>⏱️ ${formatCallDuration(h.duration)}</span>
        </div>
      </div>
      <div class="history-actions">
        <button class="history-call-btn" onclick="dialFromHistory('${escHtml(h.phone)}')">📞 Llamar</button>
      </div>
    </div>
  `).join("");
}

window.dialFromHistory = (phone) => {
  refs.historyModalEl.style.display = "none";
  dialManual(phone, "Historial");
};

/* ── TABS LOGIC ────────────────────────────────────────── */
function renderTabs() {
  const container = refs.contactsTabsEl;
  if (!container) return;
  
  const lists = (Contacts.lists || []).filter((list) =>
    Contacts.contacts.some((contact) => (contact.list || "Principal") === list)
  );
  container.innerHTML = lists.map(list => `
    <div class="tab-item ${Contacts.activeList === list ? "active" : ""}" data-name="${escHtml(list)}">
      <span>${escHtml(list)}</span>
      ${list !== "Principal" ? `<button class="delete-tab-btn" data-list="${escHtml(list)}">×</button>` : ""}
    </div>
  `).join("");
  
  container.onclick = async (e) => {
    const tab = e.target.closest(".tab-item");
    const del = e.target.closest(".delete-tab-btn");
    
    if (del) {
      e.stopPropagation();
      const name = del.dataset.list;
      if (await requestConfirmation({ title: "Eliminar lista", message: `¿Eliminar la lista "${name}" y todos sus contactos?`, confirmLabel: "Eliminar" })) {
        Contacts.deleteList(name);
        renderTabs();
        renderContacts();
        renderCampaignPanel();
        if (sessionCode) loadPairingData(sessionCode);
      }
      return;
    }
    
    if (tab) {
      const name = tab.dataset.name;
      Contacts.setActiveList(name);
      renderTabs();
      renderContacts();
      renderCampaignPanel();
    }
  };
}

function dialManual(phone, name) {
  if (["dialing", "ringing", "in_call"].includes(currentState)) return;
  currentCallingContactId = null; 
  openCallWindow(phone, { contactName: name });
  emitCallActionWithAck("dial", { phoneNumber: phone, contactName: name });
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
            renderContacts();
            setStatus("Contacto actualizado.", true);
        }
    };
    
    refs.editCloseBtn.onclick = () => {
        refs.editModalEl.style.display = "none";
    };
    
    refs.editModalEl.style.display = "grid";
}

init();


