# Informe de concurrencia de llamadas

## Actualización posterior de correcciones locales

El análisis de abajo documenta el estado encontrado antes de iniciar las correcciones. Con autorización del usuario se aplicaron cambios locales, aún no desplegados ni verificados con pruebas:

- `CallHistoryGate.commit()` ahora pasa el `Map` de sesiones y el código afectado a persistencia; rechaza el commit si la sesión ya no existe.
- Los nombres agregados `Asignación automática` y `Pendientes del turno` ya no se comparan como nombres literales de lista.
- El inicio general conserva `maxAttempts` enviado por el panel.
- Los estados de llamada solo se marcan procesados después de persistirse.
- Una desconexión ya no libera automáticamente la propiedad de contactos pendientes ni convierte una llamada activa en terminal por timeout. El watchdog conserva la asignación hasta que Android confirme un terminal correlacionado, evitando un posible marcado duplicado si la llamada física sigue activa.
- La caché de intentos se invalida con revisiones de los intentos/sesiones y conserva solo una fotografía, en vez de acumular todas las fotografías antiguas en memoria.
- Los guardados dirigidos limpian la marca de sesión sucia solo si no apareció una mutación nueva mientras el guardado estaba en curso.
- Los logs de persistencia ahora registran el tamaño serializado, el tiempo de construir el snapshot y la espera en la cola; la consulta de la libreta registra el tiempo de consulta y cálculo de progreso. Estos datos sirven para medir, pero no se han recolectado en producción.

No se ejecutaron pruebas, no se hicieron llamadas reales, no se conectó a MySQL y no se desplegaron estos cambios. El código posterior a esta actualización debe tratarse como pendiente de validación.

## Revisión local de `llamadas1 (1).sql`

Se revisó el dump sin imprimir ni copiar valores personales: mide 49,075,922 bytes (46.8 MiB). Aproximadamente 46.27 MiB del texto de inserciones pertenecen a `sessions`; la sentencia de inserción más grande ocupa aproximadamente 23.74 MiB. El dump contiene 5 sentencias `INSERT` para esa tabla. Estas cifras describen el archivo SQL local, no el tamaño físico exacto de MySQL ni una medición de latencia.

La concentración en `sessions` coincide con el diseño actual: `sessions.data` contiene la libreta y la campaña, y el guardado compara y actualiza la columna completa cuando cambia la sesión. Esto hace probable una amplificación importante de CPU, transferencia y escritura en las rutas de guardado; no demuestra por sí solo la latencia observada en producción ni el crecimiento de binlogs. La restauración del dump no se probó.

Auditoría estática del árbol de trabajo de este repositorio. No se modificó la aplicación, no se llamó a ningún teléfono, no se tocó MySQL ni se desplegó la APK. Los tamaños de `llamadas1`, de los JSON de `sessions` y de los binlogs son antecedentes comunicados, no mediciones de esta pasada.

## 1. Resumen ejecutivo y alcance

El síntoma pedido es: tras unas 10–20 llamadas, uno o más Xiaomi dejan de marcar, a veces mientras otro sigue, incluso con listas distintas. En este código no existe un tope de 10 ni de 20 contactos. Lo que sí está escrito es un guardado que siempre falla en el camino directo, un reintento que puede reanudar la cola con retraso, y un filtro que puede impedir el marcado desde el inicio.

Revisión de esta pasada, solo lectura, sobre el árbol actual (`package.json` versión `0.1.0`). Se reprodujo en Node el `TypeError` del bucle de `save` con un arreglo de un objeto. No se llamó a ningún teléfono, no se tocó MySQL y no se modificó la aplicación.

1. Cada `phone:status` llama a `persistence.save` con un arreglo. `save` solo acepta un `Map` y lanza `TypeError` antes de escribir. El marcado siguiente vive en el callback de ese `commit`. Ese callback no corre en el camino directo. Sí puede correr hasta 10 s después: `retryPending` guarda el `Map` real y entonces ejecuta los recibos pendientes (`runtime-lifecycle.js:82-84`, `call-history-gate.js:47-55`). En un proceso vivo la cola no queda cortada en el primer estado; queda retrasada y el ACK sale con `persisted: false`.
2. El inicio general nombra la campaña `Asignación automática`, y el selector solo toma contactos cuya lista se llama exactamente así. Las listas reales no coinciden. Ese inicio no puede elegir el contacto siguiente. El inicio por equipo no borra ese nombre: si el general ya corrió, el filtro sigue vacío también para el equipo.

