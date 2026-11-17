import { panelPaths, showPanelView } from "../../app/navigation/panel-navigation.js";

const isAdmin = location.pathname.startsWith("/nucleo-red") || location.pathname.startsWith("/usuarios");
const sidebar = document.createElement("aside");
sidebar.id = "viavoxSidebar";
sidebar.className = "viavox-sidebar";
sidebar.setAttribute("aria-label", "Menú principal");
sidebar.innerHTML = `
  <a class="viavox-brand" href="/" aria-label="ViaVox, inicio">
    <img src="/shared/assets/images/logo-vc-color.png" alt="Logo VIAVOX" width="52" height="36">
    <span><strong>VIAVOX</strong><small>GESTIÓN DE LLAMADAS</small></span>
  </a>
  <nav class="viavox-navigation" aria-label="Navegación">
    <a class="viavox-nav-item" data-view="calls" href="/llamadas">LLAMADAS</a>
    <a class="viavox-nav-item" data-view="contacts" href="/contactos">RUBRO Y LISTA</a>
    <a class="viavox-nav-item" data-view="reports" href="/reportes">CALENDARIO</a>
    <a class="viavox-nav-item" data-view="reservations" href="/reservas">RESERVA DE CONTACTO</a>
    <a class="viavox-nav-item" data-view="blocked" href="/bloqueos">PANEL DE BLOQUEOS</a>
    <a class="viavox-nav-item" data-view="messages" href="/mensajes">PANEL DE MENSAJES</a>
  </nav>
  <div class="viavox-sidebar-footer">
    <div class="viavox-downloads"></div>
    <div class="viavox-account"></div>
  </div>`;
const toggle = document.createElement("button");
toggle.type = "button";
toggle.className = "viavox-menu-toggle";
toggle.textContent = "☰ MENÚ";
toggle.setAttribute("aria-controls", sidebar.id);
toggle.setAttribute("aria-expanded", "false");
document.body.prepend(toggle, sidebar);
document.body.classList.add("has-viavox-sidebar");
const navigation = sidebar.querySelector("nav");
const downloads = sidebar.querySelector(".viavox-downloads");
const account = sidebar.querySelector(".viavox-account");
const move = (id, parent) => {
  const element = document.getElementById(id);
  if (element) parent.append(element);
  return element;
};
// Reuse the original controls so their existing event handlers stay attached.
if (!isAdmin) {
  for (const [id, view] of [["reportNavBtn", "reports"], ["blockedNumbersOpen", "blocked"]]) {
    const button = document.getElementById(id);
    const placeholder = navigation.querySelector(`[data-view="${view}"]`);
    if (button && placeholder) {
      button.className = "viavox-nav-item";
      button.dataset.view = view;
      button.textContent = view === "reports" ? "CALENDARIO" : "PANEL DE BLOQUEOS";
      placeholder.replaceWith(button);
    }
  }
}
const adminLink = move("adminLink", navigation);
if (!adminLink && isAdmin) {
  const link = document.createElement("a");
  link.id = "adminLink";
  link.href = "/nucleo-red";
  link.textContent = "NÚCLEO DE RED";
  link.dataset.view = "network";
  link.addEventListener("click", event => {
    event.preventDefault();
    if (window.showAdminView) {
      window.showAdminView("network");
    } else {
      location.href = "/nucleo-red";
    }
    closeMenu();
  });
  navigation.append(link);
} else if (adminLink) {
  adminLink.textContent = "NÚCLEO DE RED";
  adminLink.dataset.view = "network";
  adminLink.addEventListener("click", event => {
    event.preventDefault();
    if (window.showAdminView) {
      window.showAdminView("network");
    } else {
      location.href = "/nucleo-red";
    }
    closeMenu();
  });
}
const users = isAdmin ? document.getElementById("usersButton") : document.createElement("a");
if (!isAdmin) users.id = "sidebarUsers";
users.textContent = "USUARIOS";
users.className = "viavox-nav-item";
users.dataset.view = "users";
if (isAdmin) {
  users.type = "button";
  users.addEventListener("click", () => {
    if (window.showAdminView) {
      window.showAdminView("users");
    }
    closeMenu();
  });
} else {
  users.href = "/usuarios";
  const syncAccess = () => { users.hidden = adminLink?.hidden ?? true; };
  syncAccess();
  if (adminLink) new MutationObserver(syncAccess).observe(adminLink, { attributes: true, attributeFilter: ["hidden"] });
}
navigation.append(users);
const apk = move("apkDownloadBtn", downloads);
if (apk) apk.textContent = "DESCARGAR APK";
const shizuku = move("shizukuDownloadBtn", downloads);
if (shizuku) shizuku.textContent = "DESCARGAR SHIZUKU";
if (isAdmin) {
  downloads.innerHTML = '<a href="/api/apk/download" download>DESCARGAR APK</a><a href="https://github.com/RikkaApps/Shizuku/releases/download/v13.5.4/shizuku-v13.5.4.r1049.0e53409-release.apk" target="_blank" rel="noopener noreferrer">DESCARGAR SHIZUKU</a>';
}
move("accountIdentity", account);
const logoutBtn = move("logoutButton", account);
if (logoutBtn) logoutBtn.textContent = "CERRAR SESIÓN";
move("accountError", account);

