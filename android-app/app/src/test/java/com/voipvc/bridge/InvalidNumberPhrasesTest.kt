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
}
