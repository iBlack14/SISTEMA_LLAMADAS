import { apiFetch, currentUser } from "../auth/auth-session.js";

let initialized = false;
let users = [];
let pageOffset = 0;
const pageSize = 100;
let totalContacts = 0;
let contactRequest = 0;
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
