package com.voipvc.bridge

import java.text.Normalizer
import java.util.Locale

/** Aggressive, user-requested matching of the first four words of operator prompts. */
object VoicemailPhrases {
    private val prefixes = listOf(
        "te has comunicado con" to "buzon_de_voz",
        "se ha comunicado con" to "buzon_de_voz",
        "hola deja tu mensaje" to "buzon_de_voz",
        "el numero al que" to "no_disponible",
        "debe dejar tu mensaje" to "buzon_de_voz",
        "debe dejar su mensaje" to "buzon_de_voz",
        "lo sentimos la persona" to "no_disponible",
        "el numero esta suspendido" to "sin_servicio"
    )

    fun result(text: String): String? {
        val normalized = Normalizer.normalize(text.lowercase(Locale.ROOT), Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "").replace(Regex("[^a-z0-9 ]"), " ")
            .replace(Regex("\\s+"), " ").trim()
        // Wait for the distinguishing words before permanently rejecting a number.
        val invalidNumber = Regex("\\b(el numero (que |al que )?(usted )?(ha |has )?marcado (no existe|es incorrecto)|el numero (no existe|es incorrecto)|la cantidad de digitos que marcaste es incorrecta)\\b")
            .containsMatchIn(normalized)
        if (invalidNumber) return "numero_inexistente"
        if (Regex("\\b(sin servicio|fuera de servicio|esta suspendido)\\b").containsMatchIn(normalized))
            return "sin_servicio"
        // Match complete words at the start, never a substring in ordinary speech.
        prefixes.firstOrNull { (prefix, _) ->
            normalized == prefix || normalized.startsWith("${prefix} ")
        }?.let { return it.second }
        val mailbox = Regex("\\b(buzon|casilla|cajilla|correo) de voz\\b").containsMatchIn(normalized)
        val leaveMessage = Regex("\\b(deja|deje|dejar|graba|grabe|grabar) (su |tu |un |el )?mensaje\\b")
            .containsMatchIn(normalized)
        val tone = normalized.contains("despues del tono") || normalized.contains("despues de la senal")
        return if ((mailbox && (leaveMessage || normalized.contains("bienvenido"))) ||
            (leaveMessage && tone)) "buzon_de_voz" else null
    }

    fun matches(text: String): Boolean = result(text) != null
}
