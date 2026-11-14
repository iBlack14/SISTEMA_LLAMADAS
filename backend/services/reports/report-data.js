import { splitReportByList } from "./report-lists.js";
import { hydrateReportDetails } from "./report-details.js";
import { isAnsweredAttempt, isVoicemailAttempt, attemptResultLabel } from "../../../shared/reports/report-metrics.js";
import { normalizeBook, withProgress, uncalledContacts, excludeCalledPending, excludeBlockedPending, annualPhoneBlocks, phoneKey } from "../campaigns/contact-book.js";
import { collectReportAttempts } from "./report-attempts.js";

/**
 * createReportData: conserva los contratos y reglas existentes.
 * Dependencias: services.allCallAttempts, services.archiveCurrentCampaign.
 * Se construye una vez por proceso.
 */
export function createReportData(runtime, services) {
function reportData(session, date) {
  services.archiveCurrentCampaign(session);
  const restrictions = annualPhoneBlocks(services.allCallAttempts());
  const knownAttempts = new Map(collectReportAttempts(session).map(attempt => [attempt.attemptId, attempt]));
  const blocked = new Set((session.blockedNumbers || []).map(entry => phoneKey(entry.phone)));

  return (session.reportArchive || [])
    .filter(r => !date || r.date === date)
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
return { reportData };
}
