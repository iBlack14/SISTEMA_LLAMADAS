# Inicio de sesión y roles

Esta fase permite EMPLEADO y ADMINISTRADOR e incluye el dashboard Núcleo de Red.
No crea un turno general ni asignaciones definitivas. No importa sesiones ni contactos de
la aplicación actual. Los dos perfiles crean las tablas de autenticación `auth_*`
sin borrar las tablas existentes.

Para estados Android, métricas, alcance de turnos y pruebas simuladas del
dashboard, consultar [Núcleo de Red](../NETWORK_MONITOR.md).

## Arranque

### XAMPP local

Inicia MySQL en XAMPP y configura `.env` con `DB_HOST=localhost`,
`DB_PORT=3306` (opcional), `DB_NAME`, `DB_USER` y `DB_PASSWORD`. Ejecuta desde
la raíz:

```powershell
npm start
```

Abre http://127.0.0.1:3000/login. Este perfil solo escucha en `127.0.0.1`,
independientemente de `HOST` en `.env`; no habilita acceso LAN ni producción.
Por eso, un teléfono físico no puede conectarse a este servidor local.
Al iniciar crea las tablas de autenticación que falten en `DB_NAME`. No elimina
ni modifica otras tablas. Para crear una cuenta (la contraseña se ingresa sin
eco en la terminal):

```powershell
npm run auth:user:add -- admin ADMINISTRADOR
npm run auth:user:add -- operador EMPLEADO
```

Usa `ADMINISTRADOR` o `EMPLEADO` como rol. Se requieren contraseñas de al menos
12 caracteres.

### MySQL aislado para pruebas

Desde la raíz del proyecto:

```powershell
npm run auth:local
```

Abre http://127.0.0.1:3101/login. Se utiliza exclusivamente:

- MySQL en `127.0.0.1:3308`, con otro directorio de datos.
- Base `sistema_llamadas_auth_local`.
- Usuario MySQL `calls_auth_local`, limitado a esa base.
- Configuración, datos y contraseñas sintéticas en `.auth-local/`, ignorado por Git.

El script comprueba puerto, directorio de datos y base seleccionada antes de
migrar o sembrar cuentas. Si el puerto pertenece a otra instancia o la
configuración no corresponde al entorno aislado, aborta. Nunca usa el MySQL de
3306. Los arranques siguientes conservan las cuentas y datos de prueba.

Requiere Node >=20 y el binario MySQL Server 8.0 instalado. En este equipo usa
`C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqld.exe`. Otra instalación puede
indicarse mediante `AUTH_TEST_MYSQL_BASE`, sin modificar `.env`.

`auth:local` no lee `.env` ni usa XAMPP. Los dos perfiles son independientes;
detén uno antes de iniciar el otro para evitar dos servidores operativos.

## Probar los dos roles

Las contraseñas aleatorias están en `.auth-local/test-accounts.json`:

```powershell
Get-Content .auth-local/test-accounts.json
```

1. Inicia sesión con `empleado.prueba`. Debe abrir el panel actual en `/`, con
   sus tres QR iniciales y controles operativos existentes.
2. Escribe directamente `http://127.0.0.1:3101/admin/nucleo-red`. Debe devolver
   **403**, igual que `/api/admin/network/access` y `/admin.html`.
3. En el panel, pulsa **Cerrar sesión**. No equivale a finalizar un turno ni a
   reiniciar la sesión operativa: las campañas y los teléfonos se conservan.
4. Inicia sesión con `admin.prueba`. Debe abrir `/admin/nucleo-red`, con los diez
   indicadores y diez tarjetas de equipo simultáneas. La API `/api/admin/network/access` debe responder
   **200**. El enlace permite abrir también el panel operativo.
5. Sin iniciar sesión, `/` y la ruta administrativa redirigen a `/login`; las
   API privadas responden **401**.

También puedes comprobarlo desde la consola del navegador con cada cuenta:

