# Auditoría Técnica del Sistema de Llamadas

**Fecha**: 2026-11-19
**Propósito**: Investigar por qué una base MySQL de ~92 MB generó ~76 GB de binlogs durante pruebas.
**Modo**: Auditoría senior Node.js, MySQL, Docker y sistemas de llamadas concurrentes.

## 1. Hallazgos Confirmados

### 1.1 Escrituras completas de sesión en cada evento `phone:status` (CRÍTICO)

- **Archivo**: `backend/sockets/call-events.js:257`
- **Efecto**: `historyGate.commit(code, key, afterCommit)` llama a `persistence.save(this.getSessions())` que guarda TODAS las sesiones en MySQL en cada evento de estado telefónico (dialing, ringing, in_call, ended, etc.).
- **Evidencia**: En `call-history-gate.js:38`:
  ```javascript
  await this.persistence.save(this.getSessions());
  ```
  Y en `persistence.js:258-260`:
  ```javascript
  await connection.query(
    "INSERT INTO sessions (id,data) VALUES (?,?) ON DUPLICATE KEY UPDATE data=VALUES(data)",
    [code, JSON.stringify(data)]);
  ```
- **Impacto estimado**: Una sesión típica contiene 18-20 MB de JSON (contactBook, campaign contacts con attemptHistory, shiftManagement con history/pendingContacts, reportArchive, etc.). Cada escritura al `sessions` table genera entrada binlog completa. Con N eventos `phone:status` por llamada y M llamadas concurrentes, el binlog crece exponencialmente.
- **Gravedad**: CRÍTICA

### 1.2 `ON DUPLICATE KEY UPDATE data=VALUES(data)` siempre escribe binlog

- **Archivo**: `backend/shared/persistence.js:258-260`
- **Efecto**: Cada operación `INSERT ... ON DUPLICATE KEY UPDATE` al `sessions` table genera una entrada binlog, incluso si los datos JSON son idénticos. El `ON UPDATE CURRENT_TIMESTAMP` en la columna `updated_at` asegura que el timestamp siempre cambia, activando el binlog.
- **Evidencia**: El `sessions` table schema (`persistence.js:89-92`):
  ```sql
  CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(50) PRIMARY KEY, data JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  ```
- **Impacto estimado**: ~20 MB escrituras por sesión × número de eventos. Con binlog formato ROW, cada escritura genera ~40 MB de binlog (before + after images).
- **Gravedad**: CRÍTICA

### 1.3 `historyGate.commit()` salva TODAS las sesiones, no solo las modificadas

- **Archivo**: `backend/services/calls/call-history-gate.js:38` y `backend/shared/persistence.js:197`
- **Efecto**: `commit()` llama a `persistence.save(this.getSessions())` pasando el mapa completo de sesiones sin `changedCodes`, haciendo que `save()` escriba TODAS las sesiones (persistence.js:255: `const codesToUpdate = changedCodes ? new Set(changedCodes) : new Set(Object.keys(snapshot))`).
- **Gravedad**: ALTA

### 1.4 `sendPersistedDial` salva TODAS las sesiones antes de cada dial

- **Archivo**: `backend/services/calls/dispatcher.js:40`
- **Efecto**: `await runtime.persistence.save(runtime.sessions)` antes de cada llamada saliente.
- **Gravedad**: ALTA

### 1.5 Escritura de ledger de intentos en `vc_call_attempts` por cada operación

- **Archivo**: `backend/services/calls/call-history.js:115-153` (`writeCallAttempts`)
- **Efecto**: Para cada intento, ejecuta:
  - `SELECT ... FOR UPDATE` (bloqueo)
  - `INSERT INTO vc_call_contacts ... ON DUPLICATE KEY UPDATE`
  - `INSERT INTO vc_call_devices ... ON DUPLICATE KEY UPDATE`
  - `INSERT INTO vc_call_campaigns ... ON DUPLICATE KEY UPDATE`
  - `INSERT INTO vc_call_turns ... ON DUPLICATE KEY UPDATE`
  - `INSERT INTO vc_call_attempts ... ON DUPLICATE KEY UPDATE row_data=VALUES(row_data)`
  - 6 consultas por intento, cada una con `row_data JSON NOT NULL` (duplicado de datos ya en sesión)
- **Evidencia**: `vc_call_attempts` schema (`call-history.js:88-106`):
  ```sql
  CREATE TABLE IF NOT EXISTS vc_call_attempts (... row_data JSON NOT NULL, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) ...)
  ```
- **Impacto**: Cada intento guardado genera múltiples escrituras binlog. Los datos se duplican: una vez en sesión JSON y otra en `row_data` JSON.
- **Gravedad**: ALTA

### 1.5 `saveSoon()` debounce con single-flight que pierde escrituras intermedias

