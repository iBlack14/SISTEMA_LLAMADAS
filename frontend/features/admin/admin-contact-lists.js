import { apiFetch, currentUser } from "../auth/auth-session.js";

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function mapRowByHeaders(row, headers) {
  const out = {}; headers.forEach((header, index) => { out[header] = row[index]; }); return out;
}
function buildContactFromStructuredRow(row, fallbackIndex) {
  const entries = Object.entries(row || {});
  const normalized = Object.fromEntries(entries.map(([key, value]) => [normalizeHeader(key), String(value || "").trim()]));
  const rawName = normalized.name || normalized.nombre || normalized.company || normalized.empresa || normalized.businessname || "";
  const rawPhone = normalized.mobilenumber || normalized.mobile || normalized.phone || normalized.telefono || normalized.telefono1 || normalized.celular || normalized.whatsapp || normalized.tel || "";
  const rawWebsite = normalized.website || normalized.web || normalized.url || normalized.sitio || "";
  const fallbackValues = entries.map(([, value]) => String(value || "").trim()).filter(Boolean);
  const detectedPhone = rawPhone || fallbackValues.find(v => /\+?\d[\d\s().-]{5,}/.test(v)) || "";
  if (!detectedPhone) return null;
  const detectedName = rawName || fallbackValues.find(v => !/\+?\d[\d\s().-]{5,}/.test(v) && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(v) && !/^https?:\/\//i.test(v) && !/^tel:/i.test(v)) || `Contacto ${fallbackIndex + 1}`;
  const noteParts = []; if (rawWebsite) noteParts.push(rawWebsite);
  for (const value of fallbackValues) { if (value === detectedName || value === detectedPhone || value === rawWebsite) continue; if (!noteParts.includes(value)) noteParts.push(value); }
  return { id: crypto.randomUUID(), name: detectedName, phone: detectedPhone.replace(/\D/g, ""), note: noteParts.join(" ").trim() };
}
function buildContactFromTableArrayRow(row, fallbackIndex) {
  const values = (row || []).map((value) => String(value || "").trim()); if (!values.length) return null;
  const first = values[0] || "", second = values[1] || "", third = values[2] || "", fourth = values[3] || "";
  const firstIsPhone = /\+?\d[\d\s().-]{5,}/.test(first), secondIsPhone = /\+?\d[\d\s().-]{5,}/.test(second);
  const detectedName = !firstIsPhone && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(first) ? first : (!secondIsPhone && /[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(second) ? second : `Contacto ${fallbackIndex + 1}`);
  const detectedPhone = secondIsPhone ? second : (firstIsPhone ? first : ""); if (!detectedPhone) return null;
  const noteParts = [third, fourth].map((value) => String(value || "").trim()).filter(Boolean);
  return { id: crypto.randomUUID(), name: detectedName, phone: detectedPhone.replace(/\D/g, ""), note: noteParts.join(" ").trim() };
}
function extractContactsFromHtmlTable(doc) {
  const tables = [...doc.querySelectorAll("table")];
  for (const table of tables) {
    const rows = [...table.querySelectorAll("tr")]; if (rows.length < 2) continue;
    const headerCells = [...rows[0].querySelectorAll("th,td")].map((cell) => normalizeHeader(cell.textContent || ""));
    const nameIdx = headerCells.findIndex((header) => ["name", "nombre", "company", "empresa", "businessname"].includes(header));
    const phoneIdx = headerCells.findIndex((header) => ["mobilenumber", "mobile", "phone", "telefono", "celular", "tel", "whatsapp"].includes(header));
    const websiteIdx = headerCells.findIndex((header) => ["website", "web", "url", "sitio"].includes(header));
    if (nameIdx === -1 && phoneIdx === -1) continue;
    const contacts = [];
    for (const row of rows.slice(1)) {
      const cols = [...row.querySelectorAll("th,td")].map((cell) => String(cell.textContent || "").trim()); if (!cols.some(Boolean)) continue;
      const name = String(cols[nameIdx] || "").trim(); const phone = cols[phoneIdx]?.replace(/\D/g, "") || ""; const website = websiteIdx >= 0 ? String(cols[websiteIdx] || "").trim() : "";
      if (!phone) continue; contacts.push({ id: crypto.randomUUID(), name: name || `Contacto ${contacts.length + 1}`, phone, note: website });
    } if (contacts.length) return contacts;
  } return [];
}
function extractContactsFromRows(rows) {
  const out = []; const list = rows || []; if (!list.length) return out;
  const firstRow = list[0]; const headerCandidates = Array.isArray(firstRow) ? firstRow.map(normalizeHeader) : Object.keys(firstRow || {}).map(normalizeHeader);
  const hasStructuredHeaders = headerCandidates.some((header) => ["name", "nombre", "mobilenumber", "mobile", "phone", "telefono", "celular", "website", "web", "url"].includes(header));
  const structuredRows = hasStructuredHeaders ? list.slice(1).map((row) => Array.isArray(row) ? mapRowByHeaders(row, firstRow) : row) : list;
  for (const row of structuredRows) {
    if (Array.isArray(row)) { const tableContact = buildContactFromTableArrayRow(row, out.length); if (tableContact?.phone) { out.push(tableContact); continue; } }
    const contact = buildContactFromStructuredRow(row, out.length); if (!contact?.phone) continue; out.push(contact);
  } return out;
}
function parseDelimitedText(text) {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const rows = lines.map((line) => { if (line.includes("\t")) return line.split("\t"); if (line.includes(";")) return line.split(";"); return line.split(","); });
  return extractContactsFromRows(rows);
}

let initialized = false;
let users = [];
let pageOffset = 0;
const pageSize = 100;
let totalContacts = 0;
let contactRequest = 0;
let importPreviewData = [];
const $ = id => document.getElementById(id);

export async function initAdminContactLists() {
  const view = $("adminUserListsView");
  const authUser = currentUser || window.VOIP_VC_AUTH_USER;
  if (!view || authUser?.role !== "ADMINISTRADOR") return;
  view.hidden = false;
  $("contactsSection").hidden = true;
  $("contactsDataSection").hidden = true;
  if (!initialized) {
    initialized = true;
    $("adminListsUser").addEventListener("change", onUserChange);
    $("adminListsName").addEventListener("change", () => { pageOffset = 0; loadContacts(); });
    $("adminListsPrev").addEventListener("click", () => { pageOffset = Math.max(0, pageOffset - pageSize); loadContacts(); });
    $("adminListsNext").addEventListener("click", () => { pageOffset += pageSize; loadContacts(); });
    $("adminListsImportFile").addEventListener("change", onImportFileChange);
    $("adminListsImportBtn").addEventListener("click", showImportPreview);
    $("adminListsImportCancel").addEventListener("click", hideImportPreview);
    $("adminListsImportConfirm").addEventListener("click", confirmImport);
  }
  if (!users.length) await loadUsers();
}

export function showAdminContactListsError(message) {
  const view = $("adminUserListsView");
  const contacts = $("contactsSection");
  const contactsData = $("contactsDataSection");
  if (view) view.hidden = false;
  if (contacts) contacts.hidden = true;
  if (contactsData) contactsData.hidden = true;
  const status = $("adminListsStatus");
  if (status) status.textContent = message || "No se pudieron cargar las listas de usuarios.";
}

async function loadUsers() {
  const status = $("adminListsStatus");
  status.textContent = "Cargando usuarios y listas…";
  try {
    const response = await apiFetch("/api/users/lists", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar los usuarios.");
    users = data.users;
    const select = $("adminListsUser");
    select.replaceChildren(new Option("Selecciona un usuario", ""));
    for (const user of users) select.add(new Option(`${user.username} · ${user.role === "ADMINISTRADOR" ? "Administrador" : "Ventas"}`, String(user.id)));
    status.textContent = users.length ? "Selecciona un usuario para ver sus listas." : "No hay usuarios registrados.";
  } catch (error) {
    status.textContent = error.message || "No se pudieron cargar los usuarios.";
  }
}

function onUserChange() {
  contactRequest++;
  const user = users.find(item => String(item.id) === $("adminListsUser").value);
  const select = $("adminListsName");
  select.replaceChildren(new Option(user?.lists.length ? "Selecciona una lista" : "Este usuario no tiene listas", ""));
  for (const list of user?.lists || []) select.add(new Option(`${list.name} (${list.count})`, list.name));
  select.disabled = !user?.lists.length;
  $("adminListsContacts").replaceChildren();
  $("adminListsPage").textContent = "";
  $("adminListsPrev").disabled = true;
  $("adminListsNext").disabled = true;
  pageOffset = 0;
  $("adminListsStatus").textContent = user?.lists.length ? "Selecciona una lista." : "No hay listas para esta cuenta.";
}

async function loadContacts() {
  const userId = $("adminListsUser").value;
  const list = $("adminListsName").value;
  if (!userId || !list) return;
  const status = $("adminListsStatus");
  const request = ++contactRequest;
  status.textContent = "Cargando contactos…";
  $("adminListsPrev").disabled = true;
  $("adminListsNext").disabled = true;
  try {
    const query = new URLSearchParams({ list, offset: String(pageOffset), limit: String(pageSize) });
    const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}/contact-book?${query}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar los contactos.");
    if (request !== contactRequest) return;
    totalContacts = Number(data.total || 0);
    const body = $("adminListsContacts");
    body.replaceChildren();
    if (data.contacts.length) {
      for (const contact of data.contacts) {
        const row = document.createElement("tr");
        for (const value of [contact.name, contact.phone, contact.note]) {
          const cell = document.createElement("td");
          cell.textContent = value || "";
          row.appendChild(cell);
        }
        body.appendChild(row);
      }
    }
    const pages = Math.max(1, Math.ceil(totalContacts / pageSize));
    const currentPage = Math.floor(pageOffset / pageSize) + 1;
    $("adminListsPage").textContent = `${totalContacts.toLocaleString("es-PE")} contactos · página ${currentPage} de ${pages}`;
    $("adminListsPrev").disabled = pageOffset === 0;
    $("adminListsNext").disabled = pageOffset + pageSize >= totalContacts;
    status.textContent = totalContacts ? "" : "Esta lista no tiene contactos.";
  } catch (error) {
    if (request !== contactRequest) return;
    status.textContent = error.message || "No se pudieron cargar los contactos.";
  }
}

function onImportFileChange(event) {
  const file = event.target.files?.[0];
  const btn = $("adminListsImportBtn");
  if (file) {
    btn.disabled = false;
    btn.textContent = `⬆️ Importar ${file.name}`;
  } else {
    btn.disabled = true;
    btn.textContent = "⬆️ Importar contactos";
  }
}

function showImportPreview() {
  const file = $("adminListsImportFile").files?.[0];
  const list = $("adminListsName").value;
  if (!file || !list) return;
  const status = $("adminListsStatus");
  status.textContent = "Procesando archivo…";
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = e.target.result;
      let contacts = [];
      if (file.name.endsWith(".html") || file.name.endsWith(".htm")) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, "text/html");
        contacts = extractContactsFromHtmlTable(doc);
      } else {
        const text = new TextDecoder("utf-8").decode(content);
        contacts = parseDelimitedText(text);
      }
      if (!contacts.length) {
        status.textContent = "No se detectaron contactos válidos en el archivo.";
        return;
      }
      importPreviewData = contacts.map(c => ({ ...c, list }));
      renderImportPreview();
      $("adminListsImportPreview").style.display = "block";
      status.textContent = `${contacts.length} contactos detectados. Revisa y confirma.`;
    } catch (error) {
      status.textContent = "Error al leer archivo: " + error.message;
    }
  };
  reader.readAsArrayBuffer(file);
}

