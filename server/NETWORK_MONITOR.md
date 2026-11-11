# Núcleo de Red

Ejecutar `npm run auth:local` y abrir http://127.0.0.1:3101/login.
`admin.prueba` entra directamente al dashboard. `empleado.prueba` conserva el
panel operativo. Las contraseñas existentes están en `.auth-local/test-accounts.json`;
no se cambiaron. No se usa `.env`, MySQL 3306 ni producción.

## Monitor simultáneo

Los diez equipos muestran sus estados, rubros, horarios, última actividad y
contadores al mismo tiempo. No hay una selección activa. Los indicadores se
mantienen arriba y muestran solo sus números. Nombre, estado e identificación
de prueba están disponibles al pasar el cursor o enfocar con Tab.
La cuadrícula mantiene dos columnas y cinco filas en escritorio, incluso en
pantallas anchas, y una columna a 700 px o menos. Hay más espacio entre tarjetas
y la página se desplaza verticalmente. «Resumen del turno» y cada historial
empiezan plegados. Se verificó 1920 × 1080 con zoom al 100 %, laptop y móvil.

Cada «Ver actividad del turno» empieza cerrado y conserva su nodo y apertura
durante las actualizaciones. Los snapshots de `/api/admin/network` y Socket.IO
contienen los diez resúmenes y una versión del historial, sin filas detalladas.
Al abrir un desplegable, el navegador consulta
`/api/admin/network/activity?equipment=1,7` para los equipos que lo necesitan:
agrupa aperturas simultáneas y refresca solo historiales abiertos cuya versión
cambió. El endpoint individual existente también permite recuperar el detalle.

`SessionPersistence.getCallAttemptsForSessions` agrupa todas las sesiones del
monitor en una consulta SQL parametrizada, en lugar de una consulta por equipo.
La tabla sigue filtrando por deviceId e ID del turno activo, con hasta 30 filas
por equipo, ordenadas de más reciente a más antigua. El navegador nunca descarga
diez historiales independientes cada segundo.

## Datos y estados

`admin_network_devices` es una tabla aditiva en la base aislada de 3308. Asocia
de forma estable los números 1–10 con el `deviceId` del celular, por orden de
primer vínculo observado. No asigna empleados ni crea turnos. Los registros
sin dispositivo están «Sin vincular». Un dispositivo desvinculado conserva su
identidad histórica; los dispositivos adicionales se notifican fuera del cupo.
Antes de usar equipos reales se debe confirmar la numeración física y la
estabilidad de su identificador Android. No hay una interfaz de reasignación.

El servidor mantiene observaciones separadas del estado optimista de campañas.
Solo `phone:status`, recibido desde un socket vinculado y autenticado como
teléfono, confirma actividad: `dialing` y `ringing` muestran «Marcando», con
borde ámbar estático; `in_call` muestra «En llamada», con indicador verde y
pulso únicamente del color del borde del círculo y su tarjeta. No se animan
rellenos, contenido, tamaño, opacidad ni sombras. «Disponible» utiliza un
estilo estático distinto. Movimiento reducido sustituye el pulso por un borde
verde fijo. `idle`, `available`, `ended` o `failed` detienen el pulso.
La desconexión también lo detiene; su detección física depende del
heartbeat y timeout de Socket.IO. Una orden `call:action`, un ACK, una campaña
iniciada y la vinculación por sí solos no constituyen evidencia de llamada.

La observación debe corresponder al socket actual y, cuando hay un intento
correlacionado, a su callId. Tras reconectar hace falta un nuevo reporte Android.
Una recarga del navegador obtiene la observación actual; un reinicio del backend
no restaura llamadas activas ficticias. La última actividad conocida se conserva
como fecha histórica. Las transmisiones se actualizan cada segundo y contienen
un snapshot inicial al suscribirse. Si el navegador pierde el canal o no recibe
actualizaciones durante seis segundos, suspende el pulso y muestra «Sin datos
en vivo» en lugar de fingir que los celulares están disponibles.

## Alcance y métricas

El detalle cuenta intentos del celular cuyo `shiftId` coincide exactamente con
el turno activo de su sesión. El historial proviene de `vc_call_attempts`, mediante
`SessionPersistence.getCallAttemptsForSessions`, que rechaza lecturas si hay guardados
pendientes. No suma varias copias del historial. La tabla muestra los últimos
30 intentos de ese alcance y expresa fechas en America/Lima.

