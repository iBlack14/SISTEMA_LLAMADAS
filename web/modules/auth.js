export let currentUser;
let csrfToken = "";
const accountChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("calls-account") : null;
if (accountChannel) accountChannel.onmessage = () => window.location.replace("/");

export async function requireLogin() {
  const response = await fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" });
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("Inicia sesión.");
  }
  if (!response.ok) throw new Error("No se pudo verificar tu acceso. Recarga la página.");
  const data = await response.json();
  currentUser = data.user;
  csrfToken = data.csrfToken;
  window.VOIP_VC_AUTH_USER = currentUser;
  return currentUser;
}

export async function apiFetch(input, options = {}) {
  const target = new URL(input, window.location.origin);
  if (target.origin !== window.location.origin) throw new Error("Esta fase usa el servidor local de la página.");
  const headers = new Headers(options.headers);
  if (!["GET", "HEAD", "OPTIONS"].includes(String(options.method || "GET").toUpperCase())) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(target, { ...options, headers, credentials: "same-origin" });
  if (response.status === 401) window.location.replace("/login");
  return response;
}

export function bindAccountControls() {
  const label = document.getElementById("accountIdentity");
  if (label) label.textContent = `${currentUser.username} · ${currentUser.role}`;
  const adminLink = document.getElementById("adminLink");
  if (adminLink) adminLink.hidden = currentUser.role !== "ADMINISTRADOR";
  const button = document.getElementById("logoutButton");
  if (button) button.onclick = async () => {
    button.disabled = true;
    try {
      const response = await apiFetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("No se pudo cerrar sesión. Intenta de nuevo.");
      accountChannel?.postMessage("changed");
      window.location.replace("/login");
    } catch (error) {
      button.disabled = false;
      const status = document.getElementById("accountError");
      if (status) status.textContent = error.message;
    }
  };
}