El patrón “funciona 10–20 veces y luego se congela” no quedó reproducido. El defecto 1 no explica un corte exactamente en la llamada 10. Puede explicar pausas de unos 10 s más el tiempo de reescribir el JSON, y una parada real solo si el `save` del reintento también falla. La cesión de lista al desconectar sigue siendo la explicación de código más cercana a “un equipo sigue y el otro no”.

Alcance leído: importación en `frontend/features/contacts/import/import-actions.js`, inicio general y por equipo, `backend/services/campaigns/campaign-manager.js`, `backend/services/calls/dispatcher.js`, `backend/shared/persistence.js`, `backend/services/calls/call-history-gate.js`, `backend/sockets/call-events.js`, `backend/sockets/utility-events.js` y `android-app/app/src/main/java/com/voipvc/bridge/BridgeService.kt`. Versión del paquete: `0.1.0`. No hay prueba automática de `pickNextContact` ni del argumento que `commit` pasa a `save`.

## 2. Mapa de flujo

```mermaid
flowchart TD
  importCsv["Importar CSV/XLSX/TXT y guardar lista real"] --> assignUi["Asignar lista a un equipo o pulsar inicio general"]
  assignUi --> startGeneral["POST /campaign/start con listName Asignación automática y maxAttempts 2"]
  assignUi --> startPhone["POST /workers/:id/start-independent con la lista del equipo"]
  startGeneral --> sync["syncCampaignContacts guarda listName y fuerza maxAttempts 1"]
  startPhone --> ensure["ensureCampaignContact pone targetWorkerId; no cambia listName"]
  sync --> pick["pickNextContact"]
  ensure --> pick
  pick --> reserve["assignNextContact reserva por workerId e incrementa attempts"]
  reserve --> persist["sendPersistedDial: save del Map y solo entonces call:action"]
  persist --> apk["Android placeCall y phone:command_ack"]
  apk --> status["phone:status dialing, ringing, in_call, ended o failed"]
  status --> gate["historyGate.commit guarda un arreglo, no el Map"]
  gate -->|TypeError| ack["ACK persisted false; el recibo queda pendiente"]
  ack --> retry["cada 10 s retryPending guarda el Map"]
  retry -->|save ok y estado terminal| next["a los 1200 ms dispatchCampaignCalls de ese worker"]
  retry -->|save falla| stop["no hay siguiente marcado hasta un reintento bueno"]
```

Límites de exclusión que sí existen:

| Límite | Dónde | Efecto |
| --- | --- | --- |
| Global de proceso | `saveChain` en `backend/shared/persistence.js:30` y `:207` | Un guardado de cualquier sesión espera al anterior. Dos sesiones no escriben en paralelo. |
| Por sesión | `CallHistoryGate.serialize` en `backend/services/calls/call-history-gate.js:15` | Los `phone:status` de una sesión entran en fila. |
| Por worker | `campaign.assignments[workerId]` en `campaign-manager.js:448` | Un equipo no recibe otro contacto mientras conserve asignación. |
| Por dispositivo físico | `bindDeviceToPairingSlot` en `pairing-lifecycle.js:19` | El socket viejo del mismo slot se desconecta. No hay un candado entre sesiones distintas. |
| Por lista | solo si `campaign.listName` coincide con `contact.list` | No aísla las listas entre sí cuando el nombre de campaña es el rótulo general. |
| Campaña | una campaña `running` por sesión, tope 10000 contactos | `backend/routes/campaigns.js:50` y `:53` |

## 3. Matriz de conflictos

