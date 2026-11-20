import { splitReportByList } from "./report-lists.js";
import { hydrateReportDetails } from "./report-details.js";
import { isAnsweredAttempt, isVoicemailAttempt, attemptResultLabel } from "../../../shared/reports/report-metrics.js";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, phoneKey } from "../campaigns/contact-book.js";
import { collectReportAttempts } from "./report-attempts.js";

/**
 * createReportData: conserva los contratos y reglas existentes.
 * Dependencias: services.annualBlocks, services.archiveCurrentCampaign.
 * Se construye una vez por proceso.
 */
export function createReportData(runtime, services) {
function createReportContext() {
  const restrictions = services.annualBlocks();
  const blocked = new Set(services.globalBlockedNumbers().map(entry => phoneKey(entry.phone)));
  return { restrictions, blocked };
}

function reportData(session, date, context = createReportContext()) {
  services.archiveCurrentCampaign(session);
  const { restrictions, blocked } = context;
  const knownAttempts = new Map(collectReportAttempts(session).map(attempt => [attempt.attemptId, attempt]));

  const matchesDate = typeof date === "object" && date
    ? record => (!date.from || record.date >= date.from) && (!date.to || record.date <= date.to)
    : record => !date || record.date === date;

  return (session.reportArchive || [])
    .filter(matchesDate)
    .flatMap(splitReportByList)
    .map(record => hydrateReportDetails(record, session, knownAttempts))
    .map(r => {
      const last = new Map();

      for (const h of r.calls) {
        last.set(String(h.phone), h);
      }

      const rows = r.contacts.map(c => {
        const h = last.get(String(c.phone));

        const duration = Math.max(
          Number(c.durationSeconds || 0),
          Number(h?.durationSeconds || 0)
        );

        const result = String(
          c.technicalResult ||
          h?.technicalResult ||
          c.result ||
          ""
        ).toLowerCase();

        const outcome = { ...c, ...h, technicalResult: result };
        const answered = isAnsweredAttempt(outcome);
        const voicemail = isVoicemailAttempt(outcome);
        const inoperable = attemptResultLabel(outcome) === "INOPERABLE";

        return {
          ...c,
          durationSeconds: duration,
          technicalResult: result,
          doNotCall: Boolean(restrictions.get(phoneKey(c.phone))?.permanent),
          manualBlocked: blocked.has(phoneKey(c.phone)),
          answered,
          voicemail,
          inoperable,
          pending: !answered && !inoperable && !voicemail,
          lastCallAt: h?.startedAt || null
        };
      });

      return {
        id: r.id,
        date: r.date,
        rubro: r.rubro,
        numbers: rows.length,
        totalCalls: r.history.length,
        calls: r.calls,
        teamShifts: r.teamShifts,
        answered: rows.filter(c => c.answered).length,
        voicemail: rows.filter(c => c.voicemail).length,
        pending: rows.filter(c => c.pending).length,
        rows
      };
    });
}

  // Solo fechas y conteos para el calendario anual: evita hidratar intentos,
  // bloqueos y detalles de cada reporte, que es lo que encarece /api/reports/all.
  function calendarReportDates(session, year = "") {
    const dates = {};
    const prefix = year ? `${year}-` : "";
    for (const record of (session.reportArchive || []).flatMap(splitReportByList)) {
      const date = String(record.date || "");
      if (!date || (prefix && !date.startsWith(prefix))) continue;
      dates[date] = (dates[date] || 0) + 1;
    }
    return dates;
  }
  return { reportData, calendarReportDates, createReportContext };
}
