import { refs, setStatus, setBadge, setAckBadge } from './dom.js';

/**
 * createDialogs: conserva los contratos y reglas existentes.
 * Dependencias: .
 * Se construye una vez por dashboard.
 */
export function createDialogs(dashboardState, dashboardActions) {
function requestListName({ title = "Nueva lista", defaultValue = "", label = "Nombre de la lista", placeholder = "Ej. Avícolas" } = {}) {
  return new Promise((resolve) => {
    const modal = refs.listNameModalEl;
    const input = refs.listNameInputEl;
    if (!modal || !input) return resolve(null);

    refs.listNameTitleEl.textContent = title;
    if (refs.listNameLabelEl) refs.listNameLabelEl.textContent = label;
    refs.listNameErrorEl.textContent = "";
    input.value = defaultValue;
    input.placeholder = placeholder;
    modal.style.display = "grid";

    const finish = (value) => {
      modal.style.display = "none";
      refs.listNameSaveBtn.onclick = null;
      refs.listNameCancelBtn.onclick = null;
      refs.listNameCloseBtn.onclick = null;
      input.onkeydown = null;
      resolve(value);
    };
    const save = () => {
      const value = input.value.trim();
      if (!value) {
        refs.listNameErrorEl.textContent = "Escribe un nombre para la lista.";
        input.focus();
        return;
      }
      finish(value);
    };

    refs.listNameSaveBtn.onclick = save;
    refs.listNameCancelBtn.onclick = () => finish(null);
    refs.listNameCloseBtn.onclick = () => finish(null);
    input.onkeydown = (event) => {
      if (event.key === "Enter") save();
      if (event.key === "Escape") finish(null);
    };
    setTimeout(() => input.focus(), 0);
  });
}

function requestConfirmation({ title = "Confirmar acción", message = "", confirmLabel = "Aceptar", cancelLabel = "Cancelar", showCancel = true } = {}) {
  return new Promise((resolve) => {
    const modal = refs.confirmModalEl;
    if (!modal) return resolve(false);
    refs.confirmTitleEl.textContent = title;
    refs.confirmMessageEl.textContent = message;
    refs.confirmAcceptBtn.textContent = confirmLabel;
    refs.confirmCancelBtn.textContent = cancelLabel;
    refs.confirmCancelBtn.style.display = showCancel ? "" : "none";
    modal.style.display = "grid";

    const finish = (accepted) => {
      modal.style.display = "none";
      refs.confirmAcceptBtn.onclick = null;
      refs.confirmCancelBtn.onclick = null;
      refs.confirmCloseBtn.onclick = null;
      resolve(accepted);
    };
    refs.confirmAcceptBtn.onclick = () => finish(true);
    refs.confirmCancelBtn.onclick = () => finish(false);
    refs.confirmCloseBtn.onclick = () => finish(false);
    setTimeout(() => refs.confirmAcceptBtn.focus(), 0);
  });
}
return { requestListName, requestConfirmation };
}
