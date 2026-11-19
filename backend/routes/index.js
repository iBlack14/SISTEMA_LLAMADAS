import { registerHttpMiddleware } from "../middleware/http.js";
import { registerNetwork } from "./network.js";
import { registerPages } from "./pages.js";
import { registerSessionAccess } from "../middleware/operational-access.js";
import { registerDevices } from "./devices.js";
import { registerSessions } from "./sessions.js";
import { registerReports } from "./reports.js";
import { registerCampaigns } from "./campaigns.js";
import { registerServerInfo } from "./server-info.js";
import { registerApk } from "./apk.js";
import { registerProxy } from "./proxy.js";
import { registerTwilio } from "./twilio.js";
import { registerStatic } from "./static.js";
import { registerReservations } from "./reservations.js";
import { registerMessageTemplates } from "./message-templates.js";
import { registerMessageFilterOptions } from "./message-filter-options.js";
import { registerEmail } from "./email.js";

// El orden mantiene autenticación y autorización antes de las rutas protegidas.
export function registerRoutes(runtime, services) {
  registerHttpMiddleware(runtime, services);
  registerNetwork(runtime, services);
  registerPages(runtime, services);
  registerSessionAccess(runtime, services);
  registerDevices(runtime, services);
  registerSessions(runtime, services);
  registerReports(runtime, services);
  registerReservations(runtime, services);
  registerMessageTemplates(runtime);
  registerMessageFilterOptions(runtime);
  registerEmail(runtime);
  registerCampaigns(runtime, services);
  registerServerInfo(runtime, services);
  registerApk(runtime, services);
  registerProxy(runtime, services);
  registerTwilio(runtime, services);
  registerStatic(runtime, services);
}
