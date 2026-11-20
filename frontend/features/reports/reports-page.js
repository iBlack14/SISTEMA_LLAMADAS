import { showPanelView } from "../../app/navigation/panel-navigation.js";
import { currentUser } from "../auth/auth-session.js";
import { createReportData } from "./report-data.js?v=20261119-calendar-fast";
import { createReportCalendar } from "./report-calendar.js?v=20261119-calendar-fast";
import { createReportDay } from "./report-day.js";
import { createReportDetailView } from "./report-detail-view.js";

// Una instancia del calendario y sus filtros por página.
const reportState = {};
const reportActions = {};
Object.assign(reportActions, createReportData(reportState, reportActions));
Object.assign(reportActions, createReportCalendar(reportState, reportActions));
Object.assign(reportActions, createReportDay(reportState, reportActions));
Object.assign(reportActions, createReportDetailView(reportState, reportActions));
reportState.$ = id => document.getElementById(id);
reportState.reportPdfTableTheme = {
    header: [102, 0, 115],
    border: [219, 186, 222],
    text: [36, 16, 43],
    rows: [
      [255, 255, 255],
      [250, 247, 252]
    ]
  };
reportState.months = [
    "Enero", "Febrero", "Marzo", "Abril",
    "Mayo", "Junio", "Julio", "Agosto",
    "Septiembre", "Octubre", "Noviembre", "Diciembre"
  ];
reportState.formatDetailedDate = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return value;
    const [, year, month, day] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      date.getFullYear() !== Number(year) ||
      date.getMonth() !== Number(month) - 1 ||
      date.getDate() !== Number(day)
    ) return value;
    const weekdays = ["DOM", "LUN", "MAR", "MIERC", "JUEV", "VIE", "SAB"];
    return `${weekdays[date.getDay()]} ${day}/${month}/${year}`;
  };
reportState.isAdmin = String(currentUser?.role || "").toUpperCase() === "ADMINISTRADOR";
reportState.reportScope = reportState.isAdmin ? "all" : "mine";
reportState.reportUsers = [];
reportState.year = new Date().getFullYear();
reportState.hoverDate = "";
reportState.selectedDate = "";
reportState.calendarRange = { from: "", to: "" };
reportState.viewedPeriod = null;
reportState.reports = [];
reportState.selectedReport = "";
reportState.selectionReportId = "";
reportState.selectedContactIds = new Set();
reportState.reportSearchTerm = "";
reportState.showingDetailedReport = false;
reportState.detailedPendingOnly = false;
reportState.selectedDetailedTeam = "";
reportState.visibleRubrosStart = 0;
reportState.rubrosPerPage = 3;
reportState.tableRowsPerPage = 20;
reportState.tablePage = 0;
reportState.tablePageKey = '';
reportState.detailedPage = 0;
reportState.detailedPageKey = '';
reportState.esc = value => String(value ?? "").replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char])
  );
reportState.bindReportNav = () => {
    reportState.$("reportNavBtn")?.addEventListener("click", () => {
      showPanelView("reports");
      reportActions.showCalendar();
    });

    reportState.$("reportBackBtn")?.addEventListener("click", () => {
      showPanelView("calls");
    });
  };
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportState.bindReportNav);
  } else {
    reportState.bindReportNav();
  }
export const showCalendar = (...args) => reportActions.showCalendar(...args);
