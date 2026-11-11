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
