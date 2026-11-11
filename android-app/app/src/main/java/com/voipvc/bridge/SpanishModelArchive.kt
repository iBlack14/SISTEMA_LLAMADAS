package com.voipvc.bridge

import java.io.File
import java.io.InputStream
import java.util.zip.ZipInputStream

internal object SpanishModelArchive {
    const val NAME = "vosk-model-small-es-0.42"
    fun valid(folder: File) =
        File(folder, "am/final.mdl").isFile && File(folder, "conf/model.conf").isFile

    fun unpack(source: InputStream, staging: File, maxBytes: Long = 250L * 1024 * 1024): File {
        val root = staging.canonicalPath + File.separator
        var total = 0L
        var entries = 0
        ZipInputStream(source.buffered()).use { zip ->
            val buffer = ByteArray(32768)
            while (true) {
                val entry = zip.nextEntry ?: break
                check(++entries <= 2000) { "El modelo contiene demasiados archivos." }
                check(entry.name.startsWith("$NAME/")) { "Archivo de modelo inválido." }
                val output = File(staging, entry.name)
                check(output.canonicalPath.startsWith(root)) { "Ruta de modelo inválida." }
                if (entry.isDirectory) {
                    check(output.isDirectory || output.mkdirs()) { "No se pudo crear una carpeta." }
                } else {
                    val parent = output.parentFile!!
                    check(parent.isDirectory || parent.mkdirs()) { "No se pudo preparar el modelo." }
                    output.outputStream().use { target ->
                        while (true) {
                            val count = zip.read(buffer)
                            if (count < 0) break
                            total += count
                            check(total <= maxBytes) { "El modelo excede el tamaño esperado." }
                            target.write(buffer, 0, count)
                        }
                    }
                }
                zip.closeEntry()
            }
        }
        return File(staging, NAME).also {
            check(valid(it)) { "El modelo incluido está incompleto." }
        }
    }
}
