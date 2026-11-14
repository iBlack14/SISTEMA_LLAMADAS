// URLs anteriores redirigidas a un único módulo; evita duplicar estado del navegador.
const redirects = {
  "/dashboard.js": "/app/bootstrap.js",
  "/sidebar.js": "/layouts/dashboard/sidebar.js",
  "/admin.js": "/features/admin/network/network-page.js",
  "/admin-users.js": "/features/admin/users/users-page.js",
  "/login.js": "/features/auth/login-page.js",
  "/modules/auth.js": "/features/auth/auth-session.js",
  "/modules/socket.js": "/shared/realtime/socket.js",
  "/modules/dom.js": "/shared/ui/dom.js",
  "/modules/audio-bridge.js": "/features/calls/audio/audio-bridge.js",
  "/modules/whatsapp.js": "/features/messaging/whatsapp.js",
  "/modules/contacts.js": "/features/contacts/contacts-repository.js",
  "/modules/calendar-ui.js": "/features/reports/calendar-ui.js",
  "/modules/dashboard-session.js": "/features/workspace/dashboard-session.js",
  "/modules/panel-navigation.js": "/app/navigation/panel-navigation.js",
  "/modules/report-period.js": "/features/reports/report-period.js",
  "/modules/detailed-report.js": "/features/reports/detailed-report.js",
  "/modules/reports.js": "/features/reports/reports-page.js",
  "/modules/report-metrics.js": "/shared/reports/report-metrics.js",
  "/styles.css": "/shared/styles/base.css",
  "/sidebar.css": "/layouts/dashboard/sidebar.css",
  "/account.css": "/layouts/dashboard/account.css",
  "/admin.css": "/features/admin/network/network.css",
  "/auth.css": "/features/auth/auth.css",
  "/blocked-numbers.css": "/features/blocked-numbers/blocked-numbers.css",
  "/call-outcomes.css": "/features/calls/call-outcomes.css",
  "/contact-tabs.css": "/features/contacts/contact-tabs.css",
  "/report-details.css": "/features/reports/report-details.css",
  "/report-selection.css": "/features/reports/report-selection.css"
};

export function registerLegacyAssets({ app }) {
  app.use((req, res, next) => {
    const destination = redirects[req.path];
    if ((req.method === "GET" || req.method === "HEAD") && destination) return res.redirect(302, destination);
    next();
  });
}
