import { apiFetch, bindAccountControls, requireLogin } from "../../auth/auth-session.js";

try {
  const user = await requireLogin();
  if (user.role === "ADMINISTRADOR") {
    bindAccountControls();
    bindUsers();
  }
} catch (cause) {
  const accountError = document.getElementById("accountError");
  if (accountError) accountError.textContent = cause.message;
  const usersBtn = document.getElementById("usersButton");
  if (usersBtn) usersBtn.disabled = true;
}

function bindUsers() {
  const networkView = document.getElementById("networkView");
  const usersView = document.getElementById("usersView");
  const form = document.getElementById("createUserForm");
  const error = document.getElementById("usersError");
  const message = document.getElementById("usersMessage");
  const backBtn = document.getElementById("usersBackBtn");
  const refresh = document.getElementById("usersRefresh");
  const listsRefresh = document.getElementById("userListsRefresh");
  const editDialog = document.getElementById("editUserDialog");
  const editForm = document.getElementById("editUserForm");
  const editError = document.getElementById("editUserError");
  let creating = false;
  let saving = false;
  let loading = false;
  let requestNumber = 0;
  let listsRequestNumber = 0;
  let listsLoaded = false;

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
      status.textContent = "Cargando usuarios…";
    }
    try {
      const response = await apiFetch("/api/users", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar los usuarios.");
      if (request !== requestNumber) return;
      const body = document.getElementById("usersRows");
      if (body) {
        body.replaceChildren();
        for (const account of data.users) {
          const row = document.createElement("tr");
          for (const value of [account.username, account.role === "ADMINISTRADOR" ? "Administrador" : "Ventas", account.active ? "Activo" : "Inactivo"]) {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.appendChild(cell);
          }
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
        status.textContent = data.users.length ? "" : "Todavía no hay cuentas registradas.";
        status.hidden = Boolean(data.users.length);
      }
    } catch (cause) {
      if (request !== requestNumber) return;
      if (status) status.textContent = "No se pudo actualizar la lista.";
      showError(cause.message);
    } finally {
      if (request === requestNumber) {
        loading = false;
        if (refresh) refresh.disabled = creating;
      }
    }
  }

  async function loadUserLists() {
    const request = ++listsRequestNumber;
    if (listsRefresh) listsRefresh.disabled = true;
    const status = document.getElementById("userListsLoading");
    if (status) { status.hidden = false; status.textContent = "Cargando listas…"; }
    try {
      const response = await apiFetch("/api/users/lists", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "No se pudieron cargar las listas.");
      if (request !== listsRequestNumber) return;
      const body = document.getElementById("userListsRows");
      if (body) {
        body.replaceChildren();
        for (const account of data.users) {
          const lists = account.lists.length ? account.lists : [{ name: "Sin listas", count: 0 }];
          for (const list of lists) {
            const row = document.createElement("tr");
            for (const value of [account.username, account.role === "ADMINISTRADOR" ? "Administrador" : "Ventas", account.active ? "Activo" : "Inactivo", list.name, String(list.count)]) {
              const cell = document.createElement("td");
              cell.textContent = value;
              row.appendChild(cell);
            }
            body.appendChild(row);
          }
        }
      }
      if (status) { status.textContent = data.users.length ? "" : "No hay usuarios registrados."; status.hidden = Boolean(data.users.length); }
      listsLoaded = true;
    } catch (cause) {
      if (request !== listsRequestNumber) return;
      if (status) { status.textContent = cause.message || "No se pudieron cargar las listas."; status.hidden = false; }
    } finally {
      if (request === listsRequestNumber && listsRefresh) listsRefresh.disabled = false;
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

  function showAdminView(view) {
    const isUsers = view === "users";
    if (networkView) networkView.hidden = isUsers;
    if (usersView) usersView.hidden = !isUsers;

    if (isUsers) {
      showError("");
      if (message) message.hidden = true;
      document.getElementById("newUsername")?.focus();
      if (window.location.pathname !== "/usuarios") {
        history.pushState(null, "", "/usuarios");
      }
      loadUsers();
      if (!listsLoaded) loadUserLists();
    } else {
      clearPasswords();
      if (window.location.pathname !== "/nucleo-red") {
        history.pushState(null, "", "/nucleo-red");
      }
    }

    document.dispatchEvent(new CustomEvent("panel:view", { detail: isUsers ? "users" : "network" }));
  }

  window.showAdminView = showAdminView;
  bindPasswordToggles(document);

  const usersButton = document.getElementById("usersButton");
  if (usersButton) {
    usersButton.addEventListener("click", () => {
      showAdminView("users");
    });
  }

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      showAdminView("network");
    });
  }

  const syncFromPath = () => {
    if (window.location.pathname === "/usuarios") {
      showAdminView("users");
    } else {
      showAdminView("network");
    }
  };

  window.addEventListener("popstate", syncFromPath);
  syncFromPath();

  if (refresh) {
    refresh.addEventListener("click", () => {
      showError("");
      loadUsers();
    });
  }
  if (listsRefresh) listsRefresh.addEventListener("click", () => { listsLoaded = false; loadUserLists(); });

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
        if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo crear el usuario.");
        form.reset();
        hidePasswords(form);
        if (message) {
          message.textContent = "Usuario " + data.user.username + " creado con acceso de " + (data.user.role === "ADMINISTRADOR" ? "administrador." : "ventas.");
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
        if (!response.ok || !data.ok) throw new Error(data.error || "No se pudo actualizar el usuario.");
        if (editDialog) editDialog.close();
        if (message) {
          message.textContent = "Usuario " + data.user.username + " actualizado." + (data.sessionsClosed ? " Se cerraron sus sesiones activas." : "");
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
