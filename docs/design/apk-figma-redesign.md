# ViaVox Android: revisión y preparación del rediseño en Figma

Fecha: 16 de noviembre de 2026.

Estado: revisión del código y preparación del diseño. El conector de Figma respondió `UNAUTHORIZED: Reauthentication required`; aún no se ha creado ningún archivo, pantalla ni prototipo en Figma. No se modificó la implementación Android para este trabajo.

## Objetivo acordado

Rediseñar todas las superficies de la APK primero en Figma, con capas editables y un prototipo navegable mediante Play. La implementación en Android se hará después de revisar el diseño. El prototipo simulará acciones y estados: no realizará llamadas ni conexiones reales.

## Inventario de la implementación

La revisión se hizo sobre los archivos del repositorio, no sobre una APK ejecutándose en un dispositivo.

| Superficie | Fuente | Contenido actual |
| --- | --- | --- |
| Principal | `android-app/app/src/main/res/layout/activity_main.xml`, `MainActivity.kt` | Vinculación QR/manual; permisos; equipo/sesión; conexión; llamada compacta; micrófono; altavoz; contacto para mensajes; bloqueo; reconexión; revinculación; ajustes; cierre de sesión. |
| Escáner personalizado | `activity_qr_capture.xml`, `QrCaptureActivity.kt` | Cámara, instrucciones, enfoque y linterna. |
| Llamada a pantalla completa | `activity_incoming_call.xml`, `IncomingCallActivity.kt` | Imagen del contacto, nombre, número, estado, duración, responder/rechazar/colgar, micrófono, altavoz, mensaje, bloqueo y cotización. |
| Detección de buzón | `VoicemailSetupActivity.kt` | Activar/desactivar, autorización, conexión Shizuku, preparación del modelo español, última locución, errores, volver. La UI se crea en Kotlin. |
| Diálogos | `MainActivity.kt` | Aviso de autorización de buzón y confirmación de cierre de sesión. |
| Notificaciones | `BridgeService.kt` | Servicio persistente y aviso de llamada. |
| Superficies de Android/Shizuku | Manifest, `MainActivity.kt`, `VoicemailSetupActivity.kt` | Permisos de telefonía, micrófono, notificaciones, cámara; aplicación de teléfono predeterminada; autorización y apertura de Shizuku. |

No se encontraron archivos Code Connect ni anotaciones `FigmaConnect` en Android. La fuente actual es Android `sans` y componentes Material; no hay una fuente personalizada incluida.

## Hallazgos que afectan al diseño

1. La pantalla principal concentra configuración y operación en un mismo scroll. Propuesta: mantener una portada de operación con equipo, estado y llamada; llevar la configuración técnica a Ajustes. Es una propuesta de navegación, todavía sin implementar.
2. Hay tres nombres para la misma app: VOIP VC, Phone-VC y ViaVox. El diseño utilizará ViaVox y explicará «equipo conectado» en lugar de «bridge» en el uso diario.
3. Los permisos aparecen como abreviaturas Mic/Notif/Dialer. Se usarán nombres completos, estado y acción de recuperación.
4. La llamada tiene una presentación compacta y otra completa. Ambas necesitan el mismo vocabulario y estados coherentes; la vista completa conservará la prioridad de responder y colgar.
5. `Mensaje` añade el contacto al panel web; no abre un editor ni envía un SMS. La etiqueta propuesta es «Enviar a mensajes» y el feedback debe aclarar el destino.
6. `Cotización` solicita abrir el formulario en el panel web. No existe un formulario de reservas nativo. El prototipo debe mostrar «Continuar cotización en el panel web», sin simular un guardado local inexistente.
7. El botón Cotización está en la actividad de llamada completa y no en la tarjeta compacta de `MainActivity`. Cualquier unificación se documentará como propuesta.
8. Bloquear durante la llamada también solicita colgar. Se debe explicar esta consecuencia. Una confirmación previa sería una mejora propuesta, no comportamiento actual.
9. El bloqueo se guarda localmente aunque no haya conexión; no debe mostrarse como sincronizado hasta que corresponda.
10. La sesión guardada se restaura automáticamente. Conectando, conectado y sin servidor necesitan variantes distintas; «vinculado» no equivale a conexión activa.
11. Hay un escáner personalizado declarado, pero `launchScanner()` no llama a `setCaptureActivity(QrCaptureActivity::class.java)`. Antes de implementar su nuevo diseño habrá que comprobar la ruta efectiva; el prototipo representa la experiencia propuesta.
12. Los permisos y diálogos de Android y Shizuku son superficies externas. Se representarán como referencias de transición, diferenciadas de las pantallas diseñadas para la app.
13. La detección de buzón exige Android 12 o superior y autorización Shizuku, aunque la app admite Android 7 o superior. La incompatibilidad afectará solo a esta función.
14. La pantalla completa se cierra al recibir `ended` o `idle`. Una confirmación de fin de llamada deberá regresar a la portada; no se añadirá un formulario de resultados inexistente.
15. Algunos errores de vinculación muestran HTTP o mensajes técnicos. Se propondrán mensajes accionables y un detalle técnico secundario.

