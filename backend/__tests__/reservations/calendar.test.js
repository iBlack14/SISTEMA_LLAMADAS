import test from "node:test";
import assert from "node:assert/strict";
import { limaToday, reservationDateKey, reservationMonth, reservationYear, reservationsInScope, shiftReservationMonth } from "../../../frontend/features/reservations/reservation-calendar.js";

test("year overview returns twelve ordered months and counts only that year's reservations", () => {
  const year = reservationYear(2026, [{ date: "2026-01-10" }, { date: "2026-11-27" }, { date: "2026-11-28" }, { date: "2027-01-01" }, { date: "invalid" }]);
  assert.equal(year.months.length, 12);
  assert.equal(year.months[0].key, "2026-01");
  assert.equal(year.months[11].key, "2026-12");
  assert.equal(year.months[10].count, 2);
  assert.equal(year.months[1].count, 0);
  assert.equal(year.total, 3);
  assert.equal(year.undated, 1);
});

test("calendar starts on Monday and places a Sunday month start in column seven", () => {
  const month = reservationMonth("2026-11", []);
  assert.equal(month.cells.length, 42);
  assert.deepEqual(month.cells.slice(0, 6), Array(6).fill(null));
  assert.equal(month.cells[6].date, "2026-11-01");
  assert.equal(month.cells.filter(Boolean).length, 30);
});

test("annual mini calendars start on Sunday and January 2026 places day one on Thursday", () => {
  const january = reservationMonth("2026-01", [], { weekStartsOn: 0 });
  assert.deepEqual(january.cells.slice(0, 4), Array(4).fill(null));
  assert.equal(january.cells[4].date, "2026-01-01");
  assert.equal(january.cells.filter(Boolean).length, 31);
  const november = reservationMonth("2026-11", [], { weekStartsOn: 0 });
  assert.equal(november.cells[0].date, "2026-11-01");
});

test("leap February includes February 29 and rejects nonexistent dates", () => {
  assert.equal(reservationMonth("2028-02", []).cells.filter(Boolean).length, 29);
  assert.equal(reservationDateKey("2028-02-29"), "2028-02-29");
  assert.equal(reservationDateKey("2026-02-29"), "");
  assert.equal(reservationDateKey("2026-11-31"), "");
});

test("month navigation crosses year boundaries", () => {
  assert.equal(shiftReservationMonth("2026-12", 1), "2027-01");
  assert.equal(shiftReservationMonth("2027-01", -1), "2026-12");
});

test("today uses Lima even when UTC already belongs to the next day", () => {
  assert.equal(limaToday(new Date("2026-11-28T03:00:00Z")), "2026-11-27");
});

test("monthly counts include all statuses and preserve access to undated reservations", () => {
  const rows = [{ id: "a", date: "2026-11-27", status: "scheduled" }, { id: "b", date: "2026-11-27", status: "completed" }, { id: "c", date: "2026-12-01" }, { id: "d", date: "invalid" }];
  const month = reservationMonth("2026-11", rows);
  assert.equal(month.total, 2);
  assert.equal(month.undated, 1);
  assert.equal(month.cells.find(day => day?.date === "2026-11-27").count, 2);
  assert.deepEqual(reservationsInScope(rows, "2026-11").map(r => r.id), ["a", "b"]);
  assert.deepEqual(reservationsInScope(rows, "2026-11", "undated").map(r => r.id), ["d"]);
});

test("day selection returns only reservations for the selected date", () => {
  const rows = [{ date: "2026-11-27" }, { date: "2026-11-28" }, { date: "2026-12-27" }];
  assert.deepEqual(reservationsInScope(rows, "2026-11", "2026-11-27"), [rows[0]]);
});