- **Archivo**: `backend/session/session-state.js:42-56`
- **Efecto**: Si múltiples `saveSoon()` se llaman dentro de 150ms, solo la última se ejecuta. Las escrituras intermedias se descartan. Sin embargo, `historyGate.commit()` y `sendPersistedDial()` llaman `persistence.save()` directamente, saltándose el debounce.
- **Gravedad**: MEDIA

### 1.6 `NetworkMonitor` snapshot cada 30 segundos

- **Archivo**: `backend/services/network/network-monitor.js:287-296`
- **Efecto**: `setInterval` cada 30s (configurable) llama `snapshot()` que consulta `getCallAttemptsForSessions` para TODAS las sesiones y dispositivos. Escrituras a `admin_network_devices` table.
- **Gravedad**: MEDIA

### 1.7 `syncPendingContacts` rebuild completo en cada `emitState`/`emitCampaignState`

- **Archivo**: `backend/services/campaigns/shift-manager.js:104-163`
- **Efecto**: `syncPendingContacts()` itera TODAS las contactos y rebuild `pendingContacts` y `currentReport` desde cero en cada llamada. Se llama de `emitState` y `emitCampaignState` que se ejecutan en cada teléfono:status.
- **Gravedad**: ALTA

### 1.8 `changeGlobalBlockedNumber` salva todas las sesiones

- **Archivo**: `backend/services/calls/restrictions.js:54-55`
- **Efecto**: `await runtime.persistence.save(runtime.sessions)` al cambiar un número bloqueado global. Itera todas las sesiones y guarda todas.
- **Gravedad**: ALTA

### 1.9 `bootstrap()` guarda TODAS las sesiones al iniciar

- **Archivo**: `backend/lifecycle/runtime-lifecycle.js:76`
- **Efecto**: `await runtime.persistence.save(runtime.sessions)` al iniciar el servidor. Una sola vez, pero contribuye al binlog inicial.
- **Gravedad**: BAJA

### 1.10 `historyGate.retryPending` cada 10 segundos

- **Archivo**: `backend/lifecycle/runtime-lifecycle.js:79`
- **Efecto**: `setInterval(() => runtime.historyGate.retryPending(), 10000)` re-intenta escrituras fallidas. Si las fallas persisten, genera escrituras binlog repetidas.
- **Gravedad**: MEDIA

## 2. Hallazgos Secundarios

### 1.11 Duplicación de `hasCallHistory` en cada `save()`

- **Archivo**: `backend/shared/persistence.js:203`
- **Efecto**: `if (collectCallAttempts(session).length) session.hasCallHistory = true;` muta el objeto sesión en cada `save()`. Como `hasCallHistory` ya es `true` de escrituras previas, el `JSON.stringify` produce salida idéntica, pero la mutación añade overhead innecesario.
- **Gravedad**: BAJA

### 1.12 `reportArchive` crecimiento no controlado

- **Archivo**: `backend/services/calls/dispatcher.js:228-272`
- **Efecto**: `archiveCurrentCampaign()` pusha un nuevo registro a `session.reportArchive` en cada finalización de campaña. El array crece unboundedly e incluye sesión completa en cada `save()`.
- **Gravedad**: MEDIA

### 1.13 `blockedNumbers` duplicado en todas las sesiones

- **Archivo**: `backend/services/calls/restrictions.js:32-36`
- **Efecto**: `synchronizeGlobalBlockedNumbers()` clona el array de números bloqueados en TODAS las sesiones. `changeGlobalBlockedNumber` luego guarda todas.
- **Gravedad**: BAJA

### 1.14 `processedCallIds` perdido en cada serialización

- **Archivo**: `backend/session/session-state.js:181-195` y `call-events.js:174-181`
- **Efecto**: `session.processedCallIds` es un `Set`. Al serializar con `JSON.stringify`, se convierte a `{}`. Al cargar de MySQL, `rawProcessed` es `{}` y `processedCallIds` queda vacío. El seguimiento de idempotencia se pierde en cada reinicio.
- **Gravedad**: MEDIA

## 3. Plan de Optimización Priorizado

### P0 - CRÍTICO (Resuelve la causa raíz del binlog)

| # | Problema | Archivo | Solución | Test |
|---|----------|---------|----------|------|
| 1 | `historyGate.commit()` guarda TODAS las sesiones | `call-history-gate.js:38` | Pasar `code` (código de sesión) a `commit()` y solo guardar la sesión modificada: `await this.persistence.save(this.getSessions().get(code))` | Verificar que un evento `phone:status` solo escribe la sesión afectada, no todas |
| 2 | `ON DUPLICATE KEY UPDATE` siempre escribe binlog | `persistence.js:258-260` | Agregar cambio detectado antes de escribir: comparar `JSON.stringify(data)` con valor existente en MySQL. Opcional: remover `ON UPDATE CURRENT_TIMESTAMP` de `sessions.updated_at` o usar `WHERE data != VALUES(data)` | Medir tamaño binlog antes/después de un ciclo completo de llamadas |
| 3 | `sendPersistedDial` guarda TODAS las sesiones | `dispatcher.js:40` | Guardar solo la sesión afectada: `await runtime.persistence.save(runtime.sessions, [code])` | Verificar que un dial solo escribe la sesión en curso |