| ID | Severidad | Síntoma | Evidencia | Reproducción | Impacto | Confianza |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Crítica | Cada estado falla el guardado directo y el siguiente marcado espera el reintento | `call-history-gate.js:39` pasa `[session]` a `save`. `persistence.js:201` hace `for (const [code, session] of sessionsMap)`. Un arreglo de un objeto lanza `TypeError` porque el objeto no es iterable. El siguiente despacho está en `call-events.js:282-283`, dentro del callback de `commit` (`call-history-gate.js:41`). `retryPending` (`call-history-gate.js:47-55`) sí llama a `save(this.getSessions())` y luego `flush`. El intervalo es 10 s (`runtime-lifecycle.js:82-84`). | Reproducido el `TypeError` con el mismo `for...of` sobre un arreglo de un objeto. No se levantó el servidor ni se hizo una llamada. | El ACK sale al momento con `persisted: false` (`call-events.js:293-296`). Android no se detiene por ese ACK: solo limpia el tracking si `accepted` y `terminal` (`BridgeService.kt:499-506`), y también al observar `ended` o `failed` (`BridgeService.kt:1110-1112`). En proceso vivo el siguiente marcado sale tras el reintento bueno más 1200 ms. Al arrancar, las asignaciones abiertas pasan a `retry_pending` (`runtime-lifecycle.js:63-72` llama a `skipActiveContact`). Ya no quedan tomadas por un reinicio. | Confirmado por código y por la prueba de lenguaje. El retraso, no el corte eterno, es lo que este árbol hace. No reproducido con teléfonos. |
| C2 | Crítica | El inicio general no marca, o marca cero | `campaign-controller.js:224-236` envía `listName = "Asignación automática"`. `campaigns.js:70-72` lo guarda. `campaign-manager.js:420` exige `contact.list === campaign.listName`. Los contactos llevan la lista del archivo (`import-actions.js:56-58`, `contacts-repository.js:370`). | No ejecutada. El predicado no tiene excepción para ese rótulo. | `dispatched.length` queda en 0. La UI dice que ningún equipo estaba disponible (`campaign-controller.js:250-252`), que no es la causa. | Confirmado por código. No reproducido en UI. |
| C3 | Alta | Un Xiaomi se queda con la lista de otro | `dispatcher.js:175-179` borra `targetWorkerId` de pendientes cuyo worker no está en el conjunto conectado. `campaign-manager.js:417-418` activa `targetedMode` si cualquier contacto tiene dueño. `campaign-manager.js:427-435` entrega la lista entera sin dueño al primer worker que se queda sin contactos propios. | No ejecutada. | Un corte de socket, aunque sea corto, suelta la lista. El otro equipo la absorbe. El primero, al volver, ya no tiene contactos con su id. | Confirmado por código. La frecuencia del corte es hipótesis. |
| C4 | Alta | Reintento distinto al que muestra el panel | El panel envía `maxAttempts: 2` (`campaign-controller.js:236`, `shift-actions.js:34`). `campaigns.js:72` escribe `maxAttempts: 1`. `campaign-manager.js:677-686`: si `attempts < maxAttempts` pasa a `retry_pending`; si no, a `failed`. | No ejecutada. | Un no contesta cierra el contacto en el primer intento. No explica por sí solo una pausa a mitad de lista. | Confirmado por código. |
| C5 | Alta | Todos los equipos esperan la misma escritura | `sendPersistedDial` espera `persistence.save` de la sesión completa antes de `call:action` (`dispatcher.js:40-75`). `save` clona la sesión con `JSON.parse(JSON.stringify)` (`persistence.js:205`) y reescribe la fila JSON (`persistence.js:262-264`). `saveChain` es una sola promesa del proceso (`persistence.js:207-217`). `saveSoon` dispara a los 150 ms (`session-state.js:42-58`) y, si no hay códigos sucios, guarda todas las sesiones. | No medida. | Con JSON de decenas de MB, cada estado y cada marcado reescriben la fila. Dos a seis teléfonos, y también dos sesiones, se serializan. Puede parecer que uno llama y el otro se paraliza. Un `UPDATE` largo no tiene tope de tiempo de consulta, solo `connectTimeout` de 10 s (`persistence.js:22`). | Mecanismo confirmado. La relación con los ~76 GB de binlogs es correlación, no causalidad medida. |
| C6 | Media | El equipo queda en `dialing` aunque Android rechazó la orden | `phone:command_ack` solo registra y reenvía (`call-events.js:310-330`). No suelta la asignación ni pide otro contacto. Android rechaza si `activeCommandId` sigue puesto (`BridgeService.kt:640-643`). El backend ya puso `worker.callState = "dialing"` y la asignación (`dispatcher.js:196-212`). El filtro de `dispatcher.js:187-188` exige estado `idle`, `ended`, `failed` o `available` y asignación vacía. | No ejecutada. | El rechazo no recupera la cola. El teléfono local sí limpia el tracking al observar `ended` o `failed` (`BridgeService.kt:1098-1112`), así que el rechazo permanente depende de que ese estado físico no llegue. | Confirmado por código. |
| C7 | Media | Al caer el socket no hay siguiente llamada | Si el worker sigue en `dialing`, `ringing` o `in_call` a los 12 s, `utility-events.js:184-197` marca `ended` y no llama a `dispatchCampaignCalls`. | No ejecutada. | El contacto puede cerrarse y el equipo quedarse en `idle` sin continuar la lista. | Confirmado por código. |
| C8 | Baja | El mismo aparato en dos sesiones | El reemplazo de slot es por sesión (`pairing-lifecycle.js:19-31`). No hay índice global de `deviceId`. | No ejecutada. | Dos sesiones podrían ordenar el mismo Xiaomi. | Hipótesis. No hay evidencia de que ocurra en este árbol. |
| C9 | Informativa | No hay tope 10–20 | El tope de campaña es 10000 (`campaigns.js:53`). El archivo de reportes recorta a 100 (`dispatcher.js:269-271`). Hay hasta 20 QR por sesión (`devices.js:75`), que es un tope de equipos, no de llamadas. Android usa 10 s sin estado Telecom (`BridgeService.kt:697-710`), 20 s y 40 s de marcado (`BridgeService.kt:1073-1085`) y latido de 10 s (`BridgeService.kt:1357-1382`). | Búsqueda estática. | Esos números son tiempos por llamada o cupos de equipos, no un contador de contactos. | Confirmado que no hay ese contador. |
| C10 | Media | El bloqueo anual puede usar una foto vieja de intentos | `restrictions.js:12-21` arma la clave de caché con `Object.keys(runtime.persistence.records)`. `records` es un `Map`; `Object.keys` de un `Map` devuelve `[]`. La clave queda fija mientras no cambie el número de sesiones. `clearAllCallAttemptsCache` (`restrictions.js:24`) no tiene ningún llamador. | Reproducido: `Object.keys(new Map([["a",1]]))` tiene longitud 0. | `excludeCalledPending` (`contact-book.js:88-105`) puede no ver intentos nuevos y volver a marcar el mismo teléfono en otro contacto, o seguir usando la primera foto. No explica una parada a las 10–20 llamadas. | Confirmado por código. No ejecutado contra una campaña. |

