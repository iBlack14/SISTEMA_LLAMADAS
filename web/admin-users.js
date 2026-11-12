import { apiFetch, requireLogin } from "./modules/auth.js";

try {
  const user = await requireLogin();
  if (user.role === "ADMINISTRADOR") bindUsers();
} catch (cause) {
  document.getElementById("accountError").textContent = cause.message;
  document.getElementById("usersButton").disabled = true;
}

function bindUsers() {
  const dialog = document.getElementById("usersDialog");
  const form = document.getElementById("createUserForm");
  const error = document.getElementById("usersError");
  const message = document.getElementById("usersMessage");
  const close = document.getElementById("usersClose");
  const refresh = document.getElementById("usersRefresh");
  let creating = false;
  let loading = false;
  let requestNumber = 0;

  function showError(text) { error.textContent = text; error.hidden = !text; }
  function clearPasswords() { form.elements.password.value = ""; form.elements.passwordConfirmation.value = ""; }
  function setBusy(value) {
    creating = value;
    for (const control of form.elements) control.disabled = value;
    close.disabled = value;
    refresh.disabled = value || loading;
    document.getElementById("createUserButton").textContent = value ? "Creando usuario…" : "Crear usuario";
  }
  async function loadUsers() {
    const request = ++requestNumber;
    loading = true;
    refresh.disabled = true;
    const status = document.getElementById("usersLoading");
    status.hidden = false;
    status.textContent = "Cargando usuarios…";
    try {
      const response = await apiFetch("/api/admin/users", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar los usuarios.");
      if (request !== requestNumber) return;
      const body = document.getElementById("usersRows");
      body.replaceChildren();
      for (const account of data.users) {
        const row = document.createElement("tr");
        for (const value of [account.username, account.role === "ADMINISTRADOR" ? "Administrador" : "Ventas", account.active ? "Activo" : "Inactivo"]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.appendChild(cell);
        }
        body.appendChild(row);
      }
      status.textContent = data.users.length ? "" : "Todavía no hay cuentas registradas.";
      status.hidden = Boolean(data.users.length);
    } catch (cause) {
      if (request !== requestNumber) return;
      status.textContent = "No se pudo actualizar la lista.";
      showError(cause.message);
    } finally {
      if (request === requestNumber) { loading = false; refresh.disabled = creating; }
    }
  }

  document.getElementById("usersButton").addEventListener("click", () => {
    showError("");
    message.hidden = true;
    dialog.showModal();
    document.getElementById("newUsername").focus();
    loadUsers();
  });
  close.addEventListener("click", () => { if (!creating) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (creating) event.preventDefault(); });
  dialog.addEventListener("close", clearPasswords);
  refresh.addEventListener("click", () => { showError(""); loadUsers(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (creating) return;
    showError("");
    message.hidden = true;
    const values = form.elements;
    if (values.password.value !== values.passwordConfirmation.value) {
      showError("Las contraseñas no coinciden.");
      values.passwordConfirmation.focus();
      return;
    }
    const payload = {
      username: values.username.value.trim(), role: values.role.value,
      password: values.password.value, passwordConfirmation: values.passwordConfirmation.value
    };
    setBusy(true);
    try {
      const response = await apiFetch("/api/admin/users", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo crear el usuario.");
      form.reset();
      message.textContent = "Usuario " + data.user.username + " creado con acceso de " + (data.user.role === "ADMINISTRADOR" ? "administrador." : "ventas.");
      message.hidden = false;
      await loadUsers();
    } catch (cause) {
      showError(cause.message);
    } finally {
      payload.password = "";
      payload.passwordConfirmation = "";
      setBusy(false);
    }
  });
}
