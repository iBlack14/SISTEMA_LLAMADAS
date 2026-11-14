# Historial permanente en MySQL

El servidor exige DB_HOST, DB_PORT, DB_NAME, DB_USER y DB_PASSWORD en .env.
No usa SESSIONS_FILE, archivos de sesiones ni una alternativa local si MySQL falla.
Sin configuración o conexión válida, no arranca. start:local también usa MySQL.

Sesiones y cada intento se guardan en una transacción. Se conserva contacto, lista,
equipo, turno, inicio/conexión/fin UTC, fecha Lima, espera, tiempo conectado, tiempo
total y resultado. El tiempo conectado no confirma que atendió una persona.
Cada reintento tiene otro attemptId. Eliminar una lista no borra sus intentos.
Los reportes requieren el token de la sesión y admiten from, to y phone.

Si una escritura falla se bloquean nuevas llamadas y no se confirma éxito al
celular. Se reintenta cada 10 segundos mientras el proceso permanece activo.
No existe una cola de recuperación en disco en el modo normal: si el proceso se
pierde antes del commit, sólo están garantizados los datos ya confirmados en MySQL.

## Importar los datos anteriores

Los archivos existentes no se borran ni se cargan automáticamente.
Detener campañas y ejecutar una sola vez, con MySQL configurado:

    npm run migrate:history -- --import server/sessions.json

La importación es explícita e idempotente por sesión/attemptId. Después iniciar
con npm start. El usuario MySQL necesita CREATE, SELECT, INSERT y UPDATE.
No se ejecuta DROP, TRUNCATE ni DELETE del historial.

## Copias opcionales

npm run backup:history exporta MySQL a un archivo privado; no es el almacenamiento
principal. npm run restore:history -- ruta/copia.json restaura aditivamente sin
borrar intentos ni reemplazar sesiones existentes. Configurar CALL_BACKUP_DIR
fuera de web. Las copias contienen tokens privados: no compartirlas.
CALL_BACKUP_INTERVAL_HOURS permite exportaciones periódicas; por defecto están
desactivadas en el servidor. Configurar además copias externas de MySQL en el VPS.

## Bases y avance

Las bases completas (incluidas listas vacías), contactos, notas, lista activa,
contadores, recordatorios y preferencias del panel se guardan en contactBook dentro
del JSON de la tabla sessions. No dependen de localStorage; el navegador sólo
conserva la identificación y el token de acceso de la sesión.

El panel importa una sola vez la base antigua del navegador al abrir la sesión.
Si ya existe una base en MySQL, combina los contactos sin duplicar por lista y
teléfono. Sólo retira la copia antigua del navegador después de confirmar el guardado.
Los cambios usan una revisión para rechazar sobrescrituras desde una vista antigua.
Los errores de guardado se muestran y bloquean acciones de campaña desde esa vista.

El límite de llamadas es global por teléfono en este servidor y su base MySQL:
una llamada por cada 12 meses desde el último intento, incluso si fue buzón o
sin respuesta. El historial se carga desde MySQL al arrancar; también se consideran
las asignaciones en curso de todas las sesiones para impedir duplicados simultáneos.
Normaliza +51, espacios y signos. Cambiar lista, ID, turno o sesión no evita el bloqueo.
La fecha de expiración es el aniversario exacto; 29 de febrero vence el 28 de febrero.

Se aplica en llamadas generales, independientes, manuales y desde reportes.
El panel muestra Número llamado anteriormente y desactiva LLAMAR hasta vencer
el plazo. Los contactos omitidos no generan otro intento. Una asignación válida se
guarda en MySQL antes de enviar la orden al celular. Si falla el guardado no se marca.
Las llamadas ya en curso se conservan. Finalizar el turno conserva la base y el avance.
Las bases y reportes privados siguen separados por sesión: sólo se comparte la
comprobación del límite, sin revelar datos del operador o de otras listas.
Para continuar trabajando una base, restaurar la misma sesión.

Validación: pruebas de importación, eliminación, normalización y exclusión por
historial, más una prueba optativa con MySQL real:
TEST_MYSQL_HISTORY=1 node --test server/contact-book.mysql.test.js
La prueba real usa una sesión aleatoria con datos sintéticos y limpia sólo esas filas.
No ejecuta llamadas ni modifica contactos reales.
