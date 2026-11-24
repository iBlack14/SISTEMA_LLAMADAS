package com.voipvc.bridge

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.nio.ByteBuffer
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
    }

    private val recording = AtomicBoolean(false)
    private val lock = Any()

    private var codec: MediaCodec? = null
    private var muxer: MediaMuxer? = null
    private var trackIndex = -1
    private var muxerStarted = false
    private var presentationTimeUs = 0L
    private var outputFile: File? = null

    private var currentAttemptId = ""
    private var currentContactId = ""
    private var currentPhone = ""

    fun start(attemptId: String, contactId: String, phone: String) {
        if (attemptId.isBlank()) return
        synchronized(lock) {
            if (recording.get() && currentAttemptId == attemptId) return
            releaseResourcesLocked(deleteFile = true)

            try {
                val dir = File(context.cacheDir, "recordings").apply { mkdirs() }
                val file = File(dir, "${attemptId.replace(Regex("[^a-zA-Z0-9_-]"), "_")}.m4a")

                val format = MediaFormat.createAudioFormat(MIME_TYPE, SAMPLE_RATE, CHANNEL_COUNT).apply {
                    setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                    setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
                    setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
                }

                val encoder = MediaCodec.createEncoderByType(MIME_TYPE)
                encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                encoder.start()

                val mediaMuxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

                codec = encoder
                muxer = mediaMuxer
                trackIndex = -1
                muxerStarted = false
                presentationTimeUs = 0L
                outputFile = file
                currentAttemptId = attemptId
                currentContactId = contactId
                currentPhone = phone
                recording.set(true)
                Log.i(TAG, "Grabación iniciada attempt=$attemptId")
            } catch (e: Exception) {
                Log.e(TAG, "No se pudo iniciar grabación", e)
                releaseResourcesLocked(deleteFile = true)
            }
        }
    }

    fun writePcm(pcmBytes: ByteArray) {
        if (!recording.get() || pcmBytes.isEmpty()) return
        synchronized(lock) {
            val encoder = codec ?: return
            if (!recording.get()) return
            try {
                var offset = 0
                while (offset < pcmBytes.size) {
                    val inputIndex = encoder.dequeueInputBuffer(0)
                    if (inputIndex < 0) break
                    val inputBuffer = encoder.getInputBuffer(inputIndex) ?: break
                    inputBuffer.clear()
                    val toWrite = minOf(inputBuffer.remaining(), pcmBytes.size - offset)
                    inputBuffer.put(pcmBytes, offset, toWrite)
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
        val contactId: String
        val phone: String

        synchronized(lock) {
            if (!recording.getAndSet(false)) return
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
            contactId = currentContactId
            phone = currentPhone
            releaseResourcesLocked(deleteFile = false)
        }

        if (fileToUpload == null || !fileToUpload.exists() || fileToUpload.length() < 512 ||
            baseUrl.isBlank() || sessionCode.isBlank() || attemptId.isBlank()
        ) {
            fileToUpload?.delete()
            return
        }

        scope.launch(Dispatchers.IO) {
            uploadFile(fileToUpload, baseUrl, sessionCode, pairingToken, attemptId, contactId, phone, durationSeconds)
        }
    }

    private fun drainEncoderLocked(endOfStream: Boolean) {
        val encoder = codec ?: return
        val mediaMuxer = muxer ?: return
        val bufferInfo = MediaCodec.BufferInfo()
        val timeoutUs = if (endOfStream) 5000L else 0L

        while (true) {
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
        currentContactId = ""
        currentPhone = ""
    }

    private fun uploadFile(
        file: File,
        baseUrl: String,
        sessionCode: String,
        pairingToken: String,
        attemptId: String,
        contactId: String,
        phone: String,
        durationSeconds: Int
    ) {
        try {
            val cleanBase = baseUrl.trimEnd('/')
            val encodedAttempt = URLEncoder.encode(attemptId, "UTF-8")
            val encodedContact = URLEncoder.encode(contactId, "UTF-8")
            val encodedPhone = URLEncoder.encode(phone, "UTF-8")
            val targetUrl = "$cleanBase/api/session/$sessionCode/recordings/$encodedAttempt" +
                "?contactId=$encodedContact&phone=$encodedPhone&durationSeconds=$durationSeconds"

            val conn = (URL(targetUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 15000
                readTimeout = 30000
                setRequestProperty("Content-Type", "audio/mp4")
                setRequestProperty("X-Pairing-Token", pairingToken)
                setFixedLengthStreamingMode(file.length())
            }

            file.inputStream().use { input ->
                conn.outputStream.use { output ->
                    input.copyTo(output)
                }
            }

            val code = conn.responseCode
            conn.disconnect()
            if (code in 200..299) {
                Log.i(TAG, "Grabación subida OK attempt=$attemptId bytes=${file.length()}")
            } else {
                Log.w(TAG, "Error subiendo grabación HTTP $code attempt=$attemptId")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Fallo subiendo grabación attempt=$attemptId: ${e.message}")
        } finally {
            file.delete()
        }
    }
}