## 4. Listas generales, listas exclusivas y 2 a 6 Xiaomi

Inicio general (`campaign-controller.js:212-246`): junta todos los contactos con teléfono válido que no estén `completed`, `failed`, `awaiting_callback` ni `no_contactado`. Si la lista del contacto está en el mapa local de equipos, le pone `targetWorkerId`. Si no, lo deja sin dueño. El nombre de campaña es siempre el rótulo `Asignación automática`.

Por el filtro de `campaign-manager.js:420`, ese inicio no selecciona contactos de listas reales. `targetedMode` ni siquiera llega a decidir.

Inicio por equipo (`device-controls.js:96-121` y `devices.js:152-183`): manda solo la lista de ese slot y el backend les pone `targetWorkerId`. No cambia `listName`. `listName` solo se escribe en `syncCampaignContacts` (`campaign-manager.js:258`), que corre desde `POST /campaign/start`. En una campaña nueva está vacío (`campaign-manager.js:59`) y el filtro deja pasar. Cada worker solo recibe contactos con su id (`campaign-manager.js:418`). Si antes se pulsó el inicio general, `listName` sigue siendo `Asignación automática` y el inicio por equipo también elige cero contactos. Con una campaña nueva, dos listas pueden avanzar a la vez. El estado no las corta para siempre: el siguiente marcado espera el `retryPending` de C1.

Si cualquier contacto tiene dueño, los demás workers no toman contactos ajenos. La excepción es C3: al borrar el dueño de un desconectado, el siguiente worker que agota su lista se apropia de toda la lista libre, no de un contacto (`campaign-manager.js:432-435`). Con 2 a 6 teléfonos el efecto es el mismo: un solo worker absorbente y el resto sin elegibles. No hay una cola por dispositivo fuera de `assignments` y `targetWorkerId`.