function closeMenu() {
  sidebar.classList.remove("is-open");
  toggle.setAttribute("aria-expanded", "false");
}
toggle.addEventListener("click", () => {
  const open = sidebar.classList.toggle("is-open");
  toggle.setAttribute("aria-expanded", String(open));
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && sidebar.classList.contains("is-open")) {
    closeMenu();
    toggle.focus();
  }
});
function select(view) {
  let marked = false;
  for (const item of navigation.querySelectorAll("a, button")) {
    const active = !marked && item.dataset.view === view;
    if (active) {
      marked = true;
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("aria-current");
    }
  }
}
document.addEventListener("panel:view", event => select(event.detail));
if (!isAdmin) {
  const openView = async view => {
    if (view === "reports") {
      showPanelView("reports");
      const reports = await import("../../features/reports/reports-page.js");
      reports.showCalendar?.();
    } else if (view === "blocked") {
      const blockedBtn = document.getElementById("blockedNumbersOpen");
      if (blockedBtn && !blockedBtn.closest(".viavox-sidebar")) {
        blockedBtn.click();
      } else {
        showPanelView("blocked");
      }
    } else if (view === "contacts") {
      showPanelView("contacts");
      window.scrollTo({ top: 0 });
    } else if (view === "messages") {
      showPanelView("messages");
      window.scrollTo({ top: 0 });
      const whatsapp = await import("../../features/messaging/whatsapp.js");
      whatsapp.syncMessagesView?.();
      const templates = await import("../../features/messaging/message-templates.js");
      templates.init?.();
    } else if (view === "reservations") {
      showPanelView("reservations");
      window.scrollTo({ top: 0 });
      const reservations = await import("../../features/reservations/reservations-controller.js");
      reservations.initReservationsView?.();
    } else {
      showPanelView("calls");
      window.scrollTo({ top: 0 });
    }
    closeMenu();
  };
  navigation.addEventListener("click", event => {
    const link = event.target.closest("[data-view]");
    if (!link || !Object.hasOwn(panelPaths, link.dataset.view)) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (link.id === "reportNavBtn" || link.id === "blockedNumbersOpen") {
      closeMenu();
      return;
    }
    event.preventDefault();
    openView(link.dataset.view);
  });
  const viewFromPath = () => Object.keys(panelPaths).find(view => panelPaths[view] === location.pathname) || "calls";
  // Keep direct links, browser history and the visible panel in sync.
  window.addEventListener("popstate", () => openView(viewFromPath()));
  window.addEventListener("dashboard:ready", () => openView(viewFromPath()), { once: true });
  showPanelView(viewFromPath());
}
const initialView = isAdmin
  ? (location.pathname === "/usuarios" ? "users" : "network")
  : Object.keys(panelPaths).find(view => panelPaths[view] === location.pathname) || "calls";
select(initialView);
