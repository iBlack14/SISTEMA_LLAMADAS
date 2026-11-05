# Recuperación del proyecto Android

Origen: `C:/Users/via/Downloads/call-main/call-main/android-app`.

Se recuperaron las actividades, manifiesto, recursos y configuración de compilación. El servicio y la configuración anteriores están en `import-backup/`. La carpeta de origen no se modificó.

La carpeta recuperada contiene mejoras respecto al código parcial del repositorio, pero no se ha confirmado que corresponda a una versión publicada concreta.

## Ajustes de integración

- Gradle 8.14 y JDK 17 para el plugin Android 8.5.2 existente.
- El servicio conserva el `callId` del servidor en los estados y en la recuperación del proceso.
- El servidor confirma la recepción de resultados terminales con `phone:status_ack`; se debe desplegar el servidor actualizado junto con esta APK.
- Se restaura el cierre remoto de sesión y se maneja el fallo de inicio del micrófono.
- La configuración de red exige HTTPS; no se importaron excepciones HTTP para dominios públicos.
- La firma de producción requiere un keystore estable; las compilaciones debug no equivalen a una publicación.

## Compilar

Configura JDK 17 como Gradle JDK en Android Studio. Crea `local.properties` con la ruta local del SDK si falta y ejecuta `gradlew.bat :app:assembleDebug`.

El audio de la llamada celular y la detección de buzón requieren validación en un dispositivo real; importar este proyecto no garantiza esas funciones.
