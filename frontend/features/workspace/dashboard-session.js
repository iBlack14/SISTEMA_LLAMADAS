// Dashboard and reports must use the same account-scoped storage keys.
export function dashboardSessionKeys(userId) {
  if (userId == null || String(userId).trim() === "") return null;
  const prefix = `voip vc.auth.${userId}.`;
  return {
    session: `${prefix}dashboardSessionCode`,
    tokenPrefix: `${prefix}dashboardToken.`,
    client: `${prefix}dashboardClientId`
  };
}

export function readDashboardSession(storage, userId) {
  const keys = dashboardSessionKeys(userId);
  if (!keys) return { code: "", token: "" };
  const code = String(storage.getItem(keys.session) || "").trim().toUpperCase();
  const token = code ? String(storage.getItem(`${keys.tokenPrefix}${code}`) || "").trim() : "";
  return { code, token };
}
