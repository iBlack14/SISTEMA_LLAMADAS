import * as Contacts from '../contacts/contacts-repository.js';

/**
 * createListAssignments: conserva los contratos y reglas existentes.
 * Dependencias: dashboardState.sessionCode.
 * Se construye una vez por dashboard.
 */
export function createListAssignments(dashboardState, dashboardActions) {
function getHiddenAssignedRecords() {
  if (!dashboardState.sessionCode) return new Set();
  try {
    const saved = Contacts.getPreference("hiddenAssignedRecords", []);
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  } catch {
    return new Set();
  }
}

function hideAssignedRecord(listName) {
  if (!dashboardState.sessionCode || !listName) return;
  const hidden = getHiddenAssignedRecords();
  hidden.add(String(listName));
  Contacts.setPreference("hiddenAssignedRecords", [...hidden]);
}
return { getHiddenAssignedRecords, hideAssignedRecord };
}
