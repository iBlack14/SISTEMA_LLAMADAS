package com.voipvc.bridge

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipInputStream

/** Installs only the official Spanish model, publishing it after extraction completes. */
object VoicemailModelInstaller {
    private const val NAME = "vosk-model-small-es-0.42"
    private const val URL = "https://alphacephei.com/vosk/models/$NAME.zip"
    private val executor = Executors.newSingleThreadExecutor()
    private val running = AtomicBoolean(false)
    val installing: Boolean get() = running.get()
    @Volatile var message = ""
        private set

    private fun valid(folder: File) =
        File(folder, "am/final.mdl").isFile && File(folder, "conf/model.conf").isFile

    fun findModel(context: Context): File? {
        val internal = File(context.filesDir, "models/$NAME")
        if (valid(internal)) return internal
        return context.getExternalFilesDir("models")?.let { File(it, NAME) }?.takeIf(::valid)
    }

    fun install(context: Context) {
        if (!running.compareAndSet(false, true)) return
        val app = context.applicationContext
        message = "Descargando e instalando español… Mantén la app abierta."
        executor.execute {
            val models = File(app.filesDir, "models")
            val staging = File(models, ".install-$NAME")
            try {
                if (findModel(app) != null) {
                    message = ""
                    VoicemailDetector.prepareModel()
                    return@execute
                }
                check(models.isDirectory || models.mkdirs()) { "No se pudo preparar el almacenamiento." }
                check(models.usableSpace > 200L * 1024 * 1024) { "Libera al menos 200 MB y vuelve a intentar." }
                staging.deleteRecursively()
                check(staging.mkdirs()) { "No se pudo preparar la instalación." }
                val client = OkHttpClient.Builder()
                    .connectTimeout(30, TimeUnit.SECONDS)
                    .readTimeout(60, TimeUnit.SECONDS)
                    .callTimeout(10, TimeUnit.MINUTES)
                    .followRedirects(false)
                    .build()
                client.newCall(Request.Builder().url(URL).build()).execute().use { response ->
                    check(response.isSuccessful) { "No se pudo descargar el modelo (HTTP ${response.code})." }
                    val body = response.body ?: error("La descarga está vacía.")
                    check(body.contentLength() <= 100L * 1024 * 1024) { "La descarga excede el tamaño esperado." }
                    ZipInputStream(body.byteStream().buffered()).use { zip ->
                        var total = 0L
                        var entries = 0
                        val buffer = ByteArray(32768)
                        val root = staging.canonicalPath + File.separator
                        while (true) {
                            val entry = zip.nextEntry ?: break
                            check(++entries <= 2000) { "El archivo contiene demasiados elementos." }
                            check(entry.name.startsWith("$NAME/")) { "El archivo no corresponde al modelo español." }
                            val output = File(staging, entry.name)
                            check(output.canonicalPath.startsWith(root)) { "Ruta inválida en la descarga." }
                            if (entry.isDirectory) {
                                check(output.isDirectory || output.mkdirs()) { "No se pudo crear una carpeta." }
                            } else {
                                val parent = output.parentFile!!
                                check(parent.isDirectory || parent.mkdirs()) { "No se pudo crear una carpeta." }
                                output.outputStream().use { target ->
                                    while (true) {
                                        val count = zip.read(buffer)
                                        if (count < 0) break
                                        total += count
                                        check(total <= 250L * 1024 * 1024) { "El modelo excede el tamaño esperado." }
                                        target.write(buffer, 0, count)
                                        message = "Instalando español: ${total / (1024 * 1024)} MB preparados…"
                                    }
                                }
                            }
                            zip.closeEntry()
                        }
                    }
                }
                val extracted = File(staging, NAME)
                check(valid(extracted)) { "La descarga quedó incompleta. Vuelve a intentar." }
                val destination = File(models, NAME)
                if (destination.exists()) check(destination.deleteRecursively()) { "No se pudo reemplazar el modelo incompleto." }
                check(extracted.renameTo(destination)) { "No se pudo finalizar la instalación." }
                message = ""
                VoicemailDetector.prepareModel()
            } catch (e: Exception) {
                message = "No se pudo instalar español. ${e.message ?: "Comprueba tu conexión y vuelve a intentar."}"
            } finally {
                staging.deleteRecursively()
                running.set(false)
            }
        }
    }
}
