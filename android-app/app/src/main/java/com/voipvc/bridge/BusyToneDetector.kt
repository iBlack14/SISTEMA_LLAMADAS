package com.voipvc.bridge

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/** Detects repeated North American/Peruvian busy cadence from PCM without storing audio. */
internal class BusyToneDetector(private val sampleRate: Int) {
    private val samplesPerWindow = sampleRate / 10 // 100 ms
    private val samples = ShortArray(samplesPerWindow)
    private var filled = 0
    private var toneWindows = 0
    private var silenceWindows = 0
    private var confirmedCycles = 0
    private var cycleHadTone = false
    private var silenceSinceTone = 0

    fun accept(bytes: ByteArray, length: Int): Boolean {
        var index = 0
        while (index + 1 < length) {
            samples[filled++] = (((bytes[index + 1].toInt() shl 8) or
                (bytes[index].toInt() and 0xff))).toShort()
            index += 2
            if (filled == samples.size) {
                val tone = isBusyFrequency(samples)
                if (tone) {
                    toneWindows++
                    silenceWindows = 0
                    cycleHadTone = true
                    silenceSinceTone = 0
                } else {
                    silenceWindows++
                    if (cycleHadTone && silenceWindows >= 2) {
                        val toneDuration = toneWindows
                        // Requiere ráfagas reales de ocupado (300ms a 700ms). Ignora pitidos cortos (100-200ms).
                        if (toneDuration in 3..7) confirmedCycles++ else confirmedCycles = 0
                        cycleHadTone = false
                        toneWindows = 0
                        silenceSinceTone = 1
                    } else if (!cycleHadTone && confirmedCycles > 0) {
                        silenceSinceTone++
                    }
                }
                if (silenceSinceTone > 8) {
                    confirmedCycles = 0
                    silenceSinceTone = 0
                }
                filled = 0
                // Exige al menos 5 ciclos confirmados (~5 segundos de tono repetido continuo) antes de cortar
                if (confirmedCycles >= 5) return true
            }
        }
        return false
    }

    private fun isBusyFrequency(pcm: ShortArray): Boolean {
        val total = goertzelPower(pcm, 480.0) + goertzelPower(pcm, 620.0)
        val energy = pcm.sumOf { it.toDouble() * it }
        if (energy < pcm.size * 180.0 * 180.0) return false
        // Require most signal energy to be close to the busy-tone frequencies.
        return total / (energy * pcm.size) > 0.002
    }

    private fun goertzelPower(pcm: ShortArray, frequency: Double): Double {
        val omega = 2.0 * PI * frequency / sampleRate
        val coefficient = 2.0 * cos(omega)
        var previous = 0.0
        var previous2 = 0.0
        for (sample in pcm) {
            val current = sample.toDouble() + coefficient * previous - previous2
            previous2 = previous
            previous = current
        }
        return previous2 * previous2 + previous * previous - coefficient * previous * previous2
    }
}
