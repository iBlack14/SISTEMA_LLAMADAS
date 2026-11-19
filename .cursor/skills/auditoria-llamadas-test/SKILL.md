---
name: auditoria-llamadas-test
description: >-
  Ejecuta la auditoría de solo lectura de llamadas simultáneas en este
  repositorio (frontend, backend Node.js/MySQL/Socket.IO y APK Android Xiaomi).
  Usar cuando el usuario pida la skill de test, la auditoría de concurrencia
  de llamadas, el prompt de Codex de llamadas, o el informe
  INFORME_CONCURRENCIA_LLAMADAS.md. No modifica archivos ni producción.
disable-model-invocation: true
---

# Prompt maestro para Codex — Auditoría de llamadas simultáneas

Analiza exhaustivamente este repositorio de **sistema de llamadas con frontend, backend Node.js/MySQL/Socket.IO y APK Android para varios Xiaomi**. Usa la skill `.agents/skills/llamadas-concurrency-audit/SKILL.md` y sigue sus restricciones.

## Problema real
Al subir listas de contactos, asignarlas en modo general o a teléfonos concretos e iniciar campañas, después de unas 10–20 llamadas algunos teléfonos parecen paralizarse. A veces un Xiaomi llama y otro deja de llamar, incluso con listas diferentes. Necesito determinar si hay un cuello de botella global, errores de asignación, bloqueo por MySQL, eventos de fin de llamada perdidos o problemas de Android/conectividad.

## Antecedentes para contrastar, NO asumir como diagnóstico definitivo
- En auditoría estática anterior se señalaron: `Asignación automática` vs. filtro literal de `listName`; `saveChain` global; persistencia de sesión antes de `call:action`; espera de estado terminal; reasignación al desconectar; `maxAttempts` inconsistente.
- MySQL `llamadas1` ocupaba ~92 MB, con 2 JSON en `sessions` de ~18.5/20.48 MB; se acumularon ~76 GB de binlogs. No está probado que esas sesiones expliquen todo el crecimiento.
- Se purgaron binlogs antiguos, el disco quedó ~23 % ocupado y la retención pasó a 3 días. No hay respaldo externo confirmado.

## Instrucciones
1. Recorre el código real desde la importación hasta la siguiente llamada y cita **archivo:línea**.
2. Investiga especialmente la independencia de listas y dispositivos y las condiciones de carrera entre 2 y 6 teléfonos.
3. Diseña pruebas para reproducir la detención tras 10–20 contactos; distingue hipótesis de defectos demostrados.
4. Examina las operaciones MySQL, tamaño/frecuencia de escrituras, `saveChain`, transacciones y Socket.IO.
5. Examina Android: `call:action`, `placeCall`, estados físicos, buzón, Shizuku/Vosk, ACK, desconexión y recuperación.
6. Entrega un informe `INFORME_CONCURRENCIA_LLAMADAS.md` con matriz de hallazgos, diagrama del flujo, plan de corrección priorizado, pruebas, rollback y criterios de aceptación.
7. **No modifiques archivos ni producción en esta primera ejecución.** No hagas llamadas reales, no elimines datos y no imprimas secretos. Solicita aprobación antes de implementar.

Objetivo: que cada teléfono avance de forma independiente por su lista, sin llamadas duplicadas, sin contactos perdidos y sin paralizaciones silenciosas.
