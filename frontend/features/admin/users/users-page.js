import { apiFetch, bindAccountControls, requireLogin } from "../../auth/auth-session.js?v=20261119-users-ui3";

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

let usersInitialized = false;
export async function initUsersPage() {
  if (usersInitialized) return;
  const user = await requireLogin();
  if (user.role === "ADMINISTRADOR") {
    bindAccountControls();
    bindUsers();
    usersInitialized = true;
  }
}

function bindUsers() {
  const networkView = document.getElementById("networkView");
  const usersView = document.getElementById("usersView");
  const form = document.getElementById("createUserForm");
  const error = document.getElementById("usersError");
  const message = document.getElementById("usersMessage");
  const backBtn = document.getElementById("usersBackBtn");
  const refresh = document.getElementById("usersRefresh");
  const editDialog = document.getElementById("editUserDialog");
  const editForm = document.getElementById("editUserForm");
  const editError = document.getElementById("editUserError");
  let creating = false;
  let saving = false;
  let loading = false;
  let requestNumber = 0;

  function showError(text) {
    if (error) {
      error.textContent = text;
      error.hidden = !text;
    }
  }

  function showEditError(text) {
    if (editError) {
      editError.textContent = text;
      editError.hidden = !text;
    }
  }

  // Ojito: alterna la visibilidad de cada campo de contraseña.
  function setPasswordVisible(input, button, visible) {
    input.type = visible ? "text" : "password";
    button.setAttribute("aria-pressed", String(visible));
    button.setAttribute("aria-label", visible ? "Ocultar contraseña" : "Mostrar contraseña");
    button.title = visible ? "Ocultar contraseña" : "Mostrar contraseña";
  }

  function hidePasswords(scope) {
    for (const button of scope.querySelectorAll("[data-password-toggle]")) {
      const input = document.getElementById(button.dataset.passwordToggle);
      if (input) setPasswordVisible(input, button, false);
    }
  }

  function bindPasswordToggles(scope) {
    for (const button of scope.querySelectorAll("[data-password-toggle]")) {
      if (button.dataset.bound === "1") continue;
      button.dataset.bound = "1";
      button.addEventListener("click", () => {
        const input = document.getElementById(button.dataset.passwordToggle);
        if (input) setPasswordVisible(input, button, input.type === "password");
      });
    }
  }

  function clearPasswords() {
    if (form) {
      form.elements.password.value = "";
      form.elements.passwordConfirmation.value = "";
      hidePasswords(form);
    }
  }

  function setBusy(value) {
    creating = value;
    if (form) {
      for (const control of form.elements) control.disabled = value;
    }
    if (backBtn) backBtn.disabled = value;
    if (refresh) refresh.disabled = value || loading;
    const createBtn = document.getElementById("createUserButton");
    if (createBtn) createBtn.textContent = value ? "Creando usuario…" : "Crear usuario";
  }

  async function loadUsers() {
    const request = ++requestNumber;
    loading = true;
    if (refresh) refresh.disabled = true;
    const status = document.getElementById("usersLoading");
    if (status) {
      status.hidden = false;
      status.textContent = "Cargando…";
    }
    try {
      const response = await apiFetch("/api/users", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar los vendedores.");
      if (request !== requestNumber) return;
      const body = document.getElementById("usersRows");
      if (body) {
        body.replaceChildren();
        for (const account of data.users) {
          const row = document.createElement("tr");
          const cells = [];
          for (const value of [
            account.username,
            account.role === "ADMINISTRADOR" ? "Administrador" : "Vendedor",
            account.active ? "Activo" : "Inactivo",
            formatDate(account.createdAt)
          ]) {
            const cell = document.createElement("td");
            cell.textContent = value;
            cells.push(cell);
            row.appendChild(cell);
          }
          const roleBadge = document.createElement("span");
          roleBadge.className = "users-badge " + (account.role === "ADMINISTRADOR" ? "role-admin" : "role-seller");
          roleBadge.textContent = cells[1].textContent;
          cells[1].replaceChildren(roleBadge);
          const stateBadge = document.createElement("span");
          stateBadge.className = "users-badge " + (account.active ? "state-active" : "state-inactive");
          stateBadge.textContent = cells[2].textContent;
          cells[2].replaceChildren(stateBadge);
          const actions = document.createElement("td");
          actions.className = "users-table-actions";
          const editButton = document.createElement("button");
          editButton.type = "button";
          editButton.className = "button secondary";
          editButton.textContent = "Editar";
          editButton.addEventListener("click", () => openEditUser(account));
          actions.appendChild(editButton);
          row.appendChild(actions);
          body.appendChild(row);
        }
      }
      if (status) {
        status.textContent = data.users.length ? "" : "No hay vendedores registrados.";
        status.hidden = Boolean(data.users.length);
      }
      const count = document.getElementById("usersCount");
      if (count) count.textContent = `${data.users.length} ${data.users.length === 1 ? "vendedor" : "vendedores"}`;
    } catch (cause) {
      if (request !== requestNumber) return;
      if (status) status.textContent = "No se pudo cargar la lista.";
      showError(cause.message);
    } finally {
      if (request === requestNumber) {
        loading = false;
        if (refresh) refresh.disabled = creating;
      }
    }
  }

  function openEditUser(account) {
    if (!editDialog || !editForm) return;
    editForm.reset();
    showEditError("");
    editForm.elements.id.value = account.id;
    editForm.elements.username.value = account.username;
    editForm.elements.role.value = account.role;
    editForm.elements.active.value = account.active ? "1" : "0";
    hidePasswords(editForm);
    editDialog.showModal();
    editForm.elements.username.focus();
  }

  function setEditBusy(value) {
    saving = value;
    if (editForm) for (const control of editForm.elements) control.disabled = value;
    const closeBtn = document.getElementById("editUserClose");
    if (closeBtn) closeBtn.disabled = value;
    const submitBtn = document.getElementById("editUserSubmit");
    if (submitBtn) submitBtn.textContent = value ? "Guardando…" : "Guardar cambios";
  }

  window.showUsersPage = () => {
    showError("");
    if (message) message.hidden = true;
    loadUsers();
  };
  bindPasswordToggles(document);

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      window.navigatePanel?.("network");
    });
  }

  if (refresh) {
    refresh.addEventListener("click", () => {
      showError("");
      loadUsers();
    });
  }

  if (form) {
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (creating) return;
      showError("");
      if (message) message.hidden = true;
      const values = form.elements;
      if (values.password.value !== values.passwordConfirmation.value) {
        showError("Las contraseñas no coinciden.");
        values.passwordConfirmation.focus();
        return;
      }
      const payload = {
        username: values.username.value.trim(),
        role: values.role.value,
        password: values.password.value,
        passwordConfirmation: values.passwordConfirmation.value
      };
      setBusy(true);
      try {
        const response = await apiFetch("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo crear el vendedor.");
        form.reset();
        hidePasswords(form);
        if (message) {
          message.textContent = "Vendedor " + data.user.username + " creado con acceso de " + (data.user.role === "ADMINISTRADOR" ? "administrador." : "ventas.");
          message.hidden = false;
        }
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

  if (editForm) {
    editForm.addEventListener("submit", async event => {
      event.preventDefault();
      if (saving) return;
      showEditError("");
      if (message) message.hidden = true;
      const values = editForm.elements;
      const password = values.password.value;
      const confirmation = values.passwordConfirmation.value;
      if (password || confirmation) {
        if (password.length < 12 || password.length > 256) {
          showEditError("La contraseña debe tener entre 12 y 256 caracteres.");
          values.password.focus();
          return;
        }
        if (password !== confirmation) {
          showEditError("Las contraseñas no coinciden.");
          values.passwordConfirmation.focus();
          return;
        }
      }
      const payload = {
        username: values.username.value.trim(),
        role: values.role.value,
        active: values.active.value === "1",
        password,
        passwordConfirmation: confirmation
      };
      setEditBusy(true);
      try {
        const response = await apiFetch("/api/users/" + encodeURIComponent(values.id.value), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo actualizar el vendedor.");
        if (editDialog) editDialog.close();
        if (message) {
          message.textContent = "Vendedor " + data.user.username + " actualizado." + (data.sessionsClosed ? " Se cerraron sus sesiones activas." : "");
          message.hidden = false;
        }
        await loadUsers();
      } catch (cause) {
        showEditError(cause.message);
      } finally {
        payload.password = "";
        payload.passwordConfirmation = "";
        setEditBusy(false);
      }
    });
  }

  if (editDialog) {
    document.getElementById("editUserClose")?.addEventListener("click", () => editDialog.close());
  }
}