`switchWorkerList` (`campaign-manager.js:582-623`) sí mira si otro worker conectado está en llamada sobre la lista destino. No mira una asignación pendiente. Puede reetiquetar contactos `pending` de una lista que otro equipo todavía no ha marcado.

El modo general y el modo por equipo comparten una sola campaña y un solo objeto `assignments`. No hay seis colas independientes.

## 5. MySQL, colas y binlogs

Qué hace cada marcado y cada estado:

1. `sendPersistedDial` clona la sesión y entra a `saveChain` (`dispatcher.js:40`, `persistence.js:197-217`).
2. `saveNow` abre transacción, lee la fila, compara el JSON completo y hace `INSERT ... ON DUPLICATE KEY UPDATE` de toda la columna `data` (`persistence.js:250-274`).
3. Los intentos sucios se escriben en `vc_call_attempts` con `SELECT ... FOR UPDATE` por intento (`call-history.js:115-118`).
4. `phone:status` vuelve a pedir un guardado durable antes del recibo y del siguiente marcado (`call-events.js:256-283`). Ese guardado es C1: no llega a la transacción. El reintento de los 10 s sí entra a `saveChain` con el `Map` completo y, si MySQL acepta la fila, dispara el callback.

`historyGate.blocked` siempre devuelve `false` (`call-history-gate.js:12-14`). No frena el despacho. La frase de `dispatcher.js:164` no protege nada.

No se midió `persistMs`, ni bytes por escritura, ni binlog por hora. El mecanismo alcanza para hacer crecer el binlog si el formato es por filas y la columna JSON se reescribe entera en cada estado: el binlog guarda la imagen de la fila, no el diff del contacto. Los ~18 MB y ~20 MB citados harían cada `UPDATE` muy caro. No está demostrado que esas dos filas hayan producido los ~76 GB. Tampoco se demostró que el purgado a 3 días haya quitado la causa; solo el síntoma de disco. No hay respaldo externo en este árbol que se pueda dar por verificado.

`lastSnapshot` se sustituye por el snapshot parcial del `save` (`persistence.js:237`). Un guardado de una sola sesión deja el respaldo en memoria sin las demás. Eso afecta a `backup()`, no a la tabla, porque cada fila se escribe por su código.

La comparación `JSON.stringify(existingData) === JSON.stringify(data)` (`persistence.js:261`) puede fallar por el orden de claves que devuelve el driver y forzar una reescritura aunque el contenido sea el mismo. Es hipótesis, no se ejecutó contra MySQL.

## 6. Android, aparte del backend

`call:action` llega a `BridgeService.kt:519`. `dial` deduplica por `commandId` (`:540-557`) y llama a `TelecomManager.placeCall` (`:686-691`). El ACK de Socket.IO no lo usa el servidor (`dispatcher.js:71-75`); el teléfono manda `phone:command_ack` (`BridgeService.kt:1458-1469`). El servidor no actúa sobre ese ACK (C6).

Estados físicos: `dialing`, `ringing`, `in_call`, `ended`, `failed`. Un `idle` de campaña se informa como `ended` si había llamada de campaña (`BridgeService.kt:1054`). El backend solo suelta al worker con `ended` o `failed` mientras el contacto sigue en estado activo (`campaign-manager.js:660`). Un `idle` sin `terminalConfirmed` no libera (`call-events.js:224` y `campaign-manager.js:657-659`).

Buzón: `detectedVoicemail` y `detectedAnnouncement` viajan en `phone:status` (`BridgeService.kt:1547-1549`). El backend anota `buzon_de_voz` en el intento y solo cierra el contacto cuando llega el estado terminal (`campaign-manager.js:637-670`). Shizuku y Vosk no participan en la decisión de soltar la cola. Si el buzón se detecta y el `ended` no llega, el worker sigue ocupado por la regla de estado terminal, no por el reconocedor.

Latido: ping cada 10 s; si el pong tarda más de 5 s, el teléfono corta el socket (`BridgeService.kt:1377-1382`). Un `save` lento puede alargar el pong. Es una hipótesis de desconexión, no una prueba de que el latido sea la causa de las paradas.

