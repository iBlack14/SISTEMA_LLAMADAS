import { panelPaths, showPanelView } from "../../app/navigation/panel-navigation.js";
import { currentUser, requireLogin, bindAccountControls } from "../../features/auth/auth-session.js?v=20261119-users-ui3";

const adminPaths = { network: "/nucleo-red", users: "/usuarios", settings: "/configuracion", voice: "/voz" };
const sectionForPath = path => Object.keys(panelPaths).find(view => panelPaths[view] === path)
  || Object.keys(adminPaths).find(view => adminPaths[view] === path)
  || (["/admin.html", "/legacy/admin"].includes(path) ? "network" : "calls");
const navigation = document.querySelector(".viavox-navigation");
const sidebar = document.getElementById("viavoxSidebar");
const toggle = document.querySelector(".viavox-menu-toggle");
const downloadArea = sidebar.querySelector(".viavox-downloads");
const accountArea = sidebar.querySelector(".viavox-account");
const sidebarIconShapes = {
  calls: [["path", { d: "M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.35 1.9.7 2.8a2 2 0 0 1-.45 2.1L8.1 9.9a16 16 0 0 0 6 6l1.28-1.27a2 2 0 0 1 2.1-.45c.9.35 1.84.58 2.8.7A2 2 0 0 1 22 16.92Z" }]],
  contacts: [["rect", { x: "4", y: "3", width: "16", height: "18", rx: "2" }], ["path", { d: "M8 8h8M8 12h8M8 16h5" }]],
  reports: [["rect", { x: "3", y: "4", width: "18", height: "17", rx: "2" }], ["path", { d: "M16 2v4M8 2v4M3 9h18M8 13h2M14 13h2M8 17h2" }]],
  reservations: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "M12 7v5l3 2M8 2 6 4M16 2l2 2" }]],
  blocked: [["circle", { cx: "12", cy: "12", r: "9" }], ["path", { d: "m5.6 5.6 12.8 12.8" }]],
  messages: [["path", { d: "M20 11.5a7.5 7.5 0 0 1-7.5 7.5H7l-4 2 1.4-4A7.5 7.5 0 1 1 20 11.5Z" }], ["path", { d: "M8 11.5h.01M12 11.5h.01M16 11.5h.01" }]],
  network: [["circle", { cx: "12", cy: "5", r: "2.5" }], ["circle", { cx: "5", cy: "18", r: "2.5" }], ["circle", { cx: "19", cy: "18", r: "2.5" }], ["path", { d: "m10.8 7.2-4.6 8.6M13.2 7.2l4.6 8.6M7.5 18h9" }]],
  users: [["path", { d: "M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" }], ["circle", { cx: "10", cy: "7", r: "4" }], ["path", { d: "M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" }]],
  voice: [["path", { d: "M4 10v4m4-7v10m4-14v18m4-14v10m4-7v4" }]],
  settings: [["circle", { cx: "12", cy: "12", r: "3" }], ["path", { d: "M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.6.77 1 1.41 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" }]]
};
const svgNamespace = "http://www.w3.org/2000/svg";
for (const item of navigation.querySelectorAll("[data-view]")) {
  const shapes = sidebarIconShapes[item.dataset.view];
  if (!shapes) continue;
  const holder = document.createElement("span");
  holder.className = "viavox-nav-icon";
  holder.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "viavox-nav-icon-art");
  svg.setAttribute("focusable", "false");
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(svgNamespace, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  holder.append(svg);
  item.prepend(holder);
}
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
let adminSettings;
let adminVoice;
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
  if (adminSettings) adminSettings.hidden = view !== "settings";
  if (adminVoice) {
    adminVoice.hidden = view !== "voice";
    if (adminVoice.hidden) adminVoice.querySelector("audio")?.pause();
  }
}

