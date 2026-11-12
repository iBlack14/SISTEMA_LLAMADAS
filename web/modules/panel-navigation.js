export function showPanelView(view) {
  const sections = { calls: "callsContent", reports: "annualReport", blocked: "blockedNumbersView" };
  if (!Object.hasOwn(sections, view)) return;
  for (const [name, id] of Object.entries(sections)) {
    const section = document.getElementById(id);
    if (section) section.hidden = name !== view;
  }
  const reportButton = document.getElementById("reportNavBtn");
  const blockedButton = document.getElementById("blockedNumbersOpen");
  const reportBack = document.getElementById("reportBackBtn");
  if (reportButton) reportButton.hidden = view === "reports";
  if (blockedButton) blockedButton.hidden = view === "blocked";
  if (reportBack) reportBack.hidden = view !== "reports";
}