Recuperación: al reconectar se reemite el último estado (`BridgeService.kt:480-484`). El tracking se limpia en el teléfono al ver el fin (`:1110-1112`) y también si el ACK dice `accepted` y `terminal` (`:499-506`). El servidor no vuelve a marcar por ese ACK.

## 7. Correcciones por fases

No implementar hasta aprobación explícita. Hace falta un respaldo externo verificable antes de cualquier escritura de reparación.

Fase 1, sin cambiar la durabilidad del intento:

- `commit` debe guardar `this.getSessions()` o un `Map` con el código real, y pasar el código en `changedCodes`. Hoy el arreglo ni identifica la sesión ni es iterable como pares. El reintento de 10 s no sustituye ese arreglo: llega tarde y reescribe todas las sesiones.
- El siguiente marcado debe seguir esperando a que ese `save` confirme. No emitir `call:action` ni avanzar la cola si el guardado falla.
- Tratar `Asignación automática` como “sin filtro de lista”. El filtro literal solo debe aplicarse cuando `listName` es una lista real, como `Pendientes del turno` si esa lista también existe en los contactos. Hoy `Pendientes del turno` tiene el mismo problema: los contactos conservan su lista original (`shift-actions.js:39`) y el filtro exige igualdad (`campaign-manager.js:420`).
- Dejar de borrar `targetWorkerId` por no aparecer en el snapshot de conectados. Una desconexión no transfiere la lista. La apropiación de `campaign-manager.js:427-435` no debe correr mientras el dueño anterior pueda reconectar.
- Una sola fuente para `maxAttempts`. El `1` fijo de `campaigns.js:72` ignora el `2` del panel.

Fase 2, después de medir una campaña de prueba:

- Seguir guardando el intento en `vc_call_attempts` dentro de la transacción. Reducir la reescritura del JSON de sesión a los campos que de verdad cambiaron, sin perder el orden de `saveChain` ni marcar un intento que no quedó escrito.
- Si Android responde `phone:command_ack` con `ok: false`, soltar la asignación solo cuando el estado físico no esté en llamada, y volver a encolar ese contacto sin sumar otro intento si `placeCall` no llegó a ocurrir.
- Al cumplirse la gracia de 12 s, programar el despacho de ese worker igual que hace el estado terminal.
- Pruebas de `pickNextContact`, de `commit` con `Map`, y de dos workers con listas distintas.

No conviene empezar por purgar binlogs, borrar sesiones ni tocar Shizuku.

## 8. Plan de pruebas

No se ejecutó ninguna. Resultados observados: solo el `TypeError` del bucle equivalente al de `save`. El resto es resultado esperado.

| Prueba | Esperado si el código sigue igual | Esperado después de la fase 1 |
| --- | --- | --- |
| 1 teléfono, 20 contactos, una lista, sin llamadas reales: simular `phone:status` `ended` | El `commit` falla. Si `retryPending` guarda el `Map`, el segundo `call:action` sale unos 10 s después. Si ese guardado falla, no hay segundo marcado | 20 marcados, un intento cada uno, sin duplicar `attemptId`, sin esperar el intervalo de reintento |
| 2 teléfonos, 2 listas, 20 contactos cada una | El inicio general marca 0. Si el general ya corrió, el inicio por equipo también marca 0. En una campaña nueva, el inicio por equipo marca y el siguiente espera el reintento de 10 s | Cada lista avanza solo en su equipo |
| 6 teléfonos | Misma parada, más espera en `saveChain` | Ningún equipo espera el estado de otro para elegir su propio contacto. La escritura sigue ordenada. |
| Cortar el socket durante `dialing` y reconectar antes de 12 s | La lista puede quedar sin dueño y pasar al otro equipo | La lista sigue en el equipo original |
| Perder el `ended` | El worker queda ocupado | Sigue ocupado hasta estado físico o hasta la gracia, y luego continúa sin duplicar |
| MySQL lento | `saveChain` retrasa a todas las sesiones. No se midió | Se registra `persistMs` y `queueWaitMs`. El marcado no sale antes del commit |
| Buzón | El contacto no se cierra hasta `ended` o `failed` | Igual. Shizuku no decide la cola |
| Mismo `deviceId` en dos sesiones | No hay candado global | Hay que añadir la prueba antes de afirmar que está prohibido |

