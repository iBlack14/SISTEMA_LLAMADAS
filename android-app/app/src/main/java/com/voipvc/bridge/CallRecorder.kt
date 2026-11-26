package com.voipvc.bridge

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Graba el audio de llamadas contestadas en formato M4A (AAC-LC 16 kHz mono)
 * usando MediaCodec + MediaMuxer y lo sube al servidor al finalizar la llamada.
 */
class CallRecorder(private val context: Context) {

    companion object {
        private const val TAG = "CallRecorder"
        private const val SAMPLE_RATE = 16000
        private const val BIT_RATE = 24000
        private const val CHANNEL_COUNT = 1
        private const val MIME_TYPE = MediaFormat.MIMETYPE_AUDIO_AAC
        // Por debajo de este pico (≈ -42 dBFS) la captura se considera silencio
        // digital: micrófono y downlink no entregaron audio utilizable.
        private const val SILENCE_PEAK_THRESHOLD = 80
    }

    private val recording = AtomicBoolean(false)
    val isRecording: Boolean get() = recording.get()
    private val lock = Any()

    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var trackIndex = -1
    private var muxerStarted = false
    private var presentationTimeUs = 0L
    private var outputFile: File? = null

    /**
     * Segunda pista de la grabación (audio del interlocutor). Llega desde
     * VOICE_DOWNLINK capturado por Shizuku y se mezcla muestra a muestra con
     * el micrófono antes de codificar el AAC.
     */
    private val downlinkLock = Any()
    private val downlinkRing = PcmRing(SAMPLE_RATE * 2 * 2) // 2 s de margen
    private var lastMicLogAt = 0L
    private var lastDownlinkLogAt = 0L
    private var lastCodecDropLogAt = 0L

    private var currentAttemptId = ""
    private val pcmQueue = LinkedBlockingQueue<ByteArray>(250)
    private var encoderThread: Thread? = null
    // Métricas globales de la grabación actual para detectar silencio total.
    private var overallPeak = 0
    private var overallSumSquares = 0.0
    private var overallSamples = 0L
    fun start(attemptId: String) {
        if (attemptId.isBlank()) return
        synchronized(lock) {
            if (recording.get() && currentAttemptId == attemptId) return
            releaseResourcesLocked(deleteFile = true)

            try {
                val dir = File(context.cacheDir, "recordings").apply { mkdirs() }
                val file = File.createTempFile("call-", ".m4a", dir)
                outputFile = file

                val format = MediaFormat.createAudioFormat(MIME_TYPE, SAMPLE_RATE, CHANNEL_COUNT).apply {
                    setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                    setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
                    setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
                }

                val encoder = MediaCodec.createEncoderByType(MIME_TYPE)
                codec = encoder
                encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                encoder.start()

                val mediaMuxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

                codec = encoder
                muxer = mediaMuxer
                trackIndex = -1
                muxerStarted = false
                presentationTimeUs = 0L
                synchronized(downlinkLock) { downlinkRing.clear() }
                pcmQueue.clear()
                outputFile = file
                currentAttemptId = attemptId
                overallPeak = 0
                overallSumSquares = 0.0
                overallSamples = 0L
                recording.set(true)
                encoderThread = Thread({ runEncoderLoop() }, "call-recorder-encoder").apply { start() }
                Log.i(TAG, "Grabación iniciada attempt=$attemptId")
            } catch (e: Exception) {
                Log.e(TAG, "No se pudo iniciar grabación", e)
                releaseResourcesLocked(deleteFile = true)
            }
        }
    }

