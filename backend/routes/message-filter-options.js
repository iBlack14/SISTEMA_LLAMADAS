const KINDS = ["rubro", "speech", "precio", "combo"];

const SCHEMA = `CREATE TABLE IF NOT EXISTS message_filter_options (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind ENUM('rubro','speech','precio','combo') NOT NULL,
  option_value VARCHAR(120) NOT NULL,
  description VARCHAR(200) NOT NULL DEFAULT '',
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY message_filter_options_kind_value (kind, option_value),
  CONSTRAINT message_filter_options_creator_fk FOREIGN KEY (created_by) REFERENCES auth_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const schemaReady = new WeakMap();

async function ensureSchema(db) {
  if (!schemaReady.has(db)) {
    const pending = db.query(SCHEMA).catch(error => {
      schemaReady.delete(db);
      throw error;
    });
    schemaReady.set(db, pending);
  }
  await schemaReady.get(db);
}

function cleanOption(input = {}) {
  const kind = String(input.kind || "").trim();
  const value = String(input.value || "").trim().slice(0, 120);
  const description = String(input.description || "").trim().slice(0, 200);
  if (!KINDS.includes(kind)) throw new Error("Tipo de filtro no válido.");
  if (!value) throw new Error("Escribe el nombre de la categoría.");
  return { kind, value, description };
}

function routeError(res, error) {
  if (error.message?.includes("categoría") || error.message?.includes("filtro")) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  console.error("Error en opciones de filtros de mensajes:", error);
  return res.status(503).json({ ok: false, error: "No se pudieron guardar las categorías en la base de datos." });
}

export function registerMessageFilterOptions(runtime) {
  const { app, auth } = runtime;
  const db = () => auth.pool;

  app.get("/api/message-filter-options", auth.requireUser, async (req, res) => {
    try {
      const pool = db();
      if (!pool) throw new Error("DATABASE_UNAVAILABLE");
      await ensureSchema(pool);
      const [rows] = await pool.query(`SELECT kind, option_value, description, created_by
        FROM message_filter_options ORDER BY kind, option_value`);
      const options = { rubro: [], speech: [], precio: [], combo: [] };
      for (const row of rows) {
        if (!options[row.kind]) continue;
        options[row.kind].push({
          value: row.option_value,
          description: row.description || "",
          canDelete: req.user.role === "ADMINISTRADOR" || String(row.created_by) === String(req.user.id)
        });
      }
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, options });
    } catch (error) {
      return routeError(res, error);
    }
  });

  app.post("/api/message-filter-options", auth.requireUser, auth.csrf, async (req, res) => {
    try {
      const item = cleanOption(req.body);
      const pool = db();
      if (!pool) throw new Error("DATABASE_UNAVAILABLE");
      await ensureSchema(pool);
      await pool.query(`INSERT INTO message_filter_options (kind, option_value, description, created_by)
        VALUES (?,?,?,?)
        ON DUPLICATE KEY UPDATE description=VALUES(description)`,
        [item.kind, item.value, item.description, req.user.id]);
      return res.status(201).json({ ok: true, option: { ...item, canDelete: true } });
    } catch (error) {
      return routeError(res, error);
    }
  });

  app.delete("/api/message-filter-options", auth.requireUser, auth.csrf, async (req, res) => {
    try {
      const item = cleanOption({ kind: req.query.kind, value: req.query.value });
      const pool = db();
      if (!pool) throw new Error("DATABASE_UNAVAILABLE");
      await ensureSchema(pool);
      const clause = req.user.role === "ADMINISTRADOR"
        ? "kind=? AND option_value=?"
        : "kind=? AND option_value=? AND created_by=?";
      const params = req.user.role === "ADMINISTRADOR"
        ? [item.kind, item.value]
        : [item.kind, item.value, req.user.id];
      await pool.query(`DELETE FROM message_filter_options WHERE ${clause}`, params);
      return res.json({ ok: true });
    } catch (error) {
      return routeError(res, error);
    }
  });
}
