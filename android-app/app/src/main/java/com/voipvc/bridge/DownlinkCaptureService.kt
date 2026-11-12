package com.voipvc.bridge

import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Binder
import android.os.Build
import android.os.Parcel
import android.os.ParcelFileDescriptor
import android.os.Process
import android.telecom.TelecomManager
import android.util.Log
import androidx.annotation.Keep
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Private Shizuku UserService. The ordinary APK never receives a general shell API.
 * Only this APK's UID may request a downlink pipe, and only while a phone call exists.
 */
@Keep
class DownlinkCaptureService @Keep constructor(private val context: Context) : Binder() {
    init {
        Log.i("BuzonCapture", "UserService constructed with Shizuku context")
    }

    @Keep
    constructor() : this(systemContext())

    companion object {
        const val DESCRIPTOR = "com.voipvc.bridge.DownlinkCapture"
        const val OPEN = FIRST_CALL_TRANSACTION
        const val STOP = FIRST_CALL_TRANSACTION + 1
        private const val DESTROY = 16777115

        private fun systemContext(): Context {
            val activityThread = Class.forName("android.app.ActivityThread")
            val systemThread = activityThread.getMethod("systemMain").invoke(null)
            return activityThread.getMethod("getSystemContext").invoke(systemThread) as Context
        }
    }
    private val running = AtomicBoolean(false)
    private var recorder: AudioRecord? = null
    private var output: ParcelFileDescriptor? = null

    private fun enforceOwner() {
        val uid = getCallingUid()
        val ownerUid = try {
            context.packageManager.getApplicationInfo("com.voipvc.bridge", 0).uid
        } catch (_: Exception) {
            throw SecurityException("Could not verify owning APK UID")
        }
        if (uid != ownerUid) {
            throw SecurityException("Only the owning APK may capture call audio (caller=$uid owner=$ownerUid)")
        }
    }

    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        if (code == INTERFACE_TRANSACTION) {
            reply?.writeString(DESCRIPTOR)
            return true
        }
        if (code == DESTROY) {
            if (getCallingUid() !in setOf(0, 2000)) enforceOwner()
            stopCapture()
            reply?.writeNoException()
            Thread { Thread.sleep(100); kotlin.system.exitProcess(0) }.start()
            return true
        }
        data.enforceInterface(DESCRIPTOR)
        enforceOwner()
        return when (code) {
            OPEN -> {
                val identity = clearCallingIdentity()
                try {
                    val fd = openCapture()
                    reply?.writeNoException()
                    reply?.writeInt(1)
                    fd.writeToParcel(reply!!, android.os.Parcelable.PARCELABLE_WRITE_RETURN_VALUE)
                } catch (e: Exception) {
                    Log.e("BuzonCapture", "Failed to open downlink", e)
                    throw e
                } finally { restoreCallingIdentity(identity) }
                true
            }
            STOP -> {
                val identity = clearCallingIdentity()
                try { stopCapture() } finally { restoreCallingIdentity(identity) }
                reply?.writeNoException()
                true
            }
            else -> super.onTransact(code, data, reply, flags)
        }
    }

    @Synchronized
    private fun openCapture(): ParcelFileDescriptor {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            throw IllegalStateException("La captura de buzón requiere Android 12 o superior")
        }
        val shellBase = context.createPackageContext("com.android.shell", 0)
        // Keep the real shell UID/package through application-context substitution.
        val shellContext = object : ContextWrapper(shellBase) {
            override fun getPackageName(): String = "com.android.shell"
            override fun getApplicationContext(): Context = this
            override fun getOpPackageName(): String = "com.android.shell"
            override fun getAttributionSource(): AttributionSource =
                AttributionSource.Builder(Process.myUid()).setPackageName("com.android.shell").build()
        }
        // UserServices run outside an APK process. The cached system manager uses
        // package android; construct one with the actual shell context instead.
        // Fail closed if this platform constructor or call-state query is unavailable.
        val telecom = TelecomManager::class.java.getConstructor(Context::class.java)
            .newInstance(shellContext)
        val inCall = try {
            telecom.isInCall
        } catch (error: SecurityException) {
            throw SecurityException("Android no autorizó consultar la llamada activa", error)
        }
        check(inCall) { "No hay llamada celular activa" }
        stopCapture()
        val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT)
        check(minimum > 0) { "Formato de audio no soportado" }
        val record = try {
            AudioRecord.Builder().setContext(shellContext)
                .setAudioSource(MediaRecorder.AudioSource.VOICE_DOWNLINK)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(16000)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minimum * 2, 6400)).build()
        } catch (error: SecurityException) {
            throw SecurityException("Android no autorizó capturar audio de la llamada", error)
        }
        try {
            check(record.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord no inició" }
            record.startRecording()
            check(record.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Captura bloqueada por Android" }
            val pipe = ParcelFileDescriptor.createPipe()
            recorder = record
            output = pipe[1]
            running.set(true)
            Thread({
                try {
                    ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]).use { stream ->
                        val buffer = ByteArray(640)
                        while (running.get() && recorder === record) {
                            val count = record.read(buffer, 0, buffer.size)
                            check(count > 0) { "Error al leer audio: $count" }
                            stream.write(buffer, 0, count)
                        }
                    }
                } catch (e: Exception) {
                    Log.w("BuzonCapture", "Downlink pipe ended: ${e.javaClass.simpleName}")
                } finally {
                    synchronized(this) { if (recorder === record) stopCapture() }
                }
            }, "buzon-downlink").start()
            Log.i("BuzonCapture", "VOICE_DOWNLINK capture opened at 16000 Hz")
            return pipe[0]
        } catch (e: Exception) {
            record.release()
            throw e
        }
    }

    @Synchronized
    private fun stopCapture() {
        running.set(false)
        try { output?.close() } catch (_: Exception) {}
        output = null
        val record = recorder
        recorder = null
        try { record?.stop() } catch (_: Exception) {}
        try { record?.release() } catch (_: Exception) {}
    }
}