## Dirección visual propuesta

- Marca: morado ViaVox `#79258E`, con morado profundo `#350642` en zonas de identidad.
- Superficies: blanco `#FFFFFF`, fondo suave `#F5F1F8`, bordes `#E8DFEC` y texto principal `#35233F`.
- Semántica: verde para conexión/contestar, ámbar para espera/atención y rojo para colgar/error. Cada estado tendrá texto e icono, además de color.
- Tipografía: conservar la familiaridad de Android con Roboto, verificando sus estilos disponibles al entrar en Figma. Títulos de 24–28, cuerpo de 16, ayudas de 13–14; duración grande y con cifras legibles.
- Formato base: 390 × 844, con adaptación de referencia a 360 y 412 de ancho. Márgenes de 24, espaciado sobre una cuadrícula de 8 y objetivos táctiles de al menos 48.
- Diseño: portada tranquila y clara para operación; llamada completa con identidad morada y controles amplios; escáner oscuro para separar la cámara de las instrucciones.
- Formularios: etiquetas persistentes, errores junto al campo y token oculto con control de visibilidad. Todos los ejemplos serán sintéticos.
- Componentes: reutilizar primero una biblioteca Android/Material disponible en Figma. Buscar biblioteca y variables antes de construir. Si no hay recursos adecuados, crear una base local coherente y editable.
- Evitar una barra de pestañas con funciones inexistentes. Las rutas de llamadas se mostrarán como escenarios de prueba; no como un botón de producción que origine llamadas.

## Estructura prevista del archivo de Figma

1. Portada y mapa de cobertura: punto de entrada y explicación breve de los escenarios.
2. Vinculación y permisos: frames de alta, QR, manual y recuperación.
3. Equipo y ajustes: estado operativo, sesión, conexión y configuración.
4. Llamadas: estados, controles y feedback de acciones.
5. Detección de buzón: activación, autorización, disponibilidad y fallos.
6. Referencias del sistema: permisos Android, selector de teléfono y Shizuku.
7. Fundamentos y componentes, si la biblioteca seleccionada no cubre la marca.

Cada pantalla tendrá un nombre identificable y capas editables. Los contenedores relacionados usarán auto-layout. Los botones del recorrido tendrán interacciones y las rutas de salida o cancelación regresarán a un punto válido.

## Frames y estados de la app que se deben cubrir

| ID | Pantalla o variante | Contenido y salida principal |
| --- | --- | --- |
| V01 | Vincular equipo | Explicación breve; Escanear QR; Vincular manualmente; Preparar permisos. |
| V02 | Preparar permisos | Telefonía, micrófono, notificaciones y marcador con estado y explicación. |
| V03 | Permisos pendientes | Motivo, permisos necesarios y opción Revisar permisos; sin marcar el equipo como listo. |
| V04 | Escanear QR | Encuadre, instrucciones, volver, enfocar y linterna. |
| V05 | Escáner con linterna | Control activo y opción Apagar luz. |
| V06 | QR no válido | Explicación y Reintentar / Vincular manualmente. |
| V07 | Vinculación manual | Servidor, código y token; mostrar/ocultar token; Vincular equipo. |
| V08 | Validación de datos | Campos incompletos o incorrectos y corrección en contexto. |
| V09 | Vinculando | Indicador de progreso, acción no duplicable y explicación. |
| V10 | Fallo de vinculación | Problema de red o sesión, Reintentar / Editar datos. |
| E01 | Equipo conectado | Dispositivo, sesión, estado, permisos y espera de órdenes del panel. |
| E02 | Conectando | Sesión guardada y conexión aún pendiente. |
| E03 | Sin conexión | Estado persistente, reintento y acceso a ajustes. |
| E04 | Atención requerida | Permiso faltante o marcador sin configurar, con acción dirigida. |
| E05 | Ajustes de conexión | Servidor, código y token; Guardar y reconectar; cancelar. |
| E06 | Guardando y reconectando | Progreso y retorno a estado conectado o error. |
| E07 | Revincular | Explicación y vuelta a QR/manual. |
| E08 | Cerrar sesión | Confirmación: se detendrá el servicio; cancelar o cerrar. |
| L01 | Marcando | Contacto, número y estado; colgar y controles aplicables. |
| L02 | Llamada entrante | Nombre, número, Responder y Rechazar claramente separados. |
| L03 | Llamada en curso | Duración, micrófono, altavoz, mensaje, cotización, bloqueo y colgar. |
| L04 | Controles activados | Micrófono silenciado y altavoz activo, con etiquetas que expliquen la acción inversa. |
| L05 | Contacto sin imagen/nombre | Fallback legible usando número e inicial o icono; mismo acceso a controles. |
| L06 | Fin de llamada | Estado transitorio y regreso al equipo conectado; sin formulario añadido. |
| L07 | Contacto enviado a mensajes | Feedback de envío al panel web; vuelta a la llamada. |
| L08 | Cotización solicitada | Feedback de continuar en el panel web; vuelta a la llamada. |
| L09 | Acción sin conexión | Aviso de que no se envió al panel; posibilidad de volver a intentar. |
| L10 | Bloquear contacto | Explicar bloqueo y finalización de llamada; confirmar/cancelar como propuesta de mejora. |
| L11 | Números bloqueados | Lista legible y desbloqueo en contexto; distinguir estado local de sincronización. |
| L12 | Sin bloqueados | Estado vacío claro, sin contenido inventado. |
| B01 | Buzón desactivado | Qué hace la función y requisitos; Autorizar y activar. |
| B02 | Preparando español | Progreso del modelo incluido en la APK; sin pedir una descarga externa. |
| B03 | Autorizar con Shizuku | Pasos para abrir/iniciar y autorizar; referencia al flujo externo. |
| B04 | Conectando detección | Progreso y botón de reconexión desactivado para evitar duplicados. |
| B05 | Detección activa | Conexión y disponibilidad reales; última locución si existe; Desactivar. |
| B06 | Detección desactivada | Confirmación y opción de volver a activar. |
| B07 | Error de Shizuku | No instalado, no iniciado, denegado o desconectado; recuperación correspondiente. |
| B08 | Equipo incompatible | Android anterior a 12: explicar que la detección no está disponible y permitir volver. |
| B09 | Recordatorio de autorización | Configurar y autorizar / Ahora no. |
| N01 | Notificaciones | Referencia del servicio y llamada; entrada hacia equipo o llamada. |

