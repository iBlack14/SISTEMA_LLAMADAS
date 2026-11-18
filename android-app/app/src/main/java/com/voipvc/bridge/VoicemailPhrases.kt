package com.voipvc.bridge

import java.text.Normalizer
import java.util.Locale

/** Matches common Peruvian carrier announcements without treating temporary states as invalid numbers. */
object VoicemailPhrases {
    private val voicemailPrefixes = listOf(
        "te has comunicado con",
        "se ha comunicado con",
        "hola deja tu mensaje",
        "debe dejar tu mensaje",
        "debe dejar su mensaje",
        "lo sentimos la persona"
    )

    private val invalidNumberPatterns = listOf(
        Regex("\\b(el numero (que |al que )?(usted )?(ha |has )?marcado|el numero marcado).{0,48}\\b(no existe|no es valido|no es correcto|es incorrecto|es invalido)\\b"),
        Regex("\\b(numero|abonado|telefono) (marcado )?(inexistente|no existe|incorrecto|invalido)\\b"),
        Regex("\\b(la cantidad de digitos|el numero ingresado).{0,48}\\b(es incorrecta|no es correcta|es invalido|no es valido)\\b"),
        Regex("\\b(no corresponde a un numero|no pertenece a un numero asignado)\\b")
    )

    private val unavailablePatterns = listOf(
        Regex("\\b(el numero|el abonado|el telefono|la persona).{0,60}\\b(apagado|apagada|fuera de servicio|no se encuentra disponible|no esta disponible|no puede recibir llamadas|no responde|no contesta)\\b"),
        Regex("\\b(el equipo|el celular|el telefono).{0,48}\\b(se encuentra apagado|esta apagado|esta fuera del area de cobertura|fuera del area de cobertura)\\b"),
        Regex("\\b(intentelo mas tarde|vuelva a llamar mas tarde|llame mas tarde)\\b")
    )

    private val restrictedPatterns = listOf(
        Regex("\\b(la llamada|su llamada|el destino).{0,48}\\b(no puede ser completada|no puede completarse|no esta permitida|esta restringida|ha sido restringida)\\b"),
        Regex("\\b(este numero|el numero).{0,48}\\b(no recibe llamadas|no acepta llamadas|tiene restriccion de llamadas)\\b")
    )

    fun result(text: String): String? {
        val normalized = Normalizer.normalize(text.lowercase(Locale.ROOT), Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "")
            .replace(Regex("[^a-z0-9 ]"), " ")
            .replace(Regex("\\s+"), " ").trim()
        if (normalized.isBlank()) return null

        // Only clear, explicit non-existence/invalid-number wording is permanent.
        if (invalidNumberPatterns.any { it.containsMatchIn(normalized) }) return "numero_inexistente"
        if (Regex("\\b(sin servicio|fuera de servicio|esta suspendido|suspendida)\\b").containsMatchIn(normalized)) {
            return "sin_servicio"
        }
        if (restrictedPatterns.any { it.containsMatchIn(normalized) }) return "llamada_restringida"
        if (unavailablePatterns.any { it.containsMatchIn(normalized) } ||
            Regex("\\b(el numero|el abonado|el telefono).{0,52}\\b(esta ocupado|se encuentra ocupado|no se encuentra habilitado)\\b")
                .containsMatchIn(normalized)) return "no_disponible"

        // A short, strong operator prefix is enough for fast voicemail cut.
        if (voicemailPrefixes.any { normalized == it || normalized.startsWith("$it ") }) return "buzon_de_voz"
        val mailbox = Regex("\\b(buzon|casilla|cajilla|correo de voz)\\b").containsMatchIn(normalized)
        val leaveMessage = Regex("\\b(deja|deje|dejar|graba|grabe|grabar) (su |tu |un |el )?mensaje\\b")
            .containsMatchIn(normalized)
        val afterTone = Regex("\\b(despues del tono|despues de la senal|al escuchar el tono)\\b")
            .containsMatchIn(normalized)
        if ((mailbox && (leaveMessage || normalized.contains("bienvenido"))) || (leaveMessage && afterTone)) {
            return "buzon_de_voz"
        }
        return null
    }

    fun matches(text: String): Boolean = result(text) != null
}