async function loadAdminWorkspace() {
  if (adminPromise) return adminPromise;
  adminPromise = (async () => {
    const response = await fetch("/features/admin/network/network.html", { credentials: "same-origin", cache: "no-cache" });
    if (response.status === 401) return window.location.replace("/login");
    if (response.status === 403) throw new Error("Esta sección requiere permisos de administrador.");
    if (!response.ok) throw new Error("No se pudo cargar la sección administrativa.");
    const source = new DOMParser().parseFromString(await response.text(), "text/html");
    const workspace = document.getElementById("adminWorkspace");
    const candidates = [source.getElementById("networkView"), source.getElementById("usersView"), source.getElementById("settingsView"), source.getElementById("editUserDialog"), source.getElementById("voiceView")];
    if (candidates.some(item => !item)) throw new Error("La vista administrativa está incompleta.");
    workspace.replaceChildren(...candidates);
    workspace.addEventListener("click", event => {
      const link = event.target.closest("[data-view]");
      if (link) {
        event.preventDefault();
        navigate(link.dataset.view);
      }
    });
    adminNetwork = candidates[0];
    adminUsers = candidates[1];
    adminSettings = candidates[2];
    adminVoice = candidates[4];
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    const networkCss = source.querySelector('link[rel="stylesheet"][href*="network.css"]');
    stylesheet.href = networkCss?.getAttribute("href") || "/features/admin/network/network.css?v=20261119-users-ui3";
    stylesheet.dataset.adminStyles = "1";
    document.head.append(stylesheet);
    const voiceStylesheet = document.createElement("link");
    voiceStylesheet.rel = "stylesheet";
    voiceStylesheet.href = "/features/admin/voice/voice.css?v=20261124-voice-ui3";
    document.head.append(voiceStylesheet);
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
    const reports = await import("../../features/reports/reports-page.js?v=20261124-voice-ui5");
    if (request !== viewRequest) return;
    reports.showCalendar?.();
  } else if (view === "messages") {
    const whatsapp = await import("../../features/messaging/whatsapp.js");
    whatsapp.syncMessagesView?.();
    const templates = await import("../../features/messaging/message-templates.js?v=20261125-direct-number1");
    templates.init?.();
  } else if (view === "reservations") {
    const reservations = await import("../../features/reservations/reservations-controller.js");
    reservations.initReservationsView?.();
  } else if (view === "contacts" && user?.role === "ADMINISTRADOR") {
    const section = document.getElementById("adminUserListsView");
    const contacts = document.getElementById("contactsSection");
    const data = document.getElementById("contactsDataSection");
    if (section) section.hidden = false;
    if (contacts) contacts.hidden = true;
    if (data) data.hidden = true;
    setViewVisibility(view);
    setActive(view);
    if (panelPaths[view]) showPanelView(view, { history });
    try {
      const adminLists = await import("../../features/admin/admin-contact-lists.js?v=20261126-admin-monthly-lists");
      await adminLists.initAdminContactLists();
    } catch (error) {
      const status = document.getElementById("adminListsStatus");
      if (status) status.textContent = error?.message || "No se pudieron cargar las listas de vendedores.";
    }
  } else if (view === "contacts") {
    const section = document.getElementById("adminUserListsView");
    const contacts = document.getElementById("contactsSection");
    const data = document.getElementById("contactsDataSection");
    if (section) section.hidden = true;
    if (contacts) contacts.hidden = false;
    if (data) data.hidden = false;
    const listSearch = document.getElementById("contactsListSearch");
    if (listSearch) listSearch.value = "";
    window.dispatchEvent(new Event("contacts:lists-refresh"));
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
        if (!initUsers) initUsers = (await import("../../features/admin/users/users-page.js?v=20261124-voice-ui4")).initUsersPage;
        await initUsers?.();
      }
      if (view === "settings") {
        const settings = await import("../../features/admin/settings/email-settings-page.js?v=20261119-users-ui3");
        await settings.initEmailSettingsPage?.();
      }
      if (view === "voice") {
        const voice = await import("../../features/admin/voice/voice.js?v=20261124-voice-ui3");
        if (request !== viewRequest) return;
        await voice.openVoicePanel(adminVoice);
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
  if (link.dataset.view === "voice" && !document.getElementById("adminWorkspace")) return;
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
  const settingsLink = document.getElementById("sidebarSettings");
  const isAdmin = user.role === "ADMINISTRADOR";
  if (networkLink) networkLink.hidden = !isAdmin;
  if (usersLink) usersLink.hidden = !isAdmin;
  if (settingsLink) settingsLink.hidden = !isAdmin;
  const voiceLink = document.getElementById("sidebarVoice");
  if (voiceLink) voiceLink.hidden = !isAdmin;
  document.documentElement.classList.remove("auth-pending");
  const initial = sectionForPath(location.pathname);
  await navigate(initial, { history: false, scroll: false });
}).catch(error => {
  document.documentElement.classList.remove("auth-pending");
  const status = document.getElementById("accountError");
  if (status) status.textContent = error?.message || "No se pudo validar la sesión.";
});
