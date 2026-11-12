// Phase one is deliberately restricted to a separate local database.
export const LOCAL_DATABASE = "sistema_llamadas_auth_local";

export function assertIsolatedConfig(env = process.env) {
  if (env.AUTH_LOCAL_ISOLATED !== "1" || env.DB_HOST !== "127.0.0.1"
      || env.DB_NAME !== LOCAL_DATABASE || Number(env.DB_PORT) !== 3308 || env.DB_USER !== "calls_auth_local") {
    throw new Error("Esta fase solo admite la base local aislada. Ejecuta npm run auth:local; no se usará la base de .env.");
  }
}

export function assertXamppConfig(env = process.env) {
  const host = String(env.DB_HOST || "").toLowerCase();
  if (env.AUTH_LOCAL_ISOLATED === "1" || !["127.0.0.1", "localhost", "::1"].includes(host)
      || Number(env.DB_PORT || 3306) !== 3306 || !env.DB_NAME || !env.DB_USER) {
    throw new Error("XAMPP local requiere DB_HOST=localhost, DB_PORT=3306 (o sin definir), DB_NAME y DB_USER en .env.");
  }
}

export function assertEasypanelConfig(env = process.env) {
  if (env.APP_ENV !== "easypanel" || env.AUTH_LOCAL_ISOLATED === "1") {
    throw new Error("El perfil EasyPanel requiere APP_ENV=easypanel, sin AUTH_LOCAL_ISOLATED.");
  }
  for (const key of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    if (!String(env[key] || "").trim()) throw new Error(`Falta ${key} en EasyPanel.`);
  }
  for (const [key, fallback] of [["PORT", 3000], ["DB_PORT", 3306]]) {
    const port = Number(env[key] || fallback);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Puerto inválido: ${key}.`);
  }
  let url;
  try { url = new URL(env.PUBLIC_BASE_URL); } catch { throw new Error("PUBLIC_BASE_URL debe ser una URL HTTPS."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.pathname !== "/") throw new Error("PUBLIC_BASE_URL debe ser un origen HTTPS sin ruta ni credenciales.");
  return url.origin;
}
