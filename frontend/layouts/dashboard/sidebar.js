import { panelPaths, showPanelView } from "../../app/navigation/panel-navigation.js";
import { currentUser, requireLogin, bindAccountControls } from "../../features/auth/auth-session.js";

const adminPaths = { network: "/nucleo-red", users: "/usuarios" };
const sectionForPath = path => Object.keys(panelPaths).find(view => panelPaths[view] === path)
  || Object.keys(adminPaths).find(view => adminPaths[view] === path)
  || (["/admin.html", "/legacy/admin"].includes(path) ? "network" : "calls");
const navigation = document.querySelector(".viavox-navigation");
const sidebar = document.getElementById("viavoxSidebar");
const toggle = document.querySelector(".viavox-menu-toggle");
const downloadArea = sidebar.querySelector(".viavox-downloads");
const accountArea = sidebar.querySelector(".viavox-account");
for (const id of ["apkDownloadBtn", "shizukuDownloadBtn"]) {
  const link = document.getElementById(id);
  if (link) downloadArea.append(link);
}
for (const id of ["accountIdentity", "logoutButton", "accountError"]) {
  const element = document.getElementById(id);
  if (element) accountArea.append(element);
}
let user = currentUser || null;
let adminPromise;
let adminNetwork;
let adminUsers;
let initNetwork;
let initUsers;
let viewRequest = 0;
let socketLibrary;