El resumen consolida únicamente los turnos activos de las sesiones representadas
por los celulares registrados cuando comparten fecha y tipo de turno conocidos.
Cada sesión aporta sus propios IDs de turno; el alcance se indica en pantalla.
No se ha implementado un turno global nuevo. Turnos incompatibles o fuentes
incompletas producen «Sin datos». Tampoco se inventan horarios individuales:
se muestra el horario del turno de la sesión.

El rubro sale de `contactBook.preferences.pairingListAssignments[slotId]`, la
misma asignación que utiliza el panel actual. Sin una asignación se muestra
«Sin datos»; no se deduce el rubro del nombre del teléfono.

`web/modules/report-metrics.js` comparte el criterio de contestada con las
exportaciones del reporte unificado en `web/dashboard.js`:

- **Total de llamadas**: número de intentos registrados en el alcance, también
  los aún abiertos. No es el número de teléfonos ni de contactos únicos.
- **Contestadas**: intentos finalizados con conexión registrada o resultado
  `contesto`, excluyendo buzón y anuncios del operador. No confirma atención humana.
- **No contestadas**: intentos finalizados con `sin_respuesta`, `no_contactado`,
  `no_contesto`, `buzon_de_voz` o `no_disponible`.
- **Inoperable**: `sin_servicio`, `numero_incorrecto` y resultados técnicos
  explícitos equivalentes; se mantiene separado de no contestadas.
- **En curso**: intentos que todavía no tienen fin registrado.
- **Sin clasificar**: intentos finalizados sin resultado técnico concluyente.
- **Pendientes**: contactos en `pending`, `retry_pending` o `held` atribuibles al
  celular por targetWorkerId o por su lista actual. No se usa total menos
  contestadas ni se equiparan pendientes a contactos que se puedan volver a llamar.

El reporte diario antiguo (`reportData`) utiliza otro criterio: duración de al
menos 35 segundos y pendientes por contacto. Se conserva por compatibilidad;
ese umbral no se utiliza en Núcleo de Red. Las llamadas ajenas a las campañas
pueden producir estado Android sin un intento gestionado en este historial.

Un cero representa una consulta correcta sin registros en un alcance conocido.
La ausencia de turno, asignación o historial verificable se representa con null
en la API y «Sin datos» en la interfaz.

## Permisos

La vista y las API comparten `requireAdmin`. Probar directamente como empleado:

- `/admin/nucleo-red` → 403.
- `/api/admin/network` → 403.
- `/api/admin/network/equipment/1` → 403.

El evento `admin:subscribe` valida usuario y rol en el servidor antes de entrar
a la sala privada. Un cliente Android tampoco puede acceder usando solamente
su token de equipo. La suscripción administrativa no toma el control del socket
del operador. Logout y revocación mantienen las comprobaciones de la fase de login.

## Pruebas sin llamadas reales

Detener primero `auth:local` con Ctrl+C para liberar el único escritor de la
base aislada. Mantener MySQL encendido y ejecutar:

```powershell
npm run auth:setup
npm run test:network
npm run test:auth
```

La integración crea cuentas y sesiones con acceso explícito, conecta un teléfono
de prueba (`android-test-…`) y envía eventos simulados. No conecta con una APK,
no llama a ningún número ni instala un handler que ejecute órdenes de marcado.
Los dispositivos de prueba aparecen etiquetados como «Prueba simulada». Los
registros temporales y la numeración simulada se limpian al terminar.

Para observar durante un minuto la llamada simulada en el navegador:

```powershell
$env:NETWORK_PREVIEW_MS = '60000'
npm run test:auth
Remove-Item Env:NETWORK_PREVIEW_MS
```

Cuando la consola indique que está disponible, abrir
http://127.0.0.1:3102/login con `admin.prueba`. Solo un celular debe pulsar;
recargar conserva el estado. Al concluir la prueba se corta el canal y se apaga
el pulso. Luego volver a `npm run auth:local` para la aplicación normal de pruebas.

Falta validar en celulares físicos: precisión/orden de estados Telecom, detección
de buzón y anuncios, reconexiones y pérdida de red, estabilidad de deviceId,
capacidad con diez dispositivos, asignación física de números y horarios. El
entorno permanece en loopback; una prueba física necesita configurar una dirección
LAN autorizada, sin reutilizar credenciales ni datos de producción.
