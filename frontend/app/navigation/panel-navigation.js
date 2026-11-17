// Cada sección del panel es una página independiente con su propia URL.
export const panelPaths = {
  calls: "/llamadas",
  contacts: "/contactos",
  reports: "/reportes",
  reservations: "/reservas",
  blocked: "/bloqueos",
  messages: "/mensajes"
};

export function showPanelView(view, { history: updateHistory = true } = {}) {
  const sections = {
    calls: "callsContent",
    contacts: "contactsContent",
    reports: "annualReport",
    reservations: "reservationsView",
    blocked: "blockedNumbersView",
    messages: "messagesView"
  };
  if (!Object.hasOwn(sections, view)) return;
  for (const [name, id] of Object.entries(sections)) {
    const section = document.getElementById(id);
    if (section) section.hidden = name !== view;
  }
  // Gestión del turno solo aplica al espacio de llamadas.
  const shiftBar = document.getElementById("shiftManagement");
  if (shiftBar) shiftBar.hidden = view !== "calls";
  const reportButton = document.getElementById("reportNavBtn");
  const blockedButton = document.getElementById("blockedNumbersOpen");
  const reportBack = document.getElementById("reportBackBtn");
  if (reportButton) reportButton.hidden = !reportButton.closest(".viavox-sidebar") && view === "reports";
  if (blockedButton) blockedButton.hidden = !blockedButton.closest(".viavox-sidebar") && view === "blocked";
  if (reportBack) reportBack.hidden = view !== "reports";
  const path = panelPaths[view];
  if (updateHistory && window.location.pathname !== path) {
    history.pushState(null, "", path);
  }
  document.dispatchEvent(new CustomEvent("panel:view", { detail: view }));
}
