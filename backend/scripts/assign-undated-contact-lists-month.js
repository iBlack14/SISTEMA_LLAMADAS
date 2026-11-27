import "dotenv/config";
import mysql from "mysql2/promise";
import { assertEasypanelConfig } from "../services/auth/config.js";

const month = String(process.argv[2] || "").trim();
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
  throw new Error("Uso: node backend/scripts/assign-undated-contact-lists-month.js AAAA-MM");
}
if (process.env.DB_NAME !== "llamadas1") {
  throw new Error("La asignación histórica solo se permite en la base EasyPanel llamadas1.");
}
assertEasypanelConfig();

const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  timezone: "Z",
  connectTimeout: 10000,
  ...(process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {})
});

try {
  const [[target]] = await connection.query("SELECT DATABASE() AS db, @@hostname AS db_host");
  if (target.db !== "llamadas1") throw new Error("La conexión no apunta a la base EasyPanel llamadas1.");

  await connection.query(`CREATE TABLE IF NOT EXISTS vc_contact_book_month_assignments (
    session_code VARCHAR(50) NOT NULL, list_name VARCHAR(255) NOT NULL,
    month_key CHAR(7) NOT NULL, undated_contact_count INT UNSIGNED NOT NULL DEFAULT 0,
    assigned_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY(session_code,list_name,month_key),
    INDEX vc_contact_book_month(month_key,session_code,list_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const [lists] = await connection.query(`SELECT session_code,list_name,COUNT(*) AS undated_contact_count
    FROM vc_contact_book_contacts
    WHERE JSON_EXTRACT(contact_data,'$.createdAt') IS NULL
      AND JSON_EXTRACT(contact_data,'$.created_at') IS NULL
    GROUP BY session_code,list_name`);
  await connection.beginTransaction();
  try {
    for (const list of lists) {
      await connection.query(`INSERT INTO vc_contact_book_month_assignments
        (session_code,list_name,month_key,undated_contact_count)
        VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE undated_contact_count=VALUES(undated_contact_count)`,
      [list.session_code, list.list_name, month, Number(list.undated_contact_count)]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }

  const summary = new Map();
  for (const list of lists) {
    const count = Number(list.undated_contact_count);
    const current = summary.get(list.list_name) || { lists: 0, contacts: 0 };
    current.lists += 1;
    current.contacts += count;
    summary.set(list.list_name, current);
  }
  console.log(JSON.stringify({
    ok: true,
    database: target.db,
    month,
    assignedLists: lists.length,
    assignedContacts: lists.reduce((sum, list) => sum + Number(list.undated_contact_count), 0),
    byList: [...summary].map(([name, counts]) => ({ list: name, ...counts }))
  }));
} finally {
  await connection.end();
}
