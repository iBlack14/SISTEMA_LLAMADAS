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
    const isAdmin = String(currentUser?.role || "").toUpperCase() === "ADMINISTRADOR";
    const viewAll = isAdmin && reportState.reportScope !== "mine";
    const params = new URLSearchParams();
    if (date) params.set("date", date);
    if (viewAll && String(reportState.reportScope).startsWith("user:")) {
      params.set("userId", String(reportState.reportScope).slice(5));
    }
    const queryString = params.toString();
    const query = queryString ? `?${queryString}` : "";
    // El administrador puede filtrar por usuario; empleado y vista personal conservan su propia sesión.
    const url = viewAll ? `/api/reports/all${query}` : endpoint("/reports/daily" + query);
    if (!viewAll) {
      const context = reportSession();
      if (!context.code || !context.token) {
        throw Error("Tu espacio de llamadas aún se está conectando. Espera unos segundos y pulsa Reintentar.");
      }
    }

    const response = await fetch(url, {
        method: "GET",
        headers: viewAll ? {} : { "X-Dashboard-Token": dashboardToken() }
    });
    const data = await response.json();

    if (!response.ok) {
      throw Error(data.error || "Error consultando reportes");
    }

    if (Array.isArray(data.users)) reportState.reportUsers = data.users;

    return data.reports || [];
  }

  // El calendario solo necesita fechas y conteos: este endpoint evita cargar
  // el detalle completo de todos los reportes antes de dibujar los meses.
  async function fetchCalendarDates(year = "") {
    const query = year ? `?year=${encodeURIComponent(year)}` : "";
    const isAdmin = String(currentUser?.role || "").toUpperCase() === "ADMINISTRADOR";
    const viewAll = isAdmin && reportState.reportScope !== "mine";
    const params = new URLSearchParams();
    if (year) params.set("year", year);
    if (viewAll && String(reportState.reportScope).startsWith("user:")) {
      params.set("userId", String(reportState.reportScope).slice(5));
    }
    const filteredQueryString = params.toString();
    const filteredQuery = filteredQueryString ? `?${filteredQueryString}` : "";
    const url = viewAll ? `/api/reports/calendar${filteredQuery}` : endpoint("/reports/calendar" + query);
    if (!viewAll) {
      const context = reportSession();
      if (!context.code || !context.token) {
        throw Error("Tu espacio de llamadas aún se está conectando. Espera unos segundos y pulsa Reintentar.");
      }
    }
    const response = await fetch(url, {
      method: "GET",
      headers: viewAll ? {} : { "X-Dashboard-Token": dashboardToken() }
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Error consultando el calendario");
    return data.dates || {};
  }

function showError(error) {
    reportState.$("dailyReportMount").innerHTML = `
      <p class="report-error">${reportState.esc(error.message || error)}</p>
      <button id="retryReports">Reintentar</button>
    `;

    reportState.$("retryReports").onclick = reportActions.showCalendar;
  }
return { reportSession, sessionCode, dashboardToken, endpoint, fetchReports, fetchCalendarDates, showError };
}
