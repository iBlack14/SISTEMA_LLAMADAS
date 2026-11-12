import { hashPassword } from "./passwords.js";

export function validateNewUser(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Introduce los datos del usuario.");
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const role = body.role ?? "EMPLEADO";
  if (!/^[a-z0-9._-]{3,80}$/.test(username))
    throw new Error("El usuario debe tener entre 3 y 80 caracteres: letras, números, punto, guion o guion bajo.");
  if (!["EMPLEADO", "ADMINISTRADOR"].includes(role))
    throw new Error("Selecciona un acceso válido.");
  if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 256)
    throw new Error("La contraseña debe tener entre 12 y 256 caracteres.");
  if (body.password !== body.passwordConfirmation)
    throw new Error("Las contraseñas no coinciden.");
  return { username, role, password: body.password };
}

export function registerUserRoutes(app, auth) {
  // Explicit guards are required even when mounted before the other admin APIs.
  app.get("/api/admin/users", auth.requireAdmin, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const [rows] = await auth.pool.query(
        "SELECT id,username,role,active,created_at FROM auth_users ORDER BY username");
      res.json({ ok: true, users: rows.map(row => ({
        id: row.id, username: row.username, role: row.role,
        active: Boolean(Number(row.active)), createdAt: row.created_at
      })) });
    } catch {
      res.status(503).json({ ok: false, error: "No se pudieron cargar los usuarios. Intenta de nuevo." });
    }
  });
  app.post("/api/admin/users", auth.requireAdmin, auth.csrf, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    let input;
    try {
      if (!req.is("application/json")) throw new Error("Envía los datos en formato JSON.");
      input = validateNewUser(req.body);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    try {
      const encoded = await hashPassword(input.password);
      const [result] = await auth.pool.query(
        "INSERT INTO auth_users(username,password_hash,role) VALUES (?,?,?)",
        [input.username, encoded, input.role]);
      res.status(201).json({ ok: true, user: {
        id: result.insertId, username: input.username, role: input.role, active: true
      } });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY")
        return res.status(409).json({ ok: false, error: "Ese nombre de usuario ya existe. Elige otro." });
      res.status(503).json({ ok: false, error: "No se pudo crear el usuario. Intenta de nuevo." });
    }
  });
}
