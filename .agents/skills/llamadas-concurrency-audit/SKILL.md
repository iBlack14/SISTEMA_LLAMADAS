---
name: llamadas-concurrency-audit
description: Audita de extremo a extremo la importación, asignación, despacho y finalización de campañas de llamadas multi-Xiaomi; identifica bloqueos, interferencias entre listas y escrituras excesivas en MySQL. Úsala cuando el usuario pida revisar llamadas paralizadas, campañas, Android, Socket.IO o concurrencia.
---

# Auditoría de concurrencia del sistema de llamadas

## Misión
Investigar y, SOLO tras aprobación explícita, corregir por qué los dispositivos Android se detienen tras ~10–20 llamadas o un equipo deja de llamar cuando otro llama, incluso con listas distintas. Basar conclusiones en el repositorio realmente disponible, no asumir que el ZIP y producción coinciden.

## Contexto verificado en auditoría estática anterior (revalidar en código)
- Frontend: `frontend/features/contacts/import/import-actions.js`, `frontend/features/campaigns/campaign-controller.js`.
- Backend: `backend/routes/campaigns.js`, `backend/services/campaigns/campaign-manager.js`, `backend/services/calls/dispatcher.js`, `backend/sockets/call-events.js`, `backend/shared/persistence.js`.
- Android: `android-app/app/src/main/java/com/voipvc/bridge/BridgeService.kt`.
- Riesgos a comprobar: `listName='Asignación automática'` frente a filtro literal; `maxAttempts` frontend/backend; persistencia de JSON de sesión antes de emitir `call:action`; cola `saveChain`; estados terminales y ACK perdidos; cambios de `targetWorkerId` al desconectar un worker; `targetedMode` global; mismo dispositivo asociado a varias sesiones.
- Datos operativos comunicados: MySQL `llamadas1` ~92 MB; `sessions` con dos JSON de ~18.5 y 20.48 MB; ~76 GB de binlogs acumulados y luego purgados; retención ahora 3 días; sin respaldo externo confirmado. No asumir que las sesiones grandes son la causa probada de los binlogs.

## Restricciones obligatorias
1. **Primera fase solo lectura.** No modificar producción, no ejecutar migraciones, no desplegar APK, no eliminar tablas, sesiones ni binlogs.
2. No revelar secretos, números telefónicos completos, tokens, identificadores personales ni JSON íntegros.
3. Antes de cualquier cambio con riesgo de datos: respaldo externo verificable y plan de rollback. Si no existe, detener la implementación.
4. No sacrificar durabilidad del intento para mejorar velocidad; no marcar sin registrar el intento de forma confiable.
5. No duplicar llamadas ni reasignar contactos silenciosamente. Verificar estado físico de Android antes de liberar una asignación.
6. Separar **confirmado por código**, **reproducido por prueba**, **hipótesis** y **desconocido**. Cada hallazgo debe incluir ruta y líneas reales de la versión analizada.
7. Nunca asumir que Wi-Fi, Shizuku o Vosk explican bloqueos de backend. Investigar conectividad y captura por separado.

## Procedimiento
### Fase A — Inventario y trazado
- Identificar entrypoints, versión, scripts, configuración, esquema SQL, tests y código realmente desplegado si está disponible.
- Dibujar el flujo: subir CSV/XLSX/TXT → crear lista → asignación general/exclusiva → iniciar campaña → elegir contacto → reservar por `workerId` → persistir intento → emitir Socket.IO → Android `placeCall` → `phone:status`/ACK → confirmar terminal → despachar siguiente.
- Identificar límites de exclusión mutua: global, por sesión, por campaña, por lista, por worker, por dispositivo físico.

### Fase B — Investigar 10 focos
1. Filtro literal de `Asignación automática` frente a listas reales.
2. Asignaciones generales, por lista y por equipo; ownership tras desconexiones.
3. Colas globales `saveChain`, serialización por sesión y bloqueos cruzados.
4. Reescritura de `sessions.data` JSON y volumen de binlogs; medir frecuencia y tamaño, no inferir de tamaños estáticos.
5. Latencia y fallos en `sendPersistedDial`/transacciones SQL.
6. `call:action` emitido, ACK recibido, retries y deduplicación.
7. Estados `dialing`, `ringing`, `in_call`, `ended`, `failed`; eventos perdidos o tardíos.
8. Bloqueo después de 10 o 20 contactos; comprobar si hay límite real, reintentos o agotamiento de elegibles.
9. Dispositivos físicos repetidos entre sesiones y órdenes solapadas.
10. Diferencias de configuración frontend/backend (`maxAttempts`) y efectos de conexión móvil, batería, Shizuku y Vosk.

### Fase C — Evidencia y pruebas
- Buscar rutas y líneas exactas mediante búsqueda estática; abrir código completo de funciones relevantes.
- Añadir o proponer trazas con IDs de correlación `sessionCode`, `workerId`, `contactId`, `callId`, `commandId`, `list` y timestamps, sin PII.
- Proponer pruebas: 1 teléfono/20 contactos; 2 teléfonos/2 listas distintas/20 cada una; 6 teléfonos; pérdida de terminal; Socket.IO desconectado; MySQL lento; buzón; mismo dispositivo en dos sesiones.
- Medir `persistMs`, `queueWaitMs`, `dispatchMs`, tiempo hasta ACK, tiempo hasta terminal, `nextDialMs`, backlog y crecimiento binlog por hora.
- No ejecutar pruebas con llamadas reales sin aprobación explícita.

### Fase D — Plan y cambios (solo con aprobación)
- Priorizar corrección de elegibilidad de contactos, aislamiento de listas/worker y consistencia de reintentos.
- Diseñar persistencia transaccional de intentos pequeños, preservando orden e idempotencia; no reemplazar guardado duradero por envío inseguro.
- Reconciliar asignaciones estancadas con Android antes de reintentar.
- Añadir pruebas automatizadas y despliegue gradual con rollback.

## Entrega obligatoria
Generar `INFORME_CONCURRENCIA_LLAMADAS.md` con:
1. Resumen ejecutivo y alcance real.
2. Mapa de flujo extremo a extremo.
3. Matriz de conflictos (ID, severidad, síntoma, evidencia archivo:línea, reproducción, impacto, confianza).
4. Análisis de listas generales/exclusivas y concurrencia entre 2 y 6 Xiaomi.
5. Análisis de MySQL, colas y binlogs (distinguiendo correlación y causalidad).
6. Propuesta de arquitectura y correcciones por fases, con riesgos.
7. Plan de pruebas con resultados observados vs. esperados.
8. Plan de respaldo, despliegue y rollback.
9. Preguntas pendientes y pruebas necesarias para confirmar causas.
10. Checklist de aceptación: cero duplicados, cero pérdidas, progreso independiente, no bloqueos indefinidos.

Al final, resumir: **qué está demostrado, qué no, qué corregir primero y qué NO tocar todavía**.
