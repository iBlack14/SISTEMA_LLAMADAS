export function validateReportPeriod(from, to) {
  if (!from && !to) return "";
  if (!from || !to) return "Elige las fechas Desde y Hasta.";
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  if (!validDate(from) || !validDate(to)) return "Introduce fechas válidas.";
  return from > to ? "La fecha Hasta debe ser igual o posterior a Desde." : "";
}

export function isInReportPeriod(date, period) {
  if (validateReportPeriod(period.from, period.to)) return false;
  if (!period.from && !period.to) return true;
  return Boolean(date && date >= period.from && date <= period.to);
}

export function reportPeriodLabel(period) {
  if (!period.from && !period.to) return "Todo el historial";
  const format = date => new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium", timeZone: "UTC"
  }).format(new Date(date + "T00:00:00Z"));
  return period.from === period.to ? format(period.from) : format(period.from) + " — " + format(period.to);
}