async function ensureDocumentReady() {
  if (document.readyState !== "loading") return;
  await new Promise(resolve => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
}

async function ensureSocketLibrary() {
  await ensureDocumentReady();
  if (window.io) return;
  if (!socketLibrary) socketLibrary = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${location.origin}/socket.io/socket.io.js`;
    script.onload = resolve;
    script.onerror = () => reject(new Error("No se pudo cargar Socket.IO."));
    document.head.append(script);
  });
  return socketLibrary;
}

function setActive(view) {
  for (const item of navigation.querySelectorAll("[data-view]")) {
    if (item.dataset.view === view) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

function setViewVisibility(view) {
  const workspace = document.getElementById("adminWorkspace");
  const operational = document.querySelector("main.layout");
  if (workspace) workspace.hidden = !adminPaths[view];
  if (operational) operational.hidden = Boolean(adminPaths[view]);
  if (adminNetwork) adminNetwork.hidden = view !== "network";
  if (adminUsers) adminUsers.hidden = view !== "users";
}

async function loadAdminWorkspace() {
  if (adminPromise) return adminPromise;
  adminPromise = (async () => {
    const response = await fetch("/features/admin/network/network.html", { credentials: "same-origin", cache: "force-cache" });
    if (response.status === 401) return window.location.replace("/login");
    if (response.status === 403) throw new Error("Esta sección requiere permisos de administrador.");
    if (!response.ok) throw new Error("No se pudo cargar la sección administrativa.");
    const source = new DOMParser().parseFromString(await response.text(), "text/html");
    const workspace = document.getElementById("adminWorkspace");
    const header = source.querySelector(".app-header");
    header?.querySelector(".account")?.remove();
    const brand = header?.querySelector(".brand");
    if (brand) {
      brand.href = "/llamadas";
      brand.dataset.view = "calls";
    }
    const candidates = [header, source.getElementById("networkView"), source.getElementById("usersView"), source.getElementById("editUserDialog")];
    if (candidates.some(item => !item)) throw new Error("La vista administrativa está incompleta.");
    workspace.replaceChildren(...candidates);
    workspace.addEventListener("click", event => {
      const link = event.target.closest("[data-view]");
      if (link) {
        event.preventDefault();
        navigate(link.dataset.view);
      }
    });
    adminNetwork = candidates[1];
    adminUsers = candidates[2];
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/features/admin/network/network.css?v=20261116-orbpoint";
    stylesheet.dataset.adminStyles = "1";
    document.head.append(stylesheet);
  })().catch(error => {
    adminPromise = null;
    throw error;
  });
  return adminPromise;
}

async function navigate(view, { history = true, scroll = true } = {}) {
  await ensureDocumentReady();
  if (!Object.hasOwn(panelPaths, view) && !(user?.role === "ADMINISTRADOR" && adminPaths[view])) view = "calls";
  const request = ++viewRequest;
  if (adminPaths[view]) {
    try {
      await loadAdminWorkspace();
    } catch (error) {
      const message = document.getElementById("accountError");
      if (message) message.textContent = error.message;
      return;
    }
  }
  if (!adminPaths[view]) await window.startOperationalDashboard?.();
  if (request !== viewRequest) return;
  if (view === "reports") {
    const reports = await import("../../features/reports/reports-page.js");
    if (request !== viewRequest) return;
    reports.showCalendar?.();
  } else if (view === "messages") {
    const whatsapp = await import("../../features/messaging/whatsapp.js");
    whatsapp.syncMessagesView?.();
    const templates = await import("../../features/messaging/message-templates.js");
    templates.init?.();
  } else if (view === "reservations") {
    const reservations = await import("../../features/reservations/reservations-controller.js");
    reservations.initReservationsView?.();
  } else if (view === "contacts" && user?.role === "ADMINISTRADOR") {
    const adminLists = await import("../../features/admin/admin-contact-lists.js");
    const section = document.getElementById("adminUserListsView");
    const contacts = document.getElementById("contactsSection");
    const data = document.getElementById("contactsDataSection");
    if (section) section.hidden = false;
    if (contacts) contacts.hidden = true;
    if (data) data.hidden = true;
    await adminLists.initAdminContactLists();
  } else if (view === "contacts") {
    const section = document.getElementById("adminUserListsView");
    const contacts = document.getElementById("contactsSection");
    const data = document.getElementById("contactsDataSection");
    if (section) section.hidden = true;
    if (contacts) contacts.hidden = false;
    if (data) data.hidden = false;
  }
  setViewVisibility(view);
  setActive(view);
  if (panelPaths[view]) showPanelView(view, { history });
  else if (history && location.pathname !== adminPaths[view]) window.history.pushState(null, "", adminPaths[view]);
  if (adminPaths[view]) {
    try {
      if (view === "network") {
        await ensureSocketLibrary();
        if (!initNetwork) initNetwork = (await import("../../features/admin/network/network-page.js")).initNetworkPage;
        await initNetwork?.();
      }
      if (view === "users") {
        if (!initUsers) initUsers = (await import("../../features/admin/users/users-page.js")).initUsersPage;
        await initUsers?.();
      }
    } catch (error) {
      const message = document.getElementById("accountError");
      if (message) message.textContent = error.message || "No se pudo abrir esta sección.";
    }
    if (request !== viewRequest) return;
    document.dispatchEvent(new CustomEvent("panel:view", { detail: view }));
    if (view === "users") window.showUsersPage?.();
  }
  if (request !== viewRequest) return;
  if (scroll) window.scrollTo({ top: 0 });
  sidebar?.classList.remove("is-open");
  toggle?.setAttribute("aria-expanded", "false");
}
document.addEventListener("panel:view", event => setActive(event.detail));

window.navigatePanel = navigate;
navigation.addEventListener("click", event => {
  const link = event.target.closest("[data-view]");
  if (!link) return;
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  if (link.id === "reportNavBtn" || link.id === "blockedNumbersOpen") return;
  event.preventDefault();
  navigate(link.dataset.view);
});
window.addEventListener("popstate", () => navigate(sectionForPath(location.pathname), { history: false, scroll: false }));
toggle?.addEventListener("click", () => {
  const open = sidebar.classList.toggle("is-open");
  toggle.setAttribute("aria-expanded", String(open));
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && sidebar?.classList.contains("is-open")) {
    sidebar.classList.remove("is-open");
    toggle?.setAttribute("aria-expanded", "false");
    toggle?.focus();
  }
});

requireLogin().then(async authenticatedUser => {
  user = authenticatedUser;
  bindAccountControls();
  const networkLink = document.getElementById("adminLink");
  const usersLink = document.getElementById("sidebarUsers");
  const isAdmin = user.role === "ADMINISTRADOR";
  if (networkLink) networkLink.hidden = !isAdmin;
  if (usersLink) usersLink.hidden = !isAdmin;
  document.documentElement.classList.remove("auth-pending");
  const initial = sectionForPath(location.pathname);
  await navigate(initial, { history: false, scroll: false });
}).catch(error => {
  document.documentElement.classList.remove("auth-pending");
  const status = document.getElementById("accountError");
  if (status) status.textContent = error?.message || "No se pudo validar la sesión.";
});