```javascript
await fetch('/api/admin/network/access').then(r => r.status)
// EMPLEADO: 403; ADMINISTRADOR: 200; sin cuenta: 401.
```

Usa **Cerrar sesión** para cambiar de cuenta; localhost y 127.0.0.1 mantienen
cookies distintas. Las otras pestañas del mismo origen recargan al cambiar de
cuenta. Las claves operativas del navegador están separadas por usuario.

## Acceso explícito a sesiones de prueba

Crear una sesión operativa desde una cuenta de prueba registra explícitamente
`(user_id, session_code)` en `auth_session_access`. Ni empleados ni
administradores pueden abrir una sesión operativa de otra cuenta solamente por
conocer su código o token. Las sesiones antiguas no se asignan automáticamente.

Este permiso temporal sirve exclusivamente para verificar el panel actual.
La política definitiva de empleados, sesiones y equipos queda pendiente.

## Verificación automática

Detén primero el servidor de prueba con Ctrl+C para evitar dos procesos
operativos escribiendo snapshots de la misma base. Deja MySQL 3308 encendido:

```powershell
npm run auth:setup
npm run test:auth
node --test server/contact-book.test.js server/annual-call-limit.test.js web/modules/contacts.test.js
```

La integración usa HTTP 3102 y cuentas/sesiones sintéticas temporales, que limpia
por sus identificadores al terminar. Comprueba autenticación, roles en HTTP y
Socket.IO, cookies, CSRF, permisos explícitos, tokens operativos robados,
caducidad, revocación y el protocolo QR/Android. No realiza llamadas reales.

El servidor HTTP de prueba escucha únicamente en loopback. Un teléfono físico
no puede acceder al QR que apunta a 127.0.0.1. La prueba automatizada reproduce
el protocolo Android; una prueba física requerirá configurar una dirección LAN
autorizada en otra fase. La APK y sus credenciales de vinculación no cambiaron.

## Seguridad y límites de esta fase

- Hash `scrypt` con sal por contraseña, N=131072, r=8, p=1; máximo dos
  derivaciones concurrentes y cola limitada.
- Sesiones opacas aleatorias de 256 bits. MySQL conserva solo su SHA-256.
- Cookie HttpOnly y SameSite=Lax; 8 horas absolutas y 30 minutos de inactividad.
- Regeneración al iniciar sesión y revocación del identificador anterior.
- CSRF por token y origen en cambios de estado del navegador; login exige
  JSON y origen permitido. Android mantiene autenticación por token de equipo.
- Límite de intentos por cuenta e IP. Usuario inactivo, cambio de auth_version,
  o eliminación del permiso invalidan el acceso desde el servidor.
- Socket.IO revalida cada evento; logout desconecta inmediatamente los sockets
  de esa sesión de usuario. También revisa sockets pasivos cada 5 segundos sin
  extender su inactividad. Los teléfonos conservan su autenticación independiente.
- La cookie no utiliza Secure porque este entorno usa HTTP de loopback. Un
  despliegue real requerirá HTTPS, cookies Secure y revisión de proxy/orígenes;
  el guard de aislamiento impide ese despliegue accidental en esta fase.
- No hay registro público, recuperación de contraseña ni gestión de usuarios.
- El frontend usa un único origen y no acepta `apiBase` para enviar credenciales.
- No se migran ni eliminan datos antiguos de localStorage al abrir cuentas nuevas.

No subir `.auth-local/`, sus contraseñas ni capturas/logs del navegador a Git.
El `.env` ya versionado sigue siendo un cambio previo del usuario: no se edita,
restaura, agrega al índice ni publica como parte de este trabajo.

## Detener MySQL de pruebas

Después de detener el servidor HTTP:

```powershell
npm run auth:mysql:stop
```

Este comando verifica el puerto y directorio de datos antes de apagar únicamente
la instancia 3308. Conserva sus datos para el siguiente arranque.