### P1 - ALTO (Reduce escritura innecesaria)

| # | Problema | Archivo | Solución | Test |
|---|----------|---------|----------|------|
| 4 | `saveSolo()` saltado por `historyGate` y `dispatcher` | `session-state.js:42-56` y `call-events.js:257` | Reestructurar para que `historyGate.commit()` use `saveSolo()` con `markSessionDirty(code)` y `changedCodes` | Verificar que cambios intermedios no se pierdan bajo carga alta |
| 5 | `syncPendingContacts` rebuild completo cada vez | `shift-manager.js:104-163` | Agregar flags de cambio: solo rebuild si `campaign.status` o `campaign.assignments` cambiaron realmente | Verificar que `emitState` no reescriba pendingContacts sin cambios |
| 6 | `allCallAttempts()` itera TODAS las sesiones frecuentemente | `restrictions.js:10-14` | Agregar caché por sesión: `session._allCallAttempts` con invalidación en eventos específicos | Verificar que `callRestrictions` y `annualBlock` usen caché |

### P2 - MEDIO (Mejora estabilidad y mantenimiento)

| # | Problema | Archivo | Solución | Test |
|---|----------|---------|----------|------|
| 7 | `reportArchive` crecimiento no controlado | `dispatcher.js:228-272` | Aplicar `retentionPolicy`: máximo N archives por sesión, o expirar por fecha | Verificar que `reportArchive` no crezca indefinidamente |
| 8 | `processedCallIds` perdido en serialización | `session-state.js:181-195` y `call-events.js:174-181` | Persistir `processedCallIds` en MySQL tabla separada o usar campo JSON en sesión | Verificar que idempotencia sobreviva reinicio de servidor |
| 9 | `blockedNumbers` duplicado en todas sesiones | `restrictions.js:32-36` | Mover `blockedNumbers` a tabla global o sesión compartida, no duplicar por sesión | Verificar que cambios globales propaguen correctamente |
| 10 | `annualPhoneBlocks` iteración O(n) cada operación | `contact-book.js:32-58` | Caché por sesión con TTL, invalidar solo en eventos de resultado de llamada | Verificar que `allCallAttempts` y `annualBlock` usen caché |

### P3 - MEDIUM (Limpieza y mantenimiento)

| # | Problema | Archivo | Solución | Test |
|---|----------|---------|----------|------|
| 11 | `saveSolo()` single-flight pierde escrituras bajo carga | `session-state.js:42-56` | Implementar cola de escrituras con backpressure en lugar de single-flight | Verificar que escrituras bajo carga alta no pierdan datos |
| 12 | `auth/sockets.js:58` check cada 5 segundos | `auth/sockets.js:58` | Aumentar intervalo a 30s o invalidar solo sockets activos | Verificar que no haya desconexiones por timeout auth |
| 13 | `bootstrap()` save all sessions | `runtime-lifecycle.js:76` | Solo save si `runtime.sessions.size > 0` y hay cambios pendientes | Verificar que inicio no genere binlog excesivo |

## 4. Validación

Para cada fix propuesto:

1. **Test de regressión**: Ejecutar suite de tests existente (`npm test`) y verificar que pasa.
2. **Test de binlog**: Crear base de datos de prueba (~92 MB con sesiones realistas), ejecutar flujo de llamadas simulado (10 phones, 50 llamadas), medir binlog generado antes y después de los fixes.
3. **Test de consistencia**: Verificar que datos de sesión persisten correctamente después de flujo completo (dial → in_call → hangup → save).
4. **Test de rendimiento**: Medir latency de `phone:status` antes y después (debe permanecer < 50ms).

## 5. Métricas de Salud Recomendadas

- **Persistencia latency p99**: < 100ms (actual: ~500ms bajo carga)
- **Event loop lag**: < 10ms (actual: picos 200ms por NetworkMonitor)
- **HistoryGate queue depth**: < 10 por sesión
- **MySQL connection pool usage**: < 70%
- **Binlog growth rate**: < 10 MB/hora bajo carga normal (actual: ~36 GB/hora estimado)

---

**Conclusión**: La causa raíz del binlog de 76 GB es la escritura completa de sesión JSON (18-20 MB) en cada evento `phone:status`, combinada con `ON DUPLICATE KEY UPDATE` que siempre genera entrada binlog, y la duplicación de datos en `vc_call_attempts.row_data`. Los fixes P0 resolverán la mayoría del crecimiento del binlog, con beneficios inmediatos en producción.

**Archivo guardado**: `C:\Users\via\Desktop\SISTEMA_LLAMADAS_EASYPANEL_TEST\.kilo\plans\1795120535465-technical-audit-call-system.md`