Medidas a agregar en esa prueba, sin datos personales: `sessionCode`, `workerId`, `contactId`, `callId`, `commandId`, lista, `persistMs`, `queueWaitMs`, `dispatchMs`, tiempo hasta ACK, tiempo hasta terminal, `nextDialMs`, profundidad de `saveChain` y bytes de binlog por hora.

## 9. Respaldo, despliegue y rollback

No hay respaldo externo confirmado. No desplegar la corrección ni ejecutar una campaña de reparación sobre `llamadas1` hasta tener una copia restaurable y probada fuera de este servidor.

Despliegue propuesto, cuando se apruebe: primero el arreglo de `commit` y el filtro de lista, en un proceso nuevo, con las sesiones actuales solo en lectura. Verificar con la prueba de 2 teléfonos. Después el aislamiento de `targetWorkerId`. La reducción del JSON queda en una tercera salida.

Rollback: volver al build anterior del proceso Node. No hace falta migración de esquema para la fase 1. No borrar filas de `sessions` ni de `vc_call_attempts` para revertir. Si una campaña de prueba dejó asignaciones `dialing` huérfanas, el rollback de código no las limpia; hay que decidir un cierre explícito con el intento ya escrito, no un borrado.

## 10. Preguntas abiertas

- ¿El proceso que hoy llama en producción tiene este `call-history-gate.js:39` y este `retryPending` de 10 s? Más de una llamada automática no descarta este archivo: el reintento puede estar reanudando la cola.
- ¿Las pausas entre llamadas se acercan a 10 s más el tiempo de `persistMs`? Eso encajaría con C1 más C5. Un corte seco, sin otro marcado aunque MySQL responda, no encaja con este árbol.
- ¿El operador usa el botón general o el botón por equipo? El primero, en este árbol, no elige contactos.
- Tamaño real de cada `sessions.data`, frecuencia de `UPDATE` y `binlog_format` durante una campaña. Sin eso, los 76 GB siguen siendo correlación.
- Si el Xiaomi emite `ended` con el mismo `callId` de la asignación. Sin ese par, `updateActiveCallState` no suelta al worker (`campaign-manager.js:630` y `:636`).

## 11. Checklist de aceptación

- Cero llamadas duplicadas: un `attemptId` activo por contacto y un `commandId` no reutilizado para un `placeCall` nuevo.
- Cero contactos perdidos: un `pending` o `retry_pending` sigue elegible para su worker después de un fallo de guardado, y no pasa a otra lista.
- Progreso independiente: el estado de un Xiaomi no borra el `targetWorkerId` de otro ni elige contactos de su lista.
- Sin bloqueo indefinido: un terminal confirmado, o la gracia de desconexión, siempre programa el siguiente marcado de ese worker. Un `commit` fallido no deja la asignación tomada en memoria y abierta en MySQL.
- El panel y el servidor usan el mismo `maxAttempts`.
- Ningún marcado sale antes de que MySQL confirme el intento.

## Cierre

**Demostrado:** el guardado directo de `phone:status` no puede completar porque recibe un arreglo donde `save` exige un `Map`. El marcado siguiente no sale en ese callback; puede salir cuando `retryPending` guarda el `Map`, cada 10 s. El inicio general filtra por el nombre `Asignación automática` y no por las listas importadas, y ese nombre no lo limpia el inicio por equipo. El servidor fuerza un intento aunque el panel pide dos. Desconectar a un equipo puede soltar su lista y otro equipo se la queda entera. Todas las sesiones comparten `saveChain` y reescriben el JSON completo. La caché de intentos no ve las claves de un `Map`. Un reinicio ya devuelve la asignación abierta a `retry_pending`.

**No demostrado:** que el corte ocurra a las 10–20 llamadas, que los JSON grandes hayan generado los 76 GB, y que Shizuku, Vosk o la batería del Xiaomi sean la causa.

**Corregir primero:** el argumento de `commit`, el filtro del rótulo general y la cesión de lista al desconectar.

**No tocar todavía:** binlogs, borrado de sesiones, la APK, ni la regla de esperar el guardado antes de marcar.
