import { hashPassword } from "./passwords.js";

export function validateNewUser(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Introduce los datos del usuario.");
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const role = body.role ?? "EMPLEADO";
  const company = body.company ? String(body.company).trim().slice(0, 120) : null;
  if (!/^[a-z0-9._-]{3,80}$/.test(username))
    throw new Error("El usuario debe tener entre 3 y 80 caracteres: letras, números, punto, guion o guion bajo.");
  if (!["EMPLEADO", "ADMINISTRADOR"].includes(role))
    throw new Error("Selecciona un acceso válido.");
  if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 256)
    throw new Error("La contraseña debe tener entre 12 y 256 caracteres.");
  if (body.password !== body.passwordConfirmation)
    throw new Error("Las contraseñas no coinciden.");
  return { username, role, company, password: body.password };
}

export function validateUserUpdate(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Introduce los datos del usuario.");
  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const role = body.role ?? "EMPLEADO";
  const company = body.company !== undefined ? (body.company ? String(body.company).trim().slice(0, 120) : null) : undefined;
  if (!/^[a-z0-9._-]{3,80}$/.test(username))
    throw new Error("El usuario debe tener entre 3 y 80 caracteres: letras, números, punto, guion o guion bajo.");
  if (!["EMPLEADO", "ADMINISTRADOR"].includes(role))
    throw new Error("Selecciona un acceso válido.");
  const active = body.active === undefined ? true : Boolean(body.active);
  const password = typeof body.password === "string" ? body.password : "";
  const passwordConfirmation = typeof body.passwordConfirmation === "string" ? body.passwordConfirmation : "";
  if (password || passwordConfirmation) {
    if (password.length < 12 || password.length > 256)
      throw new Error("La contraseña debe tener entre 12 y 256 caracteres.");
    if (password !== passwordConfirmation)
      throw new Error("Las contraseñas no coinciden.");
  }
  const result = { username, role, active, password: password || null };
  if (company !== undefined) result.company = company;
  return result;
}

export function registerUserRoutes(app, auth) {
  app.get("/api/users", auth.requireAdmin, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const [rows] = await auth.pool.query(
        "SELECT id,username,role,company,active,created_at FROM auth_users ORDER BY username");
      res.json({ ok: true, users: rows.map(row => ({
        id: row.id, username: row.username, role: row.role, company: row.company,
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
        "INSERT INTO auth_users(username,password_hash,role,company) VALUES (?,?,?,?)",
        [input.username, encoded, input.role, input.company]);
      res.status(201).json({ ok: true, user: {
        id: result.insertId, username: input.username, role: input.role, company: input.company, active: true
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
      if (input.company !== undefined) {
        fields.push("company=?");
        args.push(input.company);
      }
      if (input.password) {
        fields.push("password_hash=?", "auth_version=auth_version+1");
        args.push(await hashPassword(input.password));
      }
      args.push(id);
      await auth.pool.query(`UPDATE auth_users SET ${fields.join(",")} WHERE id=?`, args);
      if (input.password) await auth.pool.query("DELETE FROM auth_sessions WHERE user_id=?", [id]);
      res.json({ ok: true, sessionsClosed: Boolean(input.password), user: {
        id, username: input.username, role: input.role, company: input.company, active: input.active
      } });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY")
        return res.status(409).json({ ok: false, error: "Ese nombre de usuario ya existe. Elige otro." });
      res.status(503).json({ ok: false, error: "No se pudo actualizar el usuario. Intenta de nuevo." });
    }
  });
}
