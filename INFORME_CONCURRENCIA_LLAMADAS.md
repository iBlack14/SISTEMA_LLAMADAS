# Informe de revisión: fluidez y continuidad de llamadas

Fecha: 2026-11-26 (America/Lima)

## Resumen

La revisión de solo lectura encontró dos causas probables y distintas:

1. **El panel puede sentirse lento al iniciar o pausar/reanudar una campaña** porque espera escrituras completas en MySQL. Al iniciar, el navegador primero espera `Contacts.flushDatabase()`, el endpoint persiste la sesión y el despachador vuelve a persistir antes de emitir la orden.
2. **Hay llamadas que el servidor está cerrando tras quedarse sin progreso observado.** En los logs recientes del VPS se vieron 21 liberaciones del watchdog: 19 por `watchdog_dialing_timeout` y 2 por `watchdog_in_call_heartbeat_timeout`. Los umbrales configurados son 45 segundos. El watchdog marca el intento como `sin_respuesta`, intenta colgar y libera el equipo aunque el colgado físico no esté confirmado.

La segunda causa está demostrada por los logs y puede explicar que la campaña salte una llamada o avance sin que el operador espere. Los logs no prueban por sí solos si faltaron eventos por desconexión de Android, señal móvil o demora de Telecom.

## Flujo revisado

Inicio de campaña: `campaign-controller.js` vacía la cola de guardado de contactos → `POST /campaign/start` guarda la sesión → `dispatchCampaignCalls` asigna contactos → `sendPersistedDial` guarda de nuevo antes de emitir `call:action` → `BridgeService` recibe la orden y llama a `TelecomManager.placeCall` → Android envía `phone:status` y ACK → el servidor persiste el estado y despacha el siguiente contacto.

## Hallazgos

| Prioridad | Hallazgo | Evidencia | Alcance |
|---|---|---|---|
| Alta | El watchdog finaliza asignaciones después de 45 s en `dialing` o sin heartbeat en llamada. Libera el worker sin confirmar que Android haya terminado la llamada física. | `backend/services/calls/dispatcher.js`: umbrales y `scanStuckCalls`; logs recientes del VPS con 19 `watchdog_dialing_timeout` y 2 `watchdog_in_call_heartbeat_timeout`. | Confirmado en código y observado en producción; causa física de los silencios pendiente. |
| Alta | Al iniciar la campaña hay al menos dos esperas de persistencia del lado del servidor, además del flush del libro de contactos en el navegador. | `frontend/features/campaigns/campaign-controller.js:147-170`; `frontend/features/contacts/contacts-repository.js:187-235`; `backend/routes/campaigns.js:41-103`; `backend/services/calls/dispatcher.js:131-153`. | Confirmado por código. En una orden observada, el guardado previo al despacho tardó 1,205 ms; esa orden luego encontró que la asignación ya había cambiado. Una medición no basta para estimar el promedio. |
| Media | Una orden de despacho se descartó porque la asignación ya había cambiado al terminar el guardado; otra no se envió inicialmente porque el worker estaba desconectado. | Logs recientes: `CALL_DISPATCH reason=assignment_changed` y `reason=worker_disconnected`. | Casos observados; falta correlacionar todos los reintentos con la misma llamada. |
| Media | Los cambios de campaña esperan a que la ruta HTTP termine de guardar. No hay una respuesta visual optimista en todos los controles. | `backend/routes/campaigns.js:112-145`; `frontend/features/campaigns/campaign-controller.js:147-179`. | Confirmado por código; latencia de cada ruta no medida. |

## Listas y concurrencia

El despachador mantiene asignaciones por worker y vuelve a comprobarlas después de persistir. La evidencia disponible muestra una asignación que cambió mientras se guardaba; no demuestra un conflicto sistemático entre listas ni entre sesiones. No se ejecutaron llamadas de prueba ni se modificó la asignación automática.

## MySQL y colas

Los estados entrantes de Android pasan por `historyGate.serialize` y `historyGate.commit`, que esperan el guardado de la sesión antes de confirmar el evento y continuar. Esto protege la durabilidad, pero puede añadir latencia cuando MySQL o la cola de guardado tardan. En esta revisión solo se observó una persistencia de despacho de 1,205 ms; no se midieron p95/p99, crecimiento de binlogs ni espera acumulada por sesión. No hay evidencia suficiente para atribuir los parones a binlogs.

## Pruebas y límites

No se hicieron llamadas reales, pruebas de 1/2/6 dispositivos, inyección de desconexiones ni cambios en producción. El servicio de llamadas tuvo una tarea reiniciada durante la ventana revisada; no se verificó aquí el SHA exacto del contenedor activo. Por eso no se da por hecho que el código local y cada tarea desplegada sean idénticos.

## Qué corregir primero

1. Correlacionar los eventos de una llamada (`dashboard_requested`, persistencia/despacho, APK recibida, inicio de Telecom, ACK y heartbeat) con `commandId`/`callId`; desplegar backend y APK que emiten la misma traza antes de volver a analizar una sesión afectada.
2. Revisar el watchdog para que no marque como fallida y libere una llamada física sin reconciliar el estado actual de Android. No cambiar el umbral de 45 s a ciegas: una llamada legítima puede seguir timbrando y una orden duplicada puede generar una llamada adicional.
3. Medir por separado el flush de contactos, guardado de sesión y ACK. Luego optimizar solo el paso que resulte lento, manteniendo la escritura durable antes del despacho.

## Respaldo, despliegue y rollback

Esta revisión no escribió en el VPS ni en la base de datos. Antes de cambiar el watchdog o la persistencia, conservar una copia del estado/configuración desplegada y acordar un rollback. No se desplegó ningún cambio durante esta revisión.

## Conclusión

Está demostrado que el servidor libera llamadas al alcanzar el watchdog de 45 s y que hubo demoras de persistencia de alrededor de 1.2 s en un caso observado. No está demostrado por qué faltan estados de Android en cada llamada. Primero conviene correlacionar la ruta de una llamada fallida; después ajustar el watchdog y la espera de guardado con evidencia. No se deben relajar reintentos ni liberar workers sin confirmar que la llamada física terminó.
