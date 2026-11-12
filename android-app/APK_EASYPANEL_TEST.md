# APK de prueba EasyPanel

Base: e2cd6a9 SERVER; rama local test/easypanel-server.
Servidor: https://llamadas1-v1.tvxk4m.easypanel.host
Variante debug firmada con la clave de pruebas local, versión 1.1-easypanel-test.
HTTP desactivado. Modelo español incluido. No incluye claves ni contraseñas MySQL.

Instala la APK en un teléfono de pruebas. Si la app instalada usa otra firma,
Android rechazará la actualización: usa otro teléfono o conserva tus datos
antes de considerar una desinstalación. No se ha cambiado el applicationId.

Después de desplegar y crear la cuenta del servidor:
1. Abre el panel web e inicia sesión.
2. En el teléfono autoriza los permisos solicitados y el rol de marcador.
3. Genera un QR en el panel y escanéalo para crear una vinculación nueva.
   No reutilices códigos/tokens de XAMPP ni sesiones de otro servidor.
4. Sin iniciar llamadas, comprueba el estado en Núcleo de Red.
5. Prueba apagar/encender Wi-Fi, pasar de Wi-Fi a datos móviles y bloquear
   la pantalla. Comprueba la recuperación del mismo equipo sin duplicados.
6. Para la detección de locuciones, completa la configuración de Shizuku
   que ya ofrece la aplicación.

Conserva el mecanismo existente de reconexión Socket.IO y el servicio en
primer plano. Android y las restricciones de batería del fabricante pueden
afectar el proceso; la estabilidad real requiere estas comprobaciones físicas.
No se ejecutaron llamadas reales como parte de la compilación.

Cambios de estabilidad:
- La URL de la petición de vinculación se construye dentro del manejo de errores.
- Límite de 30 segundos para la petición HTTP completa.
- La respuesta HTTP se cierra con use, incluso si ocurre un error.

Para recompilar, copia .env.example a .env usando el IDE y ejecuta:
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug

Para una release actualizable con la app de producción se necesita su keystore
original y las credenciales indicadas en SIGNING.md. No se creó otra clave release.
