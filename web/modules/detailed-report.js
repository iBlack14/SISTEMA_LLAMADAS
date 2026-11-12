import { isAnsweredAttempt, isVoicemailAttempt, isInoperableAttempt } from "./report-metrics.js";

const keyOf = item => String(item.contactId || item.id || item.phone || item.name || "");
const teamOf = item => String(item.workerName || "").trim() || "SIN EQUIPO";
const emptyMetrics = () => ({calls:0, answered:0, noAnswer:0, voicemail:0, inoperable:0, pending:0});
function hourOf(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return null;
  return Number(new Intl.DateTimeFormat("en-US", {timeZone:"America/Lima",hour:"2-digit",hourCycle:"h23"}).format(date));
}
const hourLabel = hour => hour === null ? "SIN HORA" :
  String(hour).padStart(2,"0") + ":00–" + String((hour+1)%24).padStart(2,"0") + ":00";

export function buildDetailedReport(report, selectedTeam, pendingOnly = false) {
  const contacts = report.rows || [];
  const calls = report.calls?.length ? report.calls : contacts.filter(c=>c.lastCallAt).map(c=>({...c,startedAt:c.lastCallAt}));
  const latest = new Map();
  for (const call of calls) {
    const old = latest.get(keyOf(call));
    if (!old || Date.parse(call.startedAt || 0) >= Date.parse(old.startedAt || 0)) latest.set(keyOf(call),call);
  }
  const designated = new Map(), totals = new Map(), hourly = new Map();
  const metrics = team => {
    if (!totals.has(team)) totals.set(team,emptyMetrics());
    return totals.get(team);
  };
  const bucket = (team,hour) => {
    const key = JSON.stringify([team,hour]);
    if (!hourly.has(key)) hourly.set(key,{team,hour,...emptyMetrics()});
    return hourly.get(key);
  };
  for (const contact of contacts) {
    const team = teamOf(latest.get(keyOf(contact)) || contact);
    if (!designated.has(team)) designated.set(team,new Set());
    designated.get(team).add(keyOf(contact));
  }
  for (const call of calls) {
    const team = teamOf(call);
    if (!designated.has(team)) designated.set(team,new Set());
    designated.get(team).add(keyOf(call));
    const row = bucket(team,hourLabel(hourOf(call.startedAt)));
    const total = metrics(team);
    row.calls++; total.calls++;
    const outcome = isInoperableAttempt(call) ? "inoperable" :
      isVoicemailAttempt(call) ? "voicemail" :
      isAnsweredAttempt(call) ? "answered" : "noAnswer";
    row[outcome]++; total[outcome]++;
  }
  for (const contact of contacts) {
    const last = latest.get(keyOf(contact));
    const unattempted = !last && !contact.lastCallAt;
    const pending = (contact.pending === true || unattempted) &&
      !contact.doNotCall && !contact.manualBlocked &&
      !isInoperableAttempt(contact) && !isVoicemailAttempt(contact) && !isAnsweredAttempt(contact);
    if (!pending) continue;
    const team = teamOf(last || contact);
    const time = last?.startedAt || contact.lastCallAt;
    const row = bucket(team,time ? hourLabel(hourOf(time)) : "SIN LLAMADA");
    row.pending++;
    metrics(team).pending++;
  }
  const rows = [...hourly.values()].map(row=>({...row,designated:designated.get(row.team)?.size || 0}))
    .sort((a,b)=>a.team.localeCompare(b.team,"es") || a.hour.localeCompare(b.hour,"es",{numeric:true}));
  return {
    rows: rows.filter(row=>row.team===selectedTeam && (!pendingOnly || row.pending>0)),
    metrics: metrics(selectedTeam)
  };
}
