package com.voipvc.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class BusyToneDetectorTest {
    @Test fun recognizesRepeatedBusyCadenceButNotSingleBeep() {
        val detector = BusyToneDetector(16000)
        val busy = pcm(480, 0.35)
        val silence = pcm(0, 0.25)
        assertFalse(detector.accept(busy + silence, busy.size + silence.size))
        assertTrue(detector.accept(busy + silence + busy, busy.size * 2 + silence.size))
    }

    @Test fun ignoresSpeechBandAndLongContinuousTone() {
        val speech = BusyToneDetector(16000)
        val voice = pcm(240, 0.3)
        repeat(8) { assertFalse(speech.accept(voice, voice.size)) }

        val continuous = BusyToneDetector(16000)
        val tone = pcm(480, 2.0)
        repeat(20) { assertFalse(continuous.accept(tone, tone.size)) }
    }

    private fun pcm(frequency: Int, seconds: Double): ByteArray {
        val count = (16000 * seconds).toInt()
        val bytes = ByteArray(count * 2)
        for (i in 0 until count) {
            val value = if (frequency == 0) 0 else (12000 * sin(2 * PI * frequency * i / 16000)).toInt()
            bytes[i * 2] = value.toByte()
            bytes[i * 2 + 1] = (value shr 8).toByte()
        }
        return bytes
    }
}
