// Reservation dates are calendar days in Lima, not timestamps to shift by timezone.
export function reservationDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : "";
}

export function limaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function shiftReservationMonth(month, offset) {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}

export function reservationMonth(month, reservations, { weekStartsOn = 1 } = {}) {
  const first = new Date(`${month}-01T12:00:00Z`);
  const offset = (first.getUTCDay() - weekStartsOn + 7) % 7;
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const counts = new Map();
  let undated = 0, total = 0;
  for (const reservation of reservations) {
    const day = reservationDateKey(reservation.date);
    if (!day) { undated++; continue; }
    if (!day.startsWith(`${month}-`)) continue;
    counts.set(day, (counts.get(day) || 0) + 1);
    total++;
  }
  return {
    total, undated,
    label: new Intl.DateTimeFormat("es-PE", { month: "long", year: "numeric", timeZone: "UTC" }).format(first),
    cells: Array.from({ length: Math.ceil((offset + days) / 7) * 7 }, (_, index) => {
      const number = index - offset + 1;
      if (number < 1 || number > days) return null;
      const date = `${month}-${String(number).padStart(2, "0")}`;
      return { date, number, count: counts.get(date) || 0 };
    })
  };
}

export function reservationsInScope(reservations, month, day = "") {
  return reservations.filter(reservation => {
    const date = reservationDateKey(reservation.date);
    return day === "undated" ? !date : day ? date === day : date.startsWith(`${month}-`);
  });
}

export function reservationYear(year, reservations) {
  const counts = new Map();
  let undated = 0;
  for (const reservation of reservations) {
    const date = reservationDateKey(reservation.date);
    if (!date) { undated++; continue; }
    if (date.slice(0, 4) !== String(year)) continue;
    const month = date.slice(0, 7);
    counts.set(month, (counts.get(month) || 0) + 1);
  }
  const months = Array.from({ length: 12 }, (_, index) => {
    const key = `${year}-${String(index + 1).padStart(2, "0")}`;
    const label = new Intl.DateTimeFormat("es-PE", { month: "long", timeZone: "UTC" }).format(new Date(`${key}-01T12:00:00Z`));
    return { key, label, count: counts.get(key) || 0 };
  });
  return { months, undated, total: months.reduce((sum, month) => sum + month.count, 0) };
}
