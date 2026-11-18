import { apiFetch, currentUser, requireLogin } from "../auth/auth-session.js";

// Spinner animation for import feedback
if (!document.getElementById("admin-import-spinner-style")) {
  const style = document.createElement("style");
  style.id = "admin-import-spinner-style";
  style.textContent = `
@keyframes spin { to { transform: rotate(360deg); } }
`;
  document.head.appendChild(style);
}

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
  if (status) status.textContent = message || "No se pudieron cargar las listas de vendedores.";
}

async function loadUsers() {
  const status = $("adminListsStatus");
  status.textContent = "Cargando vendedores…";
  try {
    // Ensure currentUser is populated (sidebar may call us before auth completes)
    if (!currentUser) {
      try { await requireLogin(); } catch { /* ignore, will use window.VOIP_VC_AUTH_USER */ }
    }
    const response = await apiFetch("/api/users/lists", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar los vendedores.");
    users = data.users;
    const select = $("adminListsUser");
    select.replaceChildren(new Option("— Mis listas —", "mine"));
    const myId = currentUser?.id || window.VOIP_VC_AUTH_USER?.id;
    for (const user of users) {
      const isMe = myId && String(user.id) === String(myId);
      select.add(new Option(`${user.username}${isMe ? " (tú)" : ""} · ${user.role === "ADMINISTRADOR" ? "Admin" : "Vendedor"}`, String(user.id)));
    }
    // Auto-select "Mis listas" by default
    select.value = "mine";
    onUserChange();
    status.textContent = users.length ? "Elige un vendedor para ver sus listas." : "Solo tú tienes acceso.";
  } catch (error) {
    status.textContent = error.message || "No se pudieron cargar los vendedores.";
  }
}

function onUserChange() {
  contactRequest++;
  const userId = $("adminListsUser").value;
  const user = users.find(item => String(item.id) === userId);
  const select = $("adminListsName");
  const status = $("adminListsStatus");
  
  if (userId === "mine" || !userId) {
    // Show current user's lists
    status.textContent = "Tus listas de contactos.";
    select.replaceChildren(new Option("Principal (tus contactos)", "Principal"));
    select.disabled = false;
    pageOffset = 0;
    loadContacts();
    return;
  }
  
  if (!user?.lists?.length) {
    // Auto-create "Principal" list via backend on first import
    select.replaceChildren(new Option("Principal (nueva)", "Principal"));
    select.disabled = false;
    status.textContent = `Sin listas. Se creará 'Principal' al importar en ${user.username}.`;
  } else {
    select.replaceChildren(new Option("Selecciona lista", ""));
    for (const list of user.lists) select.add(new Option(`${list.name} (${list.count})`, list.name));
    select.disabled = false;
    status.textContent = `Listas de ${user.username}. Elige una.`;
  }
  $("adminListsContacts").replaceChildren();
  $("adminListsPage").textContent = "";
  $("adminListsPrev").disabled = true;
  $("adminListsNext").disabled = true;
  pageOffset = 0;
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
    // Use "me" for current user's session
    const apiUserId = userId === "mine" ? "me" : userId;
    const response = await apiFetch(`/api/users/${encodeURIComponent(apiUserId)}/contact-book?${query}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar los contactos.");
    if (request !== contactRequest) return;
    totalContacts = Number(data.total || 0);
    const body = $("adminListsContacts");
    body.replaceChildren();
    const monthsShort = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    function formatDate(dateStr) {
      if (!dateStr) return "";
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return "";
      return `${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
    }
    if (data.contacts.length) {
      for (const contact of data.contacts) {
        const row = document.createElement("tr");
        for (const value of [contact.company || contact.name, contact.phone, formatDate(contact.createdAt)]) {
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
    status.textContent = error.message || "No se pudieron cargar los contactos."
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
  if (!file || !list) {
    console.warn("[IMPORT] Missing file or list", { file: !!file, list });
    return;
  }
  const status = $("adminListsStatus");
  status.textContent = "Procesando archivo…";
  console.log("[IMPORT] Reading file", file.name, file.type, file.size);
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = e.target.result;
      let contacts = [];
      if (file.name.endsWith(".html") || file.name.endsWith(".htm")) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(content, "text/html");
        contacts = extractContactsFromHtmlTable(doc);
      } else if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls")) {
        // Load SheetJS dynamically
        if (!window.XLSX) {
          status.textContent = "Cargando lector Excel…";
          await loadSheetJS();
        }
        const workbook = window.XLSX.read(content, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const json = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        contacts = extractContactsFromRows(json);
      } else {
        const text = new TextDecoder("utf-8").decode(content);
        contacts = parseDelimitedText(text);
      }
      console.log("[IMPORT] Parsed contacts:", contacts.length);
      if (!contacts.length) {
        status.textContent = "No se detectaron contactos válidos. Verifica que el archivo tenga columnas nombre y teléfono.";
        return;
      }
      importPreviewData = contacts.map(c => ({ ...c, list }));
      renderImportPreview();
      $("adminListsImportPreview").style.display = "block";
      status.textContent = `${contacts.length} contactos detectados. Revisa y confirma.`;
    } catch (error) {
      console.error("[IMPORT] Parse error:", error);
      status.textContent = "Error al leer archivo: " + error.message;
    }
  };
  reader.onerror = () => {
    console.error("[IMPORT] FileReader error");
    status.textContent = "Error leyendo el archivo.";
  };
  reader.readAsArrayBuffer(file);
}

function loadSheetJS() {
  return new Promise((resolve, reject) => {
    if (window.XLSX) return resolve();
    const script = document.createElement("script");
    script.src = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
    script.onload = () => { console.log("[IMPORT] SheetJS loaded"); resolve(); };
    script.onerror = () => reject(new Error("No se pudo cargar librería Excel"));
    document.head.appendChild(script);
  });
}

function renderImportPreview() {
  const body = $("adminListsImportPreviewBody");
  body.replaceChildren();
  const monthsShort = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  function formatDate(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "";
    return `${d.getDate()} ${monthsShort[d.getMonth()]} ${d.getFullYear()}`;
  }
  for (const c of importPreviewData.slice(0, 200)) {
    const row = document.createElement("tr");
    for (const value of [c.company || c.name, c.phone, formatDate(c.createdAt), c.list]) {
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
  if (!userId || !list || !importPreviewData.length) {
    console.warn("[IMPORT] Missing data for confirm", { userId, list, count: importPreviewData.length });
    return;
  }
  const status = $("adminListsStatus");
  const btn = $("adminListsImportConfirm");
  const cancelBtn = $("adminListsImportCancel");
  btn.disabled = true;
  cancelBtn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="display:inline-block;width:14px;height:14px;border:2px solid #fff;border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px"></span> Guardando en servidor…';
  status.innerHTML = '<span class="spinner" style="display:inline-block;width:14px;height:14px;border:2px solid var(--primary);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:8px"></span> Importando contactos…';
  console.log("[IMPORT] Sending to backend", { userId, list, count: importPreviewData.length });
  try {
    const response = await apiFetch(`/api/users/${encodeURIComponent(userId)}/contact-book/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list, contacts: importPreviewData })
    });
    const data = await response.json();
    console.log("[IMPORT] Backend response:", data);
    if (!response.ok || !data.ok) throw new Error(data.error || "Error al importar");
    status.textContent = `✅ ${data.added} contactos importados a la lista "${list}".`;
    hideImportPreview();
    loadContacts();
  } catch (error) {
    console.error("[IMPORT] Error:", error);
    status.textContent = "Error: " + error.message;
    btn.disabled = false;
    cancelBtn.disabled = false;
    btn.textContent = "Confirmar importación";
  }
}
