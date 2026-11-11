export interface User { id: number | string; username: string; role: string }
export interface Contact {
  id: string; name: string; phone: string; list: string; note: string;
  doNotCall?: boolean; callBlockedUntil?: string | null; callBlockReason?: string;
}
export interface Book {
  contacts: Contact[]; lists: string[]; activeList?: string;
  calledCounts: Record<string, number>; contactRowStatus: Record<string, string>;
  callDurations: Record<string, number>; dismissedReminderIds: Record<string, boolean>;
  preferences: Record<string, unknown>;
}
export interface BookResponse { ok: boolean; revision: number; book: Book | null }
export interface Access { user: User; code: string; token: string; csrfToken: string }

async function json<T>(response: Response): Promise<T> {
  if (response.status === 401) { window.location.assign("/login"); throw new Error("Inicia sesión para continuar."); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo consultar el servidor.");
  return data as T;
}
export async function openAccess(signal: AbortSignal): Promise<Access> {
  const data = await json<{ok: boolean; user: User; csrfToken: string}>(await fetch("/api/auth/me", {
    signal, credentials: "same-origin", cache: "no-store"
  }));
  const prefix = "voip vc.auth." + data.user.id;
  const code = (localStorage.getItem(prefix + ".dashboardSessionCode") || "").trim().toUpperCase();
  const token = localStorage.getItem(prefix + ".dashboardToken." + code) || "";
  if (!code || !token) throw new Error("Abre el panel de llamadas para crear o restaurar tu sesión y vuelve aquí.");
  return {user:data.user,csrfToken:data.csrfToken,code,token};
}
export async function readBook(access: Access, signal?: AbortSignal): Promise<BookResponse> {
  return json<BookResponse>(await fetch("/api/session/" + encodeURIComponent(access.code) + "/contact-book", {
    signal, credentials:"same-origin", cache:"no-store", headers:{"X-Dashboard-Token":access.token}
  }));
}
export async function saveBook(access: Access, book: Book, revision: number): Promise<number> {
  const result = await json<{ok:boolean;revision:number}>(await fetch("/api/session/" + encodeURIComponent(access.code) + "/contact-book", {
    method:"PUT",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Dashboard-Token":access.token,"X-CSRF-Token":access.csrfToken},
    body:JSON.stringify({book,revision})
  }));
  return result.revision;
}
export function callStatus(contact: Contact): { label: string; kind: "blocked" | "waiting" | "available" } {
  if (contact.doNotCall) return {label:"No volver a llamar",kind:"blocked"};
  if (contact.callBlockedUntil && Date.parse(contact.callBlockedUntil) > Date.now())
    return {label:"Llamado anteriormente",kind:"waiting"};
  return {label:"Disponible",kind:"available"};
}