function renderImportPreview() {
  const body = $("adminListsImportPreviewBody");
  body.replaceChildren();
  for (const c of importPreviewData.slice(0, 200)) {
    const row = document.createElement("tr");
    for (const value of [c.name, c.phone, c.note || "", c.list]) {
      const cell = document.createElement("td");
      cell.textContent = value || "";
      row.appendChild(cell);
    }
    body.appendChild(row);
  }
  if (importPreviewData.length > 200) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.style.textAlign = "center";
    cell.style.color = "var(--muted)";
    cell.textContent = `… y ${importPreviewData.length - 200} más`;
    row.appendChild(cell);
    body.appendChild(row);
  }
}

function hideImportPreview() {
  importPreviewData = [];
  $("adminListsImportPreview").style.display = "none";
  $("adminListsImportFile").value = "";
  $("adminListsImportBtn").disabled = true;
  $("adminListsImportBtn").textContent = "⬆️ Importar contactos";
}

async function confirmImport() {
  const userId = $("adminListsUser").value;
  const list = $("adminListsName").value;
  if (!userId || !list || !importPreviewData.length) return;
  const status = $("adminListsStatus");
  const btn = $("adminListsImportConfirm");
  btn.disabled = true;
  btn.textContent = "Importando…";
  status.textContent = "Importando contactos…";
  try {
    const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}/contact-book/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list, contacts: importPreviewData })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Error al importar");
    status.textContent = `✅ ${data.added} contactos importados a la lista "${list}".`;
    hideImportPreview();
    loadContacts();
  } catch (error) {
    status.textContent = "Error: " + error.message;
    btn.disabled = false;
    btn.textContent = "Confirmar importación";
  }
}
