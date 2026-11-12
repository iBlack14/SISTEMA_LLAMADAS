# Prueba de SERVER en EasyPanel

Base: e2cd6a9 (SERVER). Rama: test/easypanel-server.
Esta copia no incluye los cambios locales de React ni crea commits.

1. Crea una base MySQL de pruebas en EasyPanel. Usa su host interno, no localhost.
   Mantén una sola instancia de la aplicación por base de datos.
2. En el servicio de la app selecciona Source / Upload y sube voip-server-easypanel-test.tar.gz.
3. Selecciona el builder Dockerfile, ruta Dockerfile y contexto raíz.
4. Copia las variables de easypanel.env.example en Environment y reemplaza todos
   los valores REEMPLAZAR con los datos del servicio MySQL.
   Ingresa DB_PASSWORD directamente en EasyPanel.
   No configures AUTH_LOCAL_ISOLATED.
5. En Domains configura https://llamadas1-v1.tvxk4m.easypanel.host
   con puerto de destino 3000 y HTTPS.
6. Despliega y revisa los logs. El servidor crea sus tablas si no existen.
   No requiere migrar ni copiar datos de XAMPP.
7. Abre una terminal interactiva del contenedor en /app y ejecuta:
   npm run auth:user:add -- admin ADMINISTRADOR
   Ingresa y confirma una contraseña de al menos 12 caracteres.
8. Comprueba /health y /login. Inicia sesión, abre Núcleo de Red y revisa
   la reconexión de Socket.IO. No realices llamadas reales hasta preparar el ensayo.

Los secretos, node_modules, bases locales y la APK no forman parte del paquete.
El Dockerfile instala las dependencias de Node; no compila React.
MySQL conserva sesiones e historial en su volumen del servicio de base de datos.
Los backups automáticos de archivos están desactivados; configura backups de MySQL
en EasyPanel. Si activas CALL_BACKUP_INTERVAL_HOURS, monta un volumen y configura
CALL_BACKUP_DIR en ese volumen.

La URL de la aplicación no da acceso administrativo a EasyPanel.
Para desplegar desde este equipo se requiere acceso al panel o una conexión API.
