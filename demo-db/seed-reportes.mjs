import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionPersistence } from '../server/persistence.js';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });
const code = String(process.argv[2] || '').trim().toUpperCase();
if (!/^[A-Z0-9-]{4,50}$/.test(code)) {
  console.error('Uso: node demo-db/seed-reportes.mjs CODIGO_DE_SESION');
  process.exit(1);
}
const persistence = new SessionPersistence(process.env.SESSIONS_FILE || path.join(root, 'server', 'sessions.json'));
const sessions = await persistence.load();
const session = sessions.get(code);
if (!session) {
  console.error(`No existe la sesión ${code}. Inicia sesión en el dashboard y vuelve a intentarlo.`);
  process.exit(1);
}
if (!persistence.usingDb) {
  const filename = persistence.filePath;
  try {
    await fs.copyFile(filename, `${filename}.backup-demo-${Date.now()}`);
    console.log('Copia de seguridad JSON creada.');
  } catch (error) {
    console.error('No se pudo crear copia de seguridad:', error.message);
    process.exit(1);
  }
} else {
  console.log('ATENCIÓN: almacenamiento MySQL activo. Realiza un respaldo de la base antes de continuar.');
  if (process.argv[3] !== '--confirmar-mysql') {
    console.error('Para continuar con MySQL añade --confirmar-mysql después del código.');
    process.exit(1);
  }
}
const specs = [
  ['2026-01-22','Automóviles',20],
  ['2026-01-22','Ingeniería',20],
  ['2026-01-22','Arquitectura',15],
  ['2026-11-05','Construcción',20],
  ['2026-11-05','Tecnología',15],
  ['2026-11-05','Comercio',10]
];
const archive = Array.isArray(session.reportArchive) ? session.reportArchive : [];
for (const [date,rubro,count] of specs) {
  const id = `DEMO-${date}-${rubro.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase()}`;
  const contacts = [];
  const history = [];
  for (let i=1; i<=count; i++) {
    const suffix = String(i).padStart(3,'0');
    const phone = `TEST-${id.slice(-3)}-${suffix}`; // no es un teléfono marcable
    const state = i % 5;
    const durationSeconds = state===0 || state===1 ? 45+i : state===2 ? 12 : 0;
    const technicalResult = state===3 ? 'inoperable' : state===0 || state===1 ? 'connected' : 'no_answer';
    contacts.push({ id:`${id}-${suffix}`, name:`Empresa de prueba ${rubro} ${suffix}`, phone, list:rubro, status:'demo', technicalResult, durationSeconds });
    if (state!==4) history.push({ phone, durationSeconds, technicalResult, startedAt:`${date}T10:${String(i%60).padStart(2,'0')}:00-05:00` });
  }
  const report = {id,date,rubro,contacts,history,demo:true};
  const existing = archive.findIndex(r=>r.id===id);
  if (existing>=0) archive[existing]=report; else archive.push(report);
}
session.reportArchive=archive;
await persistence.save(sessions);
console.log(`OK: 6 reportes DEMO, 100 contactos ficticios añadidos a ${code}.`);
console.log('No se iniciaron campañas ni se enviaron llamadas.');
