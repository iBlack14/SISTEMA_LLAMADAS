# VOIP VC - Skeleton de Vinculacion Celular <-> Web

## Inicio de sesión, roles y XAMPP local

Inicia MySQL desde XAMPP y verifica que `.env` tenga `DB_HOST=localhost`,
`DB_PORT=3306` (opcional), `DB_NAME` y `DB_USER`. Luego ejecuta `npm start` y
abre `http://127.0.0.1:3000/login`. El servidor queda limitado a esta PC. La
autenticación crea únicamente las tablas `auth_*` en la base indicada, sin
borrar las tablas existentes. En este perfil un teléfono físico no puede
conectarse al servidor usando `localhost`.

Para crear la primera cuenta, abre otra terminal en la raíz y ejecuta:

```powershell
npm run auth:user:add -- admin ADMINISTRADOR
```

La contraseña se solicita dos veces sin mostrarse en pantalla. Usa el mismo
comando con rol `EMPLEADO` para las demás cuentas. Instrucciones del entorno
alternativo aislado y pruebas: [server/auth/README.md](server/auth/README.md).

El administrador dispone de **Núcleo de Red** en `/admin/nucleo-red`, con diez
equipos, estados Android en vivo y actividad del turno. Fuentes, definiciones
y pruebas simuladas: [server/NETWORK_MONITOR.md](server/NETWORK_MONITOR.md).

`npm run auth:local` sigue disponible para pruebas con un MySQL separado en el
puerto 3308. No uses `npm start` para exponer el servicio a una red o a internet:
el perfil XAMPP de esta fase es solo para uso local.

Este proyecto crea un **esqueleto funcional** para conectar un dashboard web con un cliente movil usando tiempo real (Socket.IO).

## Migración gradual del panel a React

El dashboard principal `/` utiliza React, TypeScript y Vite desde `frontend/`.
Incluye conexión Socket.IO, restauración o creación de sesión, equipos con QR,
controles de campaña, consulta de listas y actividad reciente. `/panel/contacts`
permite buscar, filtrar y editar notas. Reutiliza autenticación y API MySQL.

```powershell
npm --prefix frontend ci
npm run panel:build
npm start
```

Abre `http://localhost:3000/` e inicia sesión: el dashboard React será la entrada.
El menú **Contactos y listas** lleva a `/panel/contacts`. Las importaciones y los
reportes completos siguen en `/legacy` durante la migración. El dashboard restaura
la sesión del usuario o crea una nueva si todavía no existe una credencial guardada.

Para desarrollo: `npm run panel:dev` inicia Vite en el puerto 5173, con proxy
hacia el backend del puerto 3000. Las sesiones y credenciales del navegador
pertenecen al origen: para probar con la sesión real usa el build servido por Express.
No copies tokens a URLs ni a archivos de configuración. Vuelve a compilar al
desplegar; `frontend/dist/` y `frontend/node_modules/` no se versionan.
El panel principal conserva llamadas, importación y reportes durante esta etapa.

## Que incluye

- Dashboard web (`/`) para crear y unir sesion
- Cliente movil web (`/phone`) para simular el telefono
- Vinculacion por QR con token de sesion
- Backend Node.js + Express + Socket.IO
- Endpoint de pairing para Android (`POST /api/android/pair`)
- Eventos base: crear sesion, vincular, marcar, colgar, actualizar estado

## Arranque

```powershell
npm install
npm start
```

Abrir:

- Dashboard: `http://localhost:3000/`
- Cliente movil: `http://localhost:3000/phone`

El perfil XAMPP fuerza el acceso local y no permite configurar los siguientes
valores para una publicación de red desde este arranque. La configuración de
producción histórica de abajo no corresponde a este perfil local.

Variables de conexión local en `.env`:

- `DB_HOST`: `localhost` o `127.0.0.1` (el servidor normaliza a `127.0.0.1`)
- `DB_PORT`: `3306` por defecto
- `DB_NAME`, `DB_USER`, `DB_PASSWORD`: credenciales de la base MySQL de XAMPP
- `PORT`: puerto web, `3000` por defecto

`HOST`, `TRUST_PROXY`, `CORS_ORIGIN` y las URLs públicas se fuerzan a valores
locales en este perfil; no habilitan acceso desde otros equipos.
## Flujo de prueba

1. En dashboard, click en **Crear Sesion**.
2. Click en **Vincular Dashboard**.
3. Escanea el QR con tu celular o abre el link de vinculacion.
4. En `/phone` se autocompleta `code + token` y se vincula.
5. Desde dashboard, usa **Llamar** o **Colgar**.

## Endpoint para APK Android

Request:

```http
POST /api/android/pair
Content-Type: application/json

{
  "code": "ABC123",
  "token": "TOKEN_DEL_QR",
  "deviceId": "android-device-id",
  "deviceName": "Samsung A54"
}
```

## APK Android (bridge real)

Se agrego proyecto Android en `android-app/` con:

- Escaneo QR (lee `code` + `token`)
- Pairing a `POST /api/android/pair`
- Socket.IO como `role=phone`
- Ejecucion de llamada con `CALL_PHONE`

### Build rapido

