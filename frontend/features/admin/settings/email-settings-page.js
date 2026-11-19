import { apiFetch, requireLogin } from "../../auth/auth-session.js";

let initialized = false;

const SMTP_PRESETS = {
  gmail: { host: "smtp.gmail.com", port: 587, secure: false, label: "Gmail" },
  outlook: { host: "smtp.office365.com", port: 587, secure: false, label: "Outlook" },
  zoho: { host: "smtp.zoho.com", port: 587, secure: false, label: "Zoho" }
};

function message(text, kind = "info") {
  const box = document.getElementById("smtpMessage");
  if (!box) return;
  box.textContent = text;
  box.className = `settings-notice${text ? " is-visible" : ""}${kind === "error" ? " is-error" : kind === "success" ? " is-success" : ""}`;
  box.hidden = !text;
}

async function json(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || "No se pudo completar la operación.");
  return data;
}

function setPasswordVisible(input, button, visible) {
  input.type = visible ? "text" : "password";
  button.setAttribute("aria-pressed", String(visible));
  button.setAttribute("aria-label", visible ? "Ocultar contraseña" : "Mostrar contraseña");
  button.title = visible ? "Ocultar contraseña" : "Mostrar contraseña";
}

function hidePassword() {
  const button = document.querySelector('[data-password-toggle="smtpPassword"]');
  const input = document.getElementById("smtpPassword");
  if (button && input) setPasswordVisible(input, button, false);
}

function bindPasswordToggle() {
  const button = document.querySelector('[data-password-toggle="smtpPassword"]');
  const input = document.getElementById("smtpPassword");
  if (!button || !input || button.dataset.bound === "1") return;
  button.dataset.bound = "1";
  button.addEventListener("click", () => setPasswordVisible(input, button, input.type === "password"));
}

function applyPreset(name) {
  const preset = SMTP_PRESETS[name];
  if (!preset) return;
  const host = document.getElementById("smtpHost");
  const port = document.getElementById("smtpPort");
  const secure = document.getElementById("smtpSecure");
  if (host) host.value = preset.host;
  if (port) port.value = String(preset.port);
  if (secure) secure.value = String(preset.secure ? 1 : 0);
  message(`${preset.label} cargado. Completa el usuario y la contraseña de aplicación.`, "info");
}

function bindPresets() {
  document.querySelectorAll("[data-smtp-preset]").forEach(button => {
    if (button.dataset.bound === "1") return;
    button.dataset.bound = "1";
    button.addEventListener("click", () => applyPreset(button.dataset.smtpPreset));
  });
}

async function load() {
  const data = await json(await apiFetch("/api/admin/email-settings", { cache: "no-store" }));
  const value = data.settings || {};
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ""; };
  set("smtpHost", value.host);
  set("smtpPort", value.port || 587);
  set("smtpSecure", value.secure ? "1" : "0");
  set("smtpUsername", value.username);
  set("smtpFrom", value.fromAddress);
  set("smtpFromName", value.fromName);
  set("smtpPassword", "");
  hidePassword();

  const status = document.getElementById("smtpStatus");
  if (status) {
    const configured = Boolean(value.host && value.fromAddress && value.hasPassword);
    const label = status.querySelector("span");
    if (label) label.textContent = configured ? "Configurado" : "Pendiente de configuración";
    status.className = `settings-status ${configured ? "is-ready" : ""}`.trim();
  }
  message(value.hasPassword ? "Ya hay una contraseña guardada. Déjala vacía para conservarla." : "", "info");
}

async function save(event) {
  event.preventDefault();
  const payload = {
    host: document.getElementById("smtpHost").value.trim(),
    port: Number(document.getElementById("smtpPort").value),
    secure: document.getElementById("smtpSecure").value === "1",
    username: document.getElementById("smtpUsername").value.trim(),
    password: document.getElementById("smtpPassword").value,
    fromAddress: document.getElementById("smtpFrom").value.trim(),
    fromName: document.getElementById("smtpFromName").value.trim()
  };
  const button = document.getElementById("smtpSaveBtn");
  if (button) button.disabled = true;
  try {
    await json(await apiFetch("/api/admin/email-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }));
    message("Configuración guardada. Todos los empleados usarán este correo.", "success");
    await load();
  } catch (error) {
    message(error.message || "No se pudo guardar la configuración.", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function verify() {
  const button = document.getElementById("smtpVerifyBtn");
  if (button) button.disabled = true;
  try {
    const data = await json(await apiFetch("/api/admin/email-settings/verify", { method: "POST" }));
    message(`Conexión correcta. Correo saliente: ${data.from || "configurado"}.`, "success");
  } catch (error) {
    message(error.message || "No se pudo conectar con el servidor SMTP.", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

export async function initEmailSettingsPage() {
  if (initialized) return;
  const form = document.getElementById("smtpSettingsForm");
  if (!form) return;
  initialized = true;
  await requireLogin();
  form.addEventListener("submit", save);
  bindPasswordToggle();
  bindPresets();
  document.getElementById("smtpVerifyBtn")?.addEventListener("click", verify);
  await load().catch(error => message(error.message || "No se pudo cargar la configuración.", "error"));
}