Los estados combinables se podrán organizar como variantes de componentes o frames hermanos. No debe confundirse este inventario de 40 superficies/estados con 40 actividades nativas.

## Referencias externas necesarias

- Permisos de telefonía y estado del teléfono.
- Permiso de micrófono.
- Permiso de notificaciones en Android 13 o superior.
- Permiso de cámara, incluyendo denegación y salida manual.
- Selección de ViaVox como app de teléfono predeterminada.
- Autorización Shizuku y caso previamente denegado.
- Apertura de la app Shizuku y retorno a ViaVox.

Son simulaciones para entender el recorrido. Su apariencia final depende del sistema y no se implementará como si fueran diálogos propios de ViaVox.

## Recorridos para Play

| Inicio | Recorrido principal | Alternativa o recuperación |
| --- | --- | --- |
| Vincular por QR | V01 → V02 → referencias de permisos → V04 → V09 → E02 → E01 | Cámara denegada → V07; QR inválido → V06 → V04; red → V10. |
| Vincular manualmente | V01 → V07 → V09 → E02 → E01 | Datos incompletos → V08 → V07. |
| Probar llamada | L02 → L03 → L04 → L06 → E01 | Rechazar → E01; marcando L01 → L03; contacto desconocido L05. |
| Acciones durante llamada | L03 → L07/L08 → L03 | Sin conexión → L09; bloqueo → L10 → L06; cancelar → L03. |
| Revisar conexión | E01 → E05 → E06 → E01 | E03 → E02 → E01; E04 → V02; E07 → V04; E08 → V01. |
| Activar detección | B01 → B02 → B03 → referencia Shizuku → B04 → B05 | B07 → B03; B08 → E01; desactivar B05 → B06. |

Los saltos entre eventos de red o telefonía serán simulaciones de escenario. Se usarán botones reales donde existan y transiciones controladas para eventos externos, sin añadir controles ficticios a la interfaz final.

## Comprobaciones antes de entregar el prototipo

- Completar la autenticación del conector, resolver el plan y crear un archivo Design.
- Inspeccionar bibliotecas disponibles y seleccionar los recursos Android adecuados.
- Confirmar fuentes y crear/importar los componentes necesarios.
- Construir y revisar por grupos, manteniendo IDs de los frames para conectar el prototipo.
- Confirmar texto editable, jerarquía y uso de auto-layout; no importar pantallas completas como imágenes.
- Revisar capturas de pantallas representativas y corregir desbordamientos, contraste y tamaños.
- Verificar que todos los enlaces de los recorridos tengan destino y que se pueda volver o cancelar.
- Configurar puntos de inicio y compartir enlace del archivo y del prototipo con Play.
- Mantener el estado «pendiente de revisión» para Android; no modificar ni compilar la APK como parte de esta fase.
