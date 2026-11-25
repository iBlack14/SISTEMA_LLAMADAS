import { nanoid } from "nanoid";
import { mergeTemplateCatalog } from "../services/messaging/template-catalog.js";
import { CAMPAIGN_FLYERS_2027 } from "../../frontend/features/messaging/campaign-flyers-2027.js";

const TEMPLATE_SCHEMA = `CREATE TABLE IF NOT EXISTS message_templates (
  user_id BIGINT UNSIGNED NOT NULL,
  id VARCHAR(120) NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(60) NOT NULL DEFAULT 'Otros',
  type ENUM('both','whatsapp','email') NOT NULL DEFAULT 'both',
  message TEXT NOT NULL,
  footer TEXT NULL,
  image MEDIUMTEXT NULL,
  is_seeded BOOLEAN NOT NULL DEFAULT FALSE,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, id),
  INDEX message_templates_user_category (user_id, category),
  CONSTRAINT message_templates_user_fk FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

const schemaReady = new WeakMap();
const MAX_IMAGE_LENGTH = 3_500_000;

async function ensureSchema(pool) {
  if (!schemaReady.has(pool)) {
    const pending = (async () => {
      await pool.query(TEMPLATE_SCHEMA);
      const migrations = [
        ["is_seeded", "BOOLEAN NOT NULL DEFAULT FALSE"],
        ["is_deleted", "BOOLEAN NOT NULL DEFAULT FALSE"],
        ["footer", "TEXT NULL"]
      ];
      for (const [column, definition] of migrations) {
        const [rows] = await pool.query(
          "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='message_templates' AND COLUMN_NAME=?",
          [column]
        );
        if (!rows.length) await pool.query(`ALTER TABLE message_templates ADD COLUMN ${column} ${definition}`);
      }
    })().catch(error => {
      schemaReady.delete(pool);
      throw error;
    });
    schemaReady.set(pool, pending);
  }
  await schemaReady.get(pool);
}

function cleanTemplate(input = {}) {
  const id = String(input.id || nanoid(14)).trim().slice(0, 120);
  const name = String(input.name || "").trim().slice(0, 120);
  const category = String(input.category || "Otros").trim().slice(0, 60) || "Otros";
  const type = ["both", "whatsapp", "email"].includes(input.type) ? input.type : "both";
  const message = String(input.message || "").trim().slice(0, 5000);
  const footer = String(input.footer || "").trim().slice(0, 2000);
  const image = input.image == null ? null : String(input.image);
  if (!/^[a-z0-9_-]{1,120}$/i.test(id) || !name || !message) throw new Error("Cada plantilla necesita un identificador, nombre y mensaje válidos.");
  if (image && (image.length > MAX_IMAGE_LENGTH || !/^(data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+|\/[a-z0-9/_\-.%]+)$/i.test(image))) {
    throw new Error("La imagen de una plantilla no es válida o supera el tamaño permitido.");
  }
  return { id, name, category, type, message, footer, image };
}

function toClient(row) {
  return {
    id: String(row.id), name: row.name, category: row.category, type: row.type,
    message: row.message, footer: row.footer || "", image: row.image || null,
    shared: Boolean(row.shared),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

function templateError(res, error) {
  if (error.message?.includes("Cada plantilla") || error.message?.includes("La imagen")) {
    return res.status(400).json({ ok: false, error: error.message });
  }
  console.error("Error en plantillas de mensajes:", error);
  return res.status(503).json({ ok: false, error: "No se pudieron guardar las plantillas en la base de datos." });
}

export function registerMessageTemplates(runtime) {
  const { app, auth } = runtime;
  const pool = () => auth.pool;
  const requireUser = auth.requireUser;
  const csrf = auth.csrf;
  const sharedTemplates = async db => {
    const [rows] = await db.query(`SELECT t.* FROM message_templates t
      JOIN auth_users u ON u.id=t.user_id
      WHERE u.role='ADMINISTRADOR'
      ORDER BY (t.is_seeded=FALSE OR t.updated_at>t.created_at) DESC,
        t.updated_at DESC,t.user_id ASC`);
    return rows;
  };
  const rejectSharedEdit = async (db, req, res, id) => {
    if (req.user.role === "ADMINISTRADOR") return false;
    if (!(await sharedTemplates(db)).some(row => String(row.id) === id)) return false;
    res.status(403).json({ ok: false, error: "Esta plantilla la administra el administrador." });
    return true;
  };

  app.get("/api/message-templates", requireUser, async (req, res) => {
    try {
      const db = pool();
      if (!db) throw new Error("DATABASE_UNAVAILABLE");
      await ensureSchema(db);
      const values = [];
      for (const flyer of CAMPAIGN_FLYERS_2027) {
        const id = `campaign-2027-${flyer.image.split("/").pop().replace(/\.webp$/i, "")}`;
        values.push(req.user.id, id, flyer.name, flyer.category || "Otros", "both",
          `Hola, te compartimos nuestro flyer de ${flyer.name}. Si deseas más información, estamos para ayudarte.`, "", flyer.image);
      }
      if (req.user.role === "ADMINISTRADOR") await db.query(`INSERT IGNORE INTO message_templates
        (user_id,id,name,category,type,message,footer,image,is_seeded) VALUES ${CAMPAIGN_FLYERS_2027.map(() => "(?,?,?,?,?,?,?,?,TRUE)").join(",")}`, values);
      const [rows] = await db.query(`SELECT id,name,category,type,message,footer,image,created_at,updated_at
        FROM message_templates WHERE user_id=? AND is_deleted=FALSE`, [req.user.id]);
      res.setHeader("Cache-Control", "no-store");
      const catalog = req.user.role === "ADMINISTRADOR" ? rows
        : mergeTemplateCatalog([], await sharedTemplates(db));
      return res.json({ ok: true, templates: catalog.map(toClient) });
    } catch (error) { return templateError(res, error); }
  });

  app.post("/api/message-templates/import", requireUser, auth.requireAdmin, csrf, async (req, res) => {
    try {
      const incoming = req.body?.templates;
      if (!Array.isArray(incoming) || incoming.length > 300) {
        return res.status(400).json({ ok: false, error: "La lista de plantillas no es válida." });
      }
      const records = incoming.map(cleanTemplate);
      const db = pool();
      if (!db) throw new Error("DATABASE_UNAVAILABLE");
      await ensureSchema(db);
      if (records.length) {
        const values = records.flatMap(item => [req.user.id, item.id, item.name, item.category, item.type, item.message, item.footer, item.image]);
        await db.query(`INSERT INTO message_templates (user_id,id,name,category,type,message,footer,image)
          VALUES ${records.map(() => "(?,?,?,?,?,?,?,?)").join(",")}
          ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),type=VALUES(type),message=VALUES(message),footer=VALUES(footer),image=VALUES(image),updated_at=CURRENT_TIMESTAMP(3)`, values);
      }
      return res.json({ ok: true, imported: records.length });
    } catch (error) { return templateError(res, error); }
  });

  app.post("/api/message-templates", requireUser, auth.requireAdmin, csrf, async (req, res) => {
    try {
      const item = cleanTemplate(req.body);
      const db = pool();
      if (!db) throw new Error("DATABASE_UNAVAILABLE");
      await ensureSchema(db);
      await db.query(`INSERT INTO message_templates (user_id,id,name,category,type,message,footer,image)
        VALUES (?,?,?,?,?,?,?,?)`, [req.user.id, item.id, item.name, item.category, item.type, item.message, item.footer, item.image]);
      const [rows] = await db.query(`SELECT id,name,category,type,message,footer,image,created_at,updated_at
        FROM message_templates WHERE user_id=? AND id=?`, [req.user.id, item.id]);
      return res.status(201).json({ ok: true, template: toClient(rows[0]) });
    } catch (error) { return templateError(res, error); }
  });

  app.patch("/api/message-templates/:id", requireUser, auth.requireAdmin, csrf, async (req, res) => {
    try {
      const item = cleanTemplate({ ...req.body, id: req.params.id });
      const db = pool();
      if (!db) throw new Error("DATABASE_UNAVAILABLE");
      await ensureSchema(db);
      if (await rejectSharedEdit(db, req, res, item.id)) return;
      const [result] = await db.query(`UPDATE message_templates SET name=?,category=?,type=?,message=?,footer=?,image=?,updated_at=CURRENT_TIMESTAMP(3)
        WHERE user_id=? AND id=?`, [item.name, item.category, item.type, item.message, item.footer, item.image, req.user.id, item.id]);
      if (!result.affectedRows) return res.status(404).json({ ok: false, error: "Plantilla no encontrada." });
      const [rows] = await db.query(`SELECT id,name,category,type,message,footer,image,created_at,updated_at
        FROM message_templates WHERE user_id=? AND id=?`, [req.user.id, item.id]);
      return res.json({ ok: true, template: toClient(rows[0]) });
    } catch (error) { return templateError(res, error); }
  });

  app.delete("/api/message-templates/:id", requireUser, auth.requireAdmin, csrf, async (req, res) => {
    try {
      const db = pool();
      if (!db) throw new Error("DATABASE_UNAVAILABLE");
      await ensureSchema(db);
      const id = String(req.params.id).slice(0, 120);
      if (await rejectSharedEdit(db, req, res, id)) return;
      if (req.user.role === "ADMINISTRADOR") {
        await db.query("UPDATE message_templates SET is_deleted=TRUE,updated_at=CURRENT_TIMESTAMP(3) WHERE user_id=? AND id=?", [req.user.id, id]);
        return res.json({ ok: true });
      }
      const [seeded] = await db.query("UPDATE message_templates SET is_deleted=TRUE WHERE user_id=? AND id=? AND is_seeded=TRUE", [req.user.id, id]);
      if (!seeded.affectedRows) await db.query("DELETE FROM message_templates WHERE user_id=? AND id=?", [req.user.id, id]);
      return res.json({ ok: true });
    } catch (error) { return templateError(res, error); }
  });
}
