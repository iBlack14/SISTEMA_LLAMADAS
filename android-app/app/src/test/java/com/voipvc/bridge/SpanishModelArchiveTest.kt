package com.voipvc.bridge

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class SpanishModelArchiveTest {
    private fun archive(vararg names: String): ByteArray {
        val bytes = ByteArrayOutputStream()
        ZipOutputStream(bytes).use { zip ->
            for (name in names) {
                zip.putNextEntry(ZipEntry(name))
                zip.write("model".toByteArray())
                zip.closeEntry()
            }
        }
        return bytes.toByteArray()
    }
    private fun rejects(bytes: ByteArray, limit: Long = 1024) {
        val folder = Files.createTempDirectory("spanish-invalid").toFile()
        try {
            try {
                SpanishModelArchive.unpack(ByteArrayInputStream(bytes), folder, limit)
                fail("El archivo inválido debe rechazarse")
            } catch (_: IllegalStateException) { }
        } finally { folder.deleteRecursively() }
    }
    @Test fun extractsBundledModelWithoutNetwork() {
        val folder = Files.createTempDirectory("spanish-valid").toFile()
        try {
            val model = SpanishModelArchive.unpack(ByteArrayInputStream(archive(
                SpanishModelArchive.NAME + "/am/final.mdl",
                SpanishModelArchive.NAME + "/conf/model.conf"
            )), folder)
            assertTrue(SpanishModelArchive.valid(model))
            assertEquals("model", model.resolve("conf/model.conf").readText())
        } finally { folder.deleteRecursively() }
    }
    @Test fun rejectsPathsOutsideStaging() {
        rejects(archive(SpanishModelArchive.NAME + "/../../escape"))
    }
    @Test fun rejectsIncompleteModel() {
        rejects(archive(SpanishModelArchive.NAME + "/am/final.mdl"))
    }
    @Test fun rejectsOversizedExtraction() {
        rejects(archive(SpanishModelArchive.NAME + "/am/final.mdl"), 1)
    }
}