    fun writePcm(pcmBytes: ByteArray) {
        if (!recording.get() || pcmBytes.isEmpty()) return
        logLevel("mic", pcmBytes)
        if (!pcmQueue.offer(pcmBytes)) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastCodecDropLogAt >= 2000) {
                lastCodecDropLogAt = now
                Log.w(TAG, "Cola de grabación llena; bloque PCM descartado=${pcmBytes.size} bytes")
            }
        }
    }

    private fun runEncoderLoop() {
        while (recording.get() || pcmQueue.isNotEmpty()) {
            val pcmBytes = try {
                if (recording.get()) pcmQueue.poll(50, TimeUnit.MILLISECONDS)
                else pcmQueue.poll()
            } catch (_: InterruptedException) {
                break
            } ?: continue
            encodePcmChunk(pcmBytes)
        }
    }

    private fun encodePcmChunk(pcmBytes: ByteArray) {
        val mixed = mixWithDownlink(pcmBytes)
        trackOverallLevel(mixed)
        synchronized(lock) {
            val encoder = codec ?: return
            try {
                var offset = 0
                var retries = 0
                while (offset < mixed.size) {
                    val inputIndex = encoder.dequeueInputBuffer(20_000)
                    if (inputIndex < 0) {
                        drainEncoderLocked(endOfStream = false)
                        retries += 1
                        if (retries >= 10) {
                            val now = SystemClock.elapsedRealtime()
                            if (now - lastCodecDropLogAt >= 2000) {
                                lastCodecDropLogAt = now
                                Log.w(TAG, "Codificador AAC saturado; PCM pendiente descartado=${mixed.size - offset} bytes")
                            }
                            break
                        }
                        continue
                    }
                    retries = 0
                    val inputBuffer = encoder.getInputBuffer(inputIndex) ?: break
                    inputBuffer.clear()
                    val toWrite = minOf(inputBuffer.remaining(), mixed.size - offset)
                    inputBuffer.put(mixed, offset, toWrite)
                    val samples = toWrite / 2
                    encoder.queueInputBuffer(inputIndex, 0, toWrite, presentationTimeUs, 0)
                    presentationTimeUs += (samples * 1_000_000L) / SAMPLE_RATE
                    offset += toWrite
                }
                drainEncoderLocked(endOfStream = false)
            } catch (e: Exception) {
                Log.w(TAG, "Error codificando PCM: ${e.message}")
            }
        }
    }

    /**
     * Recibe el audio remoto (VOICE_DOWNLINK) que lee VoicemailDetector desde
     * el servicio de Shizuku. Si la grabación no está activa se ignora.
     */
    fun writeDownlinkPcm(pcmBytes: ByteArray) {
        if (!recording.get() || pcmBytes.isEmpty()) return
        logLevel("downlink", pcmBytes)
        synchronized(downlinkLock) {
            if (recording.get()) downlinkRing.write(pcmBytes)
        }
    }

    /**
     * Suma el downlink disponible al bloque del micrófono. Si todavía no hay
     * audio remoto devuelve el micrófono intacto. El downlink es 16 kHz mono
     * PCM16 igual que el micrófono, así que se alinean por muestra.
     */
    private fun mixWithDownlink(mic: ByteArray): ByteArray {
        synchronized(downlinkLock) {
            if (downlinkRing.isEmpty()) return mic
            val remote = ByteArray(mic.size)
            val copied = downlinkRing.readInto(remote)
            if (copied < 2) return mic
            val mixed = mic.copyOf()
            var i = 0
            while (i + 1 < copied) {
                val local = signed16(mixed, i)
                val other = signed16(remote, i)
                val sample = (local + other).coerceIn(-32768, 32767)
                mixed[i] = (sample and 0xFF).toByte()
                mixed[i + 1] = ((sample shr 8) and 0xFF).toByte()
                i += 2
            }
            return mixed
        }
    }

    private fun signed16(buffer: ByteArray, index: Int): Int {
        val raw = (buffer[index].toInt() and 0xFF) or ((buffer[index + 1].toInt() and 0xFF) shl 8)
        return if (raw >= 0x8000) raw - 0x10000 else raw
    }

    /** Deja en logcat el nivel real para distinguir audio de silencio digital. */
    private fun logLevel(source: String, pcm: ByteArray) {
        val now = SystemClock.elapsedRealtime()
        if (source == "mic") {
            if (now - lastMicLogAt < 2000) return
            lastMicLogAt = now
        } else {
            if (now - lastDownlinkLogAt < 2000) return
            lastDownlinkLogAt = now
        }
        var sum = 0.0
        var peak = 0
        var i = 0
        while (i + 1 < pcm.size) {
            val sample = signed16(pcm, i)
            sum += sample.toDouble() * sample
            val magnitude = kotlin.math.abs(sample)
            if (magnitude > peak) peak = magnitude
            i += 2
        }
        val samples = pcm.size / 2
        val rms = if (samples > 0) kotlin.math.sqrt(sum / samples).toInt() else 0
        Log.i(TAG, "nivel audio $source rms=$rms peak=$peak")
    }

    /** Acumula pico y energía de la mezcla para decidir si la grabación es muda. */
    private fun trackOverallLevel(pcm: ByteArray) {
        var i = 0
        while (i + 1 < pcm.size) {
            val sample = signed16(pcm, i)
            val magnitude = kotlin.math.abs(sample)
            if (magnitude > overallPeak) overallPeak = magnitude
            overallSumSquares += sample.toDouble() * sample
            overallSamples += 1
            i += 2
        }
    }

    fun cancel() {
        synchronized(lock) {
            releaseResourcesLocked(deleteFile = true)
        }
    }

    fun stopAndUpload(
        scope: CoroutineScope,
        baseUrl: String,
        sessionCode: String,
        pairingToken: String,
        durationSeconds: Int
    ) {
        val fileToUpload: File?
        val attemptId: String
        var recordedPeak = 0
        var recordedRms = 0

        if (!recording.getAndSet(false)) return
        val worker = encoderThread
        encoderThread = null
        if (worker != null && worker !== Thread.currentThread()) {
            try { worker.join(2000) } catch (_: InterruptedException) {}
        }

        synchronized(lock) {
            try {
                val encoder = codec
                if (encoder != null) {
                    val inputIndex = encoder.dequeueInputBuffer(5000)
                    if (inputIndex >= 0) {
                        encoder.queueInputBuffer(
                            inputIndex, 0, 0, presentationTimeUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM
                        )
                    }
                    drainEncoderLocked(endOfStream = true)
                }
            } catch (e: Exception) {
                Log.w(TAG, "Error cerrando encoder: ${e.message}")
            }
            fileToUpload = outputFile
            attemptId = currentAttemptId
            recordedPeak = overallPeak
            recordedRms = if (overallSamples > 0)
                kotlin.math.sqrt(overallSumSquares / overallSamples).toInt() else 0
            releaseResourcesLocked(deleteFile = false)
        }

        if (fileToUpload == null || !fileToUpload.exists() || fileToUpload.length() < 512 ||
            baseUrl.isBlank() || sessionCode.isBlank() || attemptId.isBlank()
        ) {
            fileToUpload?.delete()
            return
        }

        // Solo se conservan llamadas de 30 s o más; las cortas se descartan.
        if (durationSeconds < 30) {
            Log.i(TAG, "GRABACIÓN DESCARTADA por duración attempt=$attemptId dur=${durationSeconds}s (<30s)")
            fileToUpload.delete()
            return
        }

        // Si la captura completa fue silencio digital, no se sube un archivo mudo.
        if (recordedPeak < SILENCE_PEAK_THRESHOLD) {
            Log.w(TAG, "GRABACIÓN MUDA attempt=$attemptId peak=$recordedPeak rms=$recordedRms descartada; revisar fuente de audio/Shizuku en el equipo")
            fileToUpload.delete()
            return
        }

        scope.launch(Dispatchers.IO) {
            try {
                val delays = longArrayOf(0, 1000, 3000, 8000, 16000)
                for (waitMs in delays) {
                    delay(waitMs)
                    val code = uploadFile(fileToUpload, baseUrl, sessionCode, pairingToken, attemptId, durationSeconds)
                    if (code in 200..299 || (code != 0 && code != 409 && code != 429 && code < 500)) break
                }
            } finally {
                fileToUpload.delete()
            }
        }
    }

    private fun drainEncoderLocked(endOfStream: Boolean) {
        val encoder = codec ?: return
        val mediaMuxer = muxer ?: return
        val bufferInfo = MediaCodec.BufferInfo()
        val timeoutUs = if (endOfStream) 5000L else 0L

        val deadline = SystemClock.elapsedRealtime() + 200
        while (!endOfStream || SystemClock.elapsedRealtime() < deadline) {
            val outputIndex = encoder.dequeueOutputBuffer(bufferInfo, timeoutUs)
            when {
                outputIndex == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                    if (!endOfStream) break
                }
                outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    if (!muxerStarted) {
                        trackIndex = mediaMuxer.addTrack(encoder.outputFormat)
                        mediaMuxer.start()
                        muxerStarted = true
                    }
                }
                outputIndex >= 0 -> {
                    val encodedData: ByteBuffer? = encoder.getOutputBuffer(outputIndex)
                    if (encodedData != null && bufferInfo.size > 0 &&
                        (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 &&
                        muxerStarted && trackIndex >= 0
                    ) {
                        encodedData.position(bufferInfo.offset)
                        encodedData.limit(bufferInfo.offset + bufferInfo.size)
                        mediaMuxer.writeSampleData(trackIndex, encodedData, bufferInfo)
                    }
                    encoder.releaseOutputBuffer(outputIndex, false)
                    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) break
                }
            }
        }
    }

    private fun releaseResourcesLocked(deleteFile: Boolean) {
        recording.set(false)
        pcmQueue.clear()
        encoderThread?.let { if (it !== Thread.currentThread()) it.interrupt() }
        encoderThread = null
        synchronized(downlinkLock) { downlinkRing.clear() }
        try { codec?.stop() } catch (_: Exception) {}
        try { codec?.release() } catch (_: Exception) {}
        try { if (muxerStarted) muxer?.stop() } catch (_: Exception) {}
        try { muxer?.release() } catch (_: Exception) {}
        codec = null
        muxer = null
        trackIndex = -1
        muxerStarted = false
        if (deleteFile) {
            outputFile?.delete()
        }
        outputFile = null
        currentAttemptId = ""
    }

    private fun uploadFile(
        file: File,
        baseUrl: String,
        sessionCode: String,
        pairingToken: String,
        attemptId: String,
        durationSeconds: Int
    ): Int {
        var connection: HttpURLConnection? = null
        try {
            val cleanBase = baseUrl.trimEnd('/')
            val encodedAttempt = URLEncoder.encode(attemptId, "UTF-8")
            val targetUrl = "$cleanBase/api/session/$sessionCode/recordings/$encodedAttempt"

            val conn = (URL(targetUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                instanceFollowRedirects = false
                doOutput = true
                connectTimeout = 15000
                readTimeout = 30000
                setRequestProperty("Content-Type", "audio/mp4")
                setRequestProperty("X-Pairing-Token", pairingToken)
                setRequestProperty("X-Duration-Seconds", durationSeconds.toString())
                setFixedLengthStreamingMode(file.length())
            }
            connection = conn

            file.inputStream().use { input ->
                conn.outputStream.use { output ->
                    input.copyTo(output)
                }
            }

            val code = conn.responseCode
            if (code in 200..299) {
                Log.i(TAG, "Grabación subida OK attempt=$attemptId bytes=${file.length()}")
            } else {
                Log.w(TAG, "Error subiendo grabación HTTP $code attempt=$attemptId")
            }
            return code
        } catch (e: Exception) {
            Log.w(TAG, "Fallo subiendo grabación: ${e.javaClass.simpleName}")
            return 0
        } finally {
            connection?.disconnect()
        }
    }

    /** Buffer circular de bytes PCM16 con descarte de lo más antiguo si desborda. */
    private class PcmRing(private val capacity: Int) {
        private val data = ByteArray(capacity)
        private var readPos = 0
        private var writePos = 0
        private var count = 0

        fun isEmpty(): Boolean = count == 0

        fun clear() {
            readPos = 0
            writePos = 0
            count = 0
        }

        fun write(source: ByteArray) {
            val length = minOf(source.size, capacity)
            for (i in 0 until length) {
                data[writePos] = source[i]
                writePos = (writePos + 1) % capacity
            }
            if (count + length <= capacity) {
                count += length
            } else {
                val overflow = count + length - capacity
                readPos = (readPos + overflow) % capacity
                count = capacity
            }
        }

        fun readInto(target: ByteArray): Int {
            val length = minOf(count, target.size)
            for (i in 0 until length) {
                target[i] = data[readPos]
                readPos = (readPos + 1) % capacity
            }
            count -= length
            return length
        }
    }
}
