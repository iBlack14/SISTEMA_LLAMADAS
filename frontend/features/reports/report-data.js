import { apiFetch as fetch, currentUser } from "../auth/auth-session.js";
import { readDashboardSession } from "../workspace/dashboard-session.js";

// report-data: comparte el estado del módulo de reportes sin crear conexiones.
export function createReportData(reportState, reportActions) {
function reportSession() {
  return readDashboardSession(localStorage, currentUser?.id);
}

function sessionCode() {
  return reportSession().code;
}

function dashboardToken() {
  return reportSession().token;
}

function endpoint(path) {
  const base = window.location.origin;

  return new URL(
    `/api/session/${encodeURIComponent(sessionCode())}${path}`,
    base
  ).href;
}

async function fetchReports(date = "") {
    const context = reportSession();
    if (!context.code || !context.token) {
      throw Error("Tu espacio de llamadas aún se está conectando. Espera unos segundos y pulsa Reintentar.");
    }

    const query = date
      ? `?date=${encodeURIComponent(date)}`
      : "";

    const response = await fetch(
      endpoint("/reports/daily" + query),
      {
        method: "GET",
        headers: {
          "X-Dashboard-Token": dashboardToken()
        }
      }
    );
    const data = await response.json();

    if (!response.ok) {
      throw Error(data.error || "Error consultando reportes");
    }

    return data.reports || [];
  }

function showError(error) {
    reportState.$("dailyReportMount").innerHTML = `
      <p class="report-error">${reportState.esc(error.message || error)}</p>
      <button id="retryReports">Reintentar</button>
    `;

    reportState.$("retryReports").onclick = reportActions.showCalendar;
  }
return { reportSession, sessionCode, dashboardToken, endpoint, fetchReports, showError };
}
