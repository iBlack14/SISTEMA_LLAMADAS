import path from "path";
import { nanoid } from "nanoid";
import { runtimeIdentity, runtimeLockName, probeRuntime, waitForRuntime } from "./services/workspace/runtime-instance.js";
import { UserWorkspaces } from "./services/workspace/user-workspace.js";
import { AuthService } from "./services/auth/service.js";
import { installSocketAuth } from "./services/auth/sockets.js";
import { NetworkMonitor } from "./services/network/network-monitor.js";
import { SessionPersistence } from "./shared/persistence.js";
import { CallHistoryGate } from "./services/calls/call-history-gate.js";
import { configureEnvironment } from "./config/env.js";
import { createServerSetup } from "./config/server-setup.js";
import { registerRoutes } from "./routes/index.js";
import { registerSockets } from "./sockets/index.js";
import { createRateLimiter } from "./middleware/rate-limiter.js";
import { createRuntimeLifecycle } from "./lifecycle/runtime-lifecycle.js";
import { createSessionState } from "./session/session-state.js";
import { createSessionShape } from "./session/session-shape.js";
import { createWorkerManager } from "./session/worker-manager.js";
import { createSessionLifecycle } from "./session/session-lifecycle.js";
import { createRestrictions } from "./services/calls/restrictions.js";
import { createDispatcher } from "./services/calls/dispatcher.js";
import { createUrlResolver } from "./services/network/url-resolver.js";
import { createSessionAccess } from "./middleware/session-access.js";
import { createReportData } from "./services/reports/report-data.js";
import { createApkManager } from "./services/apk/apk-manager.js";
import { createImportUrl } from "./services/contacts/import-url.js";

/**
 * Composition extracted from server/server.js (initialization at lines 93–239,
 * workspace construction at 989 and APK paths at 2512).
 * Creates the existing components without connecting to MySQL or listening.
 * Database recovery, the existing single-writer lock and listen remain in bootstrap().
 * Authentication origins, CSRF, roles, pairing tokens and persistence defaults are
 * preserved; HTTP and socket contracts are recorded in docs/architecture/contracts.json.
 */
export function createRuntime(projectRoot) {
const runtime = { __dirname: path.join(projectRoot, "server"), paths: {
frontendRoot: path.join(projectRoot, "frontend"),
sharedRoot: path.join(projectRoot, "shared"),
dashboardPage: path.join(projectRoot, "frontend/index.html"),
loginPage: path.join(projectRoot, "frontend/login.html"),
adminPage: path.join(projectRoot, "frontend/features/admin/network/network.html")
} };
Object.assign(runtime, configureEnvironment(projectRoot), createServerSetup());
const services = {};
Object.assign(services, createRateLimiter(runtime, services));
Object.assign(services, createRuntimeLifecycle(runtime, services));
Object.assign(services, createSessionState(runtime, services));
Object.assign(services, createSessionShape(runtime, services));
Object.assign(services, createWorkerManager(runtime, services));
Object.assign(services, createSessionLifecycle(runtime, services));
Object.assign(services, createRestrictions(runtime, services));
Object.assign(services, createDispatcher(runtime, services));
Object.assign(services, createUrlResolver(runtime, services));
Object.assign(services, createSessionAccess(runtime, services));
Object.assign(services, createReportData(runtime, services));
Object.assign(services, createApkManager(runtime, services));
Object.assign(services, createImportUrl(runtime, services));
runtime.persistence = new SessionPersistence();
runtime.instanceIdentity = runtimeIdentity(process.env, path.join(runtime.__dirname, ".."));
runtime.instancePort = Number(process.env.PORT || 3000);
runtime.alreadyRunning = () => console.log(`El servidor ya está activo en http://localhost:${runtime.instancePort}/. Usa esa dirección; no se inició otra instancia.`);
runtime.authOrigins = runtime.easypanel ? [process.env.PUBLIC_BASE_URL] : [`http://127.0.0.1:${Number(process.env.PORT || 3000)}`, `http://localhost:${Number(process.env.PORT || 3000)}`];
runtime.auth = new AuthService(null, { origins: runtime.authOrigins, secure: runtime.easypanel });
runtime.network = new NetworkMonitor({ pool: null, persistence: runtime.persistence, getSessions: () => runtime.sessions,
  isSocketConnected: id => Boolean(runtime.io.sockets.sockets.get(id)?.connected),
  broadcast: snapshot => runtime.io.to("admin:network").emit("admin:network", snapshot) });
runtime.disconnectAuthSockets = installSocketAuth(runtime.io, runtime.auth, {
  onAdminSubscribe: async socket => socket.emit("admin:network", await runtime.network.snapshot())
});
runtime.pairingRateLimit = services.createRateLimiter({ windowMs: 60000, max: 180 });
runtime.remoteFetchRateLimit = services.createRateLimiter({ windowMs: 60000, max: 10 });
runtime.sessions = new Map();
runtime.historyGate = new CallHistoryGate(runtime.persistence, () => runtime.sessions);
runtime.workspaces = new UserWorkspaces({
  getPool: () => runtime.persistence.pool, getSessions: () => runtime.sessions,
  create: () => { let code; do code = nanoid(6).toUpperCase(); while (runtime.sessions.has(code)); return {code, session: services.getOrCreateSession(code)}; },
  save: () => runtime.persistence.save(runtime.sessions), grant: (user, code) => runtime.auth.grant(user, code)
});
runtime.APK_PATHS = [
  path.join(runtime.__dirname, "../android-app/app/build/outputs/apk/release/Phone-VC-release.apk"),
  path.join(runtime.__dirname, "../android-app/app/build/outputs/apk/debug/Phone-VC-debug.apk"),
  path.join(runtime.__dirname, "../android-app/app/build/intermediates/apk/debug/app-debug.apk")
];
runtime.APK_SEARCH_DIRS = [
  path.join(runtime.__dirname, "../android-app/app/build/outputs/apk"),
  path.join(runtime.__dirname, "../android-app/releases")
];
runtime.shuttingDown = false;
registerRoutes(runtime, services);
registerSockets(runtime, services);
return { runtime, services };
}