1. Abre `android-app/` en Android Studio.
2. Espera sync de Gradle.
3. Ejecuta `Build > Build APK(s)`.
4. APK debug en:
   `android-app/app/build/outputs/apk/debug/app-debug.apk`

### Flujo real

1. Levanta backend (`PORT=3100` o libre).
2. En dashboard crea sesion y genera QR.
3. En la APK toca **Escanear QR**.
4. Toca **Vincular Celular**.
5. Desde dashboard usa **Llamar**.

Nota: colgar llamada remotamente en Android requiere privilegios de dialer por defecto/sistema.

Respuesta:

```json
{
  "ok": true,
  "code": "ABC123",
  "socket": {
    "url": "http://localhost:3000",
    "role": "phone",
    "token": "TOKEN_DEL_QR"
  }
}
```

## Produccion en VPS (instrucciones históricas; no compatibles con el perfil local)

El arranque actual de XAMPP es solo local y rechaza conexiones MySQL remotas.
No sigas estas instrucciones para desplegar esta fase en internet; requieren un
perfil de producción separado, con HTTPS, cuentas y configuración autorizada.
La información siguiente se conserva como referencia histórica.

### Recomendado

- Ubuntu 22.04+
- Node.js 20 LTS
- Nginx como reverse proxy
- HTTPS con Let's Encrypt
- `systemd` o `pm2` para mantener el proceso vivo

### Variables de entorno base

Usa `.env.example` como plantilla:

```bash
cp .env.example .env
```

Configura al menos:

```env
PORT=3000
HOST=0.0.0.0
PUBLIC_BASE_URL=https://api.tudominio.com
PUBLIC_WEB_BASE_URL=https://api.tudominio.com
CORS_ORIGIN=https://api.tudominio.com
TRUST_PROXY=1
```

### Archivos listos para deploy

- `infrastructure/vps/voip-vc.service`: servicio `systemd`
- `infrastructure/vps/ecosystem.config.cjs`: opcion `pm2`
- `infrastructure/vps/nginx.voip-vc.conf`: reverse proxy base para Nginx

### Flujo sugerido en el VPS

```bash
sudo mkdir -p /opt/voip-vc
sudo chown -R $USER:$USER /opt/voip-vc
cd /opt/voip-vc
npm ci --omit=dev
cp .env.example .env
node server/server.js
```

Luego:

1. Ajusta `.env` con tu dominio real.
2. Instala el servicio `systemd` o usa `pm2`.
3. Configura Nginx apuntando a `127.0.0.1:3000`.
4. Activa HTTPS.
5. Verifica `https://api.tudominio.com/health`.

### Estabilidad que ya queda aplicada

- guardado atomico de sesiones
- cierre graceful con `SIGTERM` y `SIGINT`
- timeouts HTTP configurados
- limpieza automatica de sesiones viejas
- limites de payload JSON
- rate limiting basico para endpoints sensibles
- `Socket.IO` con `ping` y buffer definidos
- headers HTTP de endurecimiento basicos

## APK para produccion

- La APK usa `BuildConfig.DEFAULT_BASE_URL` como base por defecto.
- `release` ahora queda con `cleartext` desactivado.
- Solo `debug` permite HTTP plano para `localhost`, `127.0.0.1` y `10.0.2.2`.

Para publicar con otro dominio por defecto, cambia este valor en:

- `android-app/app/build.gradle.kts`

## Siguiente integracion real

Para llamadas reales desde Android/iOS, reemplaza la simulacion de `web/phone.js` por:

- app movil nativa con permisos de llamada
- puente hacia este backend (WebSocket/HTTP)
- proveedor de telefonia (SIP/Twilio/operador)

Este skeleton esta listo para evolucionar hacia ese bridge real.

## Despliegue rapido en la nube (Web + Server)

Para tener funcionando **dashboard + server** en una URL publica (por ahora):

1. Sube este repo a GitHub.
2. En Render, crea un **Web Service** desde ese repo.
3. Render detecta `render.yaml` automaticamente (Blueprint) o usa:
   - Build Command: `npm install`
   - Start Command: `npm run start`
4. Configura variables:
   - `PUBLIC_BASE_URL=https://TU-APP.onrender.com`
5. Espera deploy y prueba:
   - `https://TU-APP.onrender.com/` (dashboard)
   - `https://TU-APP.onrender.com/phone` (phone bridge)
   - `https://TU-APP.onrender.com/health`

Nota: en este repo, `web` se sirve desde el mismo `server`, asi que no necesitas desplegar frontend por separado para esta etapa.

## Web y Server en dominios distintos

Si separas frontend y backend (ejemplo: `https://app.tudominio.com` y `https://api.tudominio.com`):

1. En el backend configura:
   - `PUBLIC_BASE_URL=https://api.tudominio.com`
   - `PUBLIC_WEB_BASE_URL=https://app.tudominio.com`
   - `CORS_ORIGIN=https://app.tudominio.com,https://api.tudominio.com`
2. En el frontend agrega `apiBase` en la URL:
   - Dashboard: `https://app.tudominio.com/?apiBase=https://api.tudominio.com`
   - Phone: `https://app.tudominio.com/phone?apiBase=https://api.tudominio.com`

El frontend ya esta preparado para usar ese `apiBase` y conectarse por Socket.IO al dominio del backend.
