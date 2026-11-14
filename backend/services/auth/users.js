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

export function validateUserUpdate(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Introduce los datos del usuario.");
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const role = body.role ?? "EMPLEADO";
  if (!/^[a-z0-9._-]{3,80}$/.test(username))
    throw new Error("El usuario debe tener entre 3 y 80 caracteres: letras, números, punto, guion o guion bajo.");
  if (!["EMPLEADO", "ADMINISTRADOR"].includes(role))
    throw new Error("Selecciona un acceso válido.");
  const active = body.active === undefined ? true : Boolean(body.active);
  const password = typeof body.password === "string" ? body.password : "";
  const passwordConfirmation = typeof body.passwordConfirmation === "string" ? body.passwordConfirmation : "";
  if (password || passwordConfirmation) {
    // Only a provided password is rewritten; an empty pair keeps the current one.
    if (password.length < 12 || password.length > 256)
      throw new Error("La contraseña debe tener entre 12 y 256 caracteres.");
    if (password !== passwordConfirmation)
      throw new Error("Las contraseñas no coinciden.");
  }
  return { username, role, active, password: password || null };
}

export function registerUserRoutes(app, auth) {
  app.get("/api/users", auth.requireAdmin, async (req, res) => {
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
  app.post("/api/users", auth.requireAdmin, auth.csrf, async (req, res) => {
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
  app.patch("/api/users/:id", auth.requireAdmin, auth.csrf, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ ok: false, error: "Usuario no válido." });
    let input;
    try {
      if (!req.is("application/json")) throw new Error("Envía los datos en formato JSON.");
      input = validateUserUpdate(req.body);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    if (id === req.user.id && (input.role !== "ADMINISTRADOR" || !input.active))
      return res.status(400).json({ ok: false, error: "No puedes quitarte a ti mismo el acceso de administrador." });
    try {
      const [existing] = await auth.pool.query("SELECT id FROM auth_users WHERE id=?", [id]);
      if (!existing.length) return res.status(404).json({ ok: false, error: "El usuario ya no existe." });
      const fields = ["username=?", "role=?", "active=?"];
      const args = [input.username, input.role, input.active ? 1 : 0];
      if (input.password) {
        // A new password ends every open session for that account.
        fields.push("password_hash=?", "auth_version=auth_version+1");
        args.push(await hashPassword(input.password));
      }
      args.push(id);
      await auth.pool.query(`UPDATE auth_users SET ${fields.join(",")} WHERE id=?`, args);
      if (input.password) await auth.pool.query("DELETE FROM auth_sessions WHERE user_id=?", [id]);
      res.json({ ok: true, sessionsClosed: Boolean(input.password), user: {
        id, username: input.username, role: input.role, active: input.active
      } });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY")
        return res.status(409).json({ ok: false, error: "Ese nombre de usuario ya existe. Elige otro." });
      res.status(503).json({ ok: false, error: "No se pudo actualizar el usuario. Intenta de nuevo." });
    }
  });
}
