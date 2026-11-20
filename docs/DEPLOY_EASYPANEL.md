# Prueba de SERVER en EasyPanel

La imagen arranca `backend/index.js` y contiene `backend/`, `frontend/`, `shared/` y los puentes y recursos históricos. La web usa Vanilla JS y no necesita compilación React.

Consulta [la arquitectura](architecture/README.md) antes de modificar rutas o servicios.

1. Crea una base MySQL de pruebas en EasyPanel. Usa su host interno, no localhost.
   Mantén una sola instancia de la aplicación por base de datos.
2. En el servicio de la app selecciona Source / Upload y sube un paquete actualizado del proyecto que incluya las nuevas carpetas.
3. Selecciona el builder Dockerfile, ruta Dockerfile y contexto raíz.
4. Copia las variables de easypanel.env.example en Environment y reemplaza todos
   los valores REEMPLAZAR con los datos del servicio MySQL.
   Ingresa DB_PASSWORD directamente en EasyPanel.
   No configures AUTH_LOCAL_ISOLATED.
5. En Domains configura https://llamadas1-v1.tvxk4m.easypanel.host
   con puerto de destino 3000 y HTTPS.
6. Si vas a normalizar una base existente, guarda primero el dump fuera de
   EasyPanel y confirma que se restaura en una base MySQL separada. Después
   configura `AUTO_NORMALIZE_CONTACT_BOOKS=1` y
   `CONTACT_BOOK_MIGRATION_BACKUP_VERIFIED=1`. La migración copia las libretas
   a `vc_contact_book_meta` y `vc_contact_book_contacts` dentro de una
   transacción; solo tras confirmar la copia elimina la libreta de
   `sessions.data`. Si falla, el servidor no inicia y la transacción revierte.
   Subir `llamadas1 (1).sql` junto con el código no importa ni restaura el dump:
   se migra la base MySQL ya configurada en EasyPanel.
7. Despliega y revisa los logs `[CONTACT_BOOK_MIGRATION]` y `/health`.
   Conserva el dump hasta validar contactos y campañas.
8. Abre una terminal interactiva del contenedor en /app y ejecuta:
   npm run auth:user:add -- admin ADMINISTRADOR
   Ingresa y confirma una contraseña de al menos 12 caracteres.
9. Comprueba /login. Inicia sesión, abre Núcleo de Red y revisa
   la reconexión de Socket.IO. No realices llamadas reales hasta preparar el ensayo.

Rollback de la normalización: detén la aplicación, configura
`CONTACT_BOOK_MIGRATION_BACKUP_VERIFIED=1` y ejecuta
`npm run rollback:contact-books`. El comando exige que el bloqueo MySQL esté
libre, reconstruye `sessions.data.contactBook` dentro de una transacción y
elimina las filas normalizadas solo al completar la copia. Después puede
desplegarse la versión anterior.

Los secretos, node_modules, bases locales y la APK no forman parte del paquete.
El Dockerfile instala las dependencias de Node; no compila React.
MySQL conserva sesiones e historial en su volumen del servicio de base de datos.
Los backups automáticos de archivos están desactivados; configura backups de MySQL
en EasyPanel. Si activas CALL_BACKUP_INTERVAL_HOURS, monta un volumen y configura
CALL_BACKUP_DIR en ese volumen.

La URL de la aplicación no da acceso administrativo a EasyPanel.
Para desplegar desde este equipo se requiere acceso al panel o una conexión API.
