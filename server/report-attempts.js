const limaDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit"
});

export function collectReportAttempts(session) {
  const management = session.shiftManagement || {};
  const shifts = [...(management.history || []), management.current].filter(Boolean);
  const rows = new Map();
  function add(items, shift, fallbackDate = "") {
    for (const item of items || []) {
      const time = Date.parse(item.startedAt || "");
      const matchedShift = shift || shifts.find(s => Number.isFinite(time) &&
        time >= Date.parse(s.startedAt) && (!s.endedAt || time <= Date.parse(s.endedAt)));
      const key = item.attemptId || [item.contactId, item.phone, item.workerId, item.attemptNumber, item.startedAt].join("|");
      const previous = rows.get(key);
      rows.set(key, {
        ...previous, ...item,
        reportDate: Number.isFinite(time) ? limaDate.format(new Date(time)) : fallbackDate,
        shiftId: matchedShift?.id || previous?.shiftId || "",
        shiftLabel: matchedShift?.label || previous?.shiftLabel || ""
      });
    }
  }
  for (const archive of session.reportArchive || []) add(archive.history, null, archive.date);
  for (const shift of management.history || []) add(shift.report, shift, shift.date);
  add(session.campaign?.history);
  add(management.currentReport, management.current);
  return [...rows.values()].sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0));
}
