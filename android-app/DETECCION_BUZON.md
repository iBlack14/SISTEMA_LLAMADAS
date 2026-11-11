# Detección de buzón: prueba integrada

La APK VOIP VC incorpora captura del audio remoto con Shizuku y reconocimiento
local en español con Vosk. Voice SIP Agent fue usado para comprobar compatibilidad
de audio; no debe tomar las llamadas mientras se prueba el detector de VOIP VC.

## Preparación
- Android 12 o superior, Shizuku iniciado y VOIP VC autorizado en Shizuku.
- VOIP VC como marcador predeterminado.
- Modelo oficial `vosk-model-small-es-0.42` en:
  `Android/data/com.voipvc.bridge/files/models/vosk-model-small-es-0.42/`.
  También admite `files/models/vosk-model-small-es-0.42/` dentro del almacenamiento
  privado de la app; esta ubicación tiene prioridad y se usa en el equipo de prueba.
- En VOIP VC, abrir Configurar detección de buzón y activar.
- El modelo español viene dentro de la APK. Al abrir la app se extrae en
  almacenamiento privado, en un hilo de trabajo, sin internet y sin pulsar
  botones de descarga. Se publica solamente al completar la extracción.
  Si Android cierra el proceso, vuelve a abrir la app para reintentar.
- Gradle obtiene el ZIP oficial al compilar (tarea prepareSpanishModel) y lo
  empaqueta como assets/models/vosk-model-small-es-0.42.zip en debug y release.
  La APK será mayor porque incluye los aproximadamente 39 MB del archivo.
  El celular necesita espacio libre para extraerlo, pero no conexión de red.
- Shizuku debe iniciarse de nuevo tras reiniciar el celular.

## Comportamiento
- Solo analiza llamadas salientes en marcación o activas y una única llamada a la vez.
  La captura durante marcación permite intentar reconocer avisos de red previos a la conexión;
  su disponibilidad depende del equipo y operador.
- Procesa PCM16 mono a 16 kHz del downlink celular, sin guardar grabaciones.
- Reconoce combinaciones de buzón/casilla/correo de voz con instrucciones para
  dejar un mensaje, o instrucciones para dejar mensaje después del tono/señal.
- Modo rápido solicitado: revisa cada bloque de audio y corta con el primer parcial
  que coincida con las primeras cuatro palabras, sin esperar resultado final ni silencio.
  Prefijos: «te has comunicado con», «el número que has», «hola deja tu mensaje»,
  «el número al que», «debe dejar tu mensaje», «hola el número que»,
  «lo sentimos la persona» y «el número que usted», más variantes con «se» y «su».
  Estos prefijos pueden confundir un saludo humano o de central; la categoría es
  inferida por el prefijo, no una comprobación de que el número sea inexistente.
  La latencia depende de cuándo Vosk entregue esas palabras; no garantiza corte
  exactamente al pronunciar la cuarta palabra.
- La ventana de análisis dura hasta 45 segundos después de conectar. Al agotarse,
  deja de analizar pero NO cuelga por tiempo.
- Una coincidencia solicita desconectar exactamente el objeto Call que se analizó.
- El servidor conserva buzon_de_voz, sin_servicio o no_disponible y solo libera el equipo
  después de ended/failed. Se validan contactId y callId.
- Sin permiso, modelo o audio válido, informa error y no solicita el corte.
- Se puede desactivar desde la misma pantalla.

## Validación en el equipo
Prueba real del modo anterior del 2026-11-06 en Android 14 (2409BRN2CL):
El modo rápido de cuatro palabras requiere una nueva validación de voz real.
- 16:56:24: captura VOICE_DOWNLINK abierta a 16 kHz.
- 16:56:35: reconoció «te has comunicado con el buzón de voz ... por favor deja tu mensaje».
- 16:56:35–36: Telecom cerró la llamada y volvió a MODE_NORMAL sin corte manual.
- El fallo previo de identidad «Package android does not belong to 2000» se
  corrigió creando TelecomManager con el contexto shell explícito dentro del
  UserService. Se conserva la comprobación de llamada activa y el control del UID.

Esta prueba manual valida una frase real y el corte, pero no valida todavía
el avance de campaña ni su reporte de extremo a extremo. Falta probar respuesta
humana, silencio, ruido, negaciones, otras locuciones y llamadas concurrentes.
El corte automático sigue siendo experimental hasta completar esas pruebas.
Revisar logs BuzonDetector y BuzonCapture.

## Dependencias
- Shizuku API/provider 13.1.5: https://github.com/RikkaApps/Shizuku-API
- Vosk Android 0.3.75: https://github.com/alphacep/vosk-api
- Modelo español (Apache 2.0):
  https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip
