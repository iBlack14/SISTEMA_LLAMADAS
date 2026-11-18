package com.voipvc.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class InvalidNumberPhrasesTest {
    @Test fun exactOperatorAnnouncementsArePermanentlyInvalid() {
        val phrases = listOf(
            "El número que ha marcado no existe.",
            "Movistar te informa que el número que usted ha marcado no existe.",
            "Este es un mensaje de Claro: el número que usted ha marcado es incorrecto.",
            "Hola, la cantidad de dígitos que marcaste es incorrecta, volver a llamar."
        )
        phrases.forEach { assertEquals(it, "numero_inexistente", VoicemailPhrases.result(it)) }
    }

    @Test fun incompleteAndTemporaryPromptsDoNotPermanentlyBlockNumbers() {
        listOf(
            "El número que ha marcado",
            "El número que usted ha marcado",
            "El número que ha marcado está sin servicio",
            "El número al que usted ha llamado está apagado",
            "Te has comunicado con el buzón de voz"
        ).forEach { assertNotEquals(it, "numero_inexistente", VoicemailPhrases.result(it)) }
    }

    @Test fun commonPeruvianUnavailableAnnouncementsAreTemporary() {
        val samples = listOf(
            "El número al que usted llama se encuentra apagado o fuera del área de cobertura",
            "El abonado que usted llama no se encuentra disponible, inténtelo más tarde",
            "El teléfono se encuentra fuera de servicio temporalmente",
            "La llamada no puede ser completada, tiene restricción de llamadas"
        )
        samples.forEach { phrase ->
            assertNotEquals("$phrase should not be permanent", "numero_inexistente", VoicemailPhrases.result(phrase))
        }
        assertEquals("no_disponible", VoicemailPhrases.result(samples[0]))
        assertEquals("no_disponible", VoicemailPhrases.result(samples[1]))
        assertEquals("sin_servicio", VoicemailPhrases.result(samples[2]))
        assertEquals("llamada_restringida", VoicemailPhrases.result(samples[3]))
    }

    @Test fun explicitInvalidNumberWordingIsPermanentButAmbiguousWordingIsNot() {
        assertEquals("numero_inexistente", VoicemailPhrases.result("El número marcado no existe"))
        assertEquals("numero_inexistente", VoicemailPhrases.result("El número que usted ha marcado es incorrecto"))
        assertNotEquals("numero_inexistente", VoicemailPhrases.result("El número que usted ha marcado está apagado"))
    }
}
