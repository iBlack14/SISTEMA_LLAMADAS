// Extracción de server/server.js, líneas 28–54: se conservan exactamente
// las políticas y valores existentes; solo cambia su ubicación y se inyectan dependencias.
import path from "path";
import dotenv from "dotenv";
import { assertIsolatedConfig, assertXamppConfig, assertEasypanelConfig } from "../services/auth/config.js";

// Conserva los perfiles y la ubicación de .env.
export function configureEnvironment(projectRoot) {
const __dirname = path.join(projectRoot, "server");
if (process.env.AUTH_LOCAL_ISOLATED !== "1") dotenv.config({ path: path.join(__dirname, "..", ".env") });
const easypanel = process.env.APP_ENV === "easypanel";
if (easypanel) {
  const origin = assertEasypanelConfig();
  process.env.PUBLIC_BASE_URL = origin;
  process.env.PUBLIC_WEB_BASE_URL = origin;
  process.env.CORS_ORIGIN = origin;
  process.env.HOST = "0.0.0.0";
  process.env.TRUST_PROXY = "1";
  process.env.LOCAL_LAN_BASE_URL = "";
} else if (process.env.AUTH_LOCAL_ISOLATED === "1") assertIsolatedConfig();
else {
  assertXamppConfig();
  const port = Number(process.env.PORT || 3000);
  const localBase = `http://127.0.0.1:${port}`;
  process.env.DB_HOST = "127.0.0.1";
  process.env.HOST = "127.0.0.1";
  process.env.TRUST_PROXY = "0";
  process.env.CORS_ORIGIN = `${localBase},http://localhost:${port}`;
  process.env.PUBLIC_BASE_URL = localBase;
  process.env.PUBLIC_WEB_BASE_URL = localBase;
  process.env.LOCAL_LAN_BASE_URL = "";
}
return { easypanel };
}
