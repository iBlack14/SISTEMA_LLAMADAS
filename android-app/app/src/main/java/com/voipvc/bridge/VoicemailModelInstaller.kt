package com.voipvc.bridge

import android.content.Context
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Extracts the Spanish model included in the APK; never downloads at runtime. */
object VoicemailModelInstaller {
    private const val NAME = SpanishModelArchive.NAME
    private val executor = Executors.newSingleThreadExecutor()
    private val running = AtomicBoolean(false)
    val installing: Boolean get() = running.get()
    @Volatile var message = ""
        private set

    fun findModel(context: Context): File? {
        val internal = File(context.filesDir, "models/$NAME")
        if (SpanishModelArchive.valid(internal)) return internal
        return context.getExternalFilesDir("models")?.let { File(it, NAME) }?.takeIf(SpanishModelArchive::valid)
    }

    fun install(context: Context) {
        if (findModel(context) != null || !running.compareAndSet(false, true)) return
        val app = context.applicationContext
        message = "Preparando español incluido en la APK… No necesitas internet."
        executor.execute {
            val models = File(app.filesDir, "models")
            val staging = File(models, ".install-$NAME")
            try {
                check(models.isDirectory || models.mkdirs()) { "No se pudo preparar el almacenamiento." }
                check(models.usableSpace > 200L * 1024 * 1024) { "Libera al menos 200 MB y vuelve a abrir la app." }
                staging.deleteRecursively()
                check(staging.mkdirs()) { "No se pudo preparar la instalación." }
                val extracted = app.assets.open("models/$NAME.zip").use { SpanishModelArchive.unpack(it, staging) }
                val destination = File(models, NAME)
                if (destination.exists()) check(destination.deleteRecursively()) { "No se pudo reemplazar el modelo incompleto." }
                check(extracted.renameTo(destination)) { "No se pudo finalizar la instalación." }
                message = ""
                VoicemailDetector.prepareModel()
            } catch (e: Exception) {
                message = "No se pudo preparar el español incluido. ${e.message ?: "Vuelve a abrir la app para reintentar."}"
            } finally {
                try { staging.deleteRecursively() } finally { running.set(false) }
            }
        }
    }
}
