package com.voipvc.bridge

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.*
import android.util.Log
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import rikka.shizuku.Shizuku
import java.io.File
import java.io.InputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

/** Offline speech recognition of the remote cellular downlink; never records PCM to disk. */
object VoicemailDetector {
    private lateinit var app: Context
    private val main = Handler(Looper.getMainLooper())
    private val decoder = Executors.newSingleThreadExecutor { r -> Thread(r, "buzon-recognition") }
    private val generation = AtomicLong()
    @Volatile private var remote: IBinder? = null
    @Volatile private var model: Model? = null
    @Volatile private var input: InputStream? = null
    private var binding = false
    private var initialized = false
    private var args: Shizuku.UserServiceArgs? = null
    @Volatile var status = "Detección de buzón desactivada"
        private set
    @Volatile var lastMatch = ""
        private set

    private fun say(message: String) {
        status = message
        Log.i("BuzonDetector", message)
    }

    @Synchronized fun initialize(context: Context) {
        if (initialized) return
        initialized = true
        app = context.applicationContext
        Shizuku.addBinderReceivedListenerSticky {
            if (enabled()) connect()
        }
        Shizuku.addBinderDeadListener {
            remote = null
            binding = false
            stop()
            say("Shizuku se desconectó; detección no disponible")
        }
        Shizuku.addRequestPermissionResultListener { code, result ->
            if (code == 88) {
                if (result == PackageManager.PERMISSION_GRANTED) {
                    app.getSharedPreferences("voicemail", 0).edit().putBoolean("enabled", true).apply()
                    connect()
                } else say("Acceso denegado. Autoriza VOIP VC en Shizuku → Aplicaciones autorizadas")
            }
        }
        if (enabled()) connect()
    }

    fun enabled(): Boolean = initialized &&
        app.getSharedPreferences("voicemail", 0).getBoolean("enabled", false)

    /** Query live Shizuku state; never remember an OS permission as a preference. */
    fun authorizationIssue(): String? {
        if (Build.VERSION.SDK_INT < 31) return null
        return try {
            when {
                !Shizuku.pingBinder() -> "Inicia Shizuku para poder detectar buzones automáticamente."
                Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED ->
                    "Autoriza VOIP VC en Shizuku para analizar el audio de las llamadas y detectar buzones."
                else -> null
            }
        } catch (_: Exception) { "Abre Shizuku y revisa la autorización de VOIP VC." }
    }

    fun authorizationRequiresManager(): Boolean = try {
        Shizuku.pingBinder() &&
            Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED &&
            Shizuku.shouldShowRequestPermissionRationale()
    } catch (_: Exception) { false }

    fun enable() {
        if (Build.VERSION.SDK_INT < 31) {
            say("La detección requiere Android 12 o superior")
            return
        }
        try {
            if (!Shizuku.pingBinder()) {
                say("Abre e inicia Shizuku; después vuelve a activar la detección")
                return
            }
            if (Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) {
                if (Shizuku.shouldShowRequestPermissionRationale()) {
                    say("Autoriza VOIP VC desde Shizuku → Aplicaciones autorizadas")
                } else Shizuku.requestPermission(88)
                return
            }
            app.getSharedPreferences("voicemail", 0).edit().putBoolean("enabled", true).apply()
            connect()
        } catch (e: Exception) { say("No se pudo autorizar Shizuku: ${e.message}") }
    }

    fun disable() {
        app.getSharedPreferences("voicemail", 0).edit().putBoolean("enabled", false).apply()
        stop()
        val serviceArgs = args
        if (serviceArgs != null) try { Shizuku.unbindUserService(serviceArgs, connection, true) } catch (_: Exception) {}
        remote = null
        binding = false
        say("Detección de buzón desactivada")
    }

    private fun connect() {
        main.post {
            try {
                if (!enabled() || !Shizuku.pingBinder() ||
                    Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) return@post
                if (remote == null && !binding) {
                    binding = true
                    say("Conectando captura de audio con Shizuku…")
                    val serviceArgs = Shizuku.UserServiceArgs(ComponentName(app, DownlinkCaptureService::class.java))
                        .daemon(false).processNameSuffix("buzon").tag("voipvc-downlink")
                        .debuggable(BuildConfig.DEBUG).version(BuildConfig.VERSION_CODE)
                    args = serviceArgs
                    Shizuku.bindUserService(serviceArgs, connection)
                    main.postDelayed({
                        if (binding && remote == null) {
                            binding = false
                            say("Shizuku no conectó. Abre su aplicación y vuelve a activar la detección")
                        }
                    }, 15000)
                }
                decoder.execute { loadModel() }
            } catch (e: Exception) {
                binding = false
                say("Error de Shizuku: ${e.message}")
            }
        }
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            remote = binder
            binding = false
            say(if (model != null) "Detector listo: audio celular y español sin conexión"
                else "Shizuku conectado; preparando modelo de español…")
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            remote = null
            binding = false
            stop()
            say("Captura desconectada; activa nuevamente la detección")
        }
    }

    private fun loadModel(): Model? {
        model?.let { return it }
        val internalFolder = File(app.filesDir, "models/vosk-model-small-es-0.42")
        val folder = if (File(internalFolder, "am/final.mdl").isFile) internalFolder
            else File(app.getExternalFilesDir("models"), "vosk-model-small-es-0.42")
        if (!File(folder, "am/final.mdl").isFile) {
            say("Falta instalar el modelo de español para detectar buzones")
            return null
        }
        return try {
            Model(folder.absolutePath).also {
                model = it
                say(if (remote != null) "Detector listo: audio celular y español sin conexión"
                    else "Modelo español listo; esperando Shizuku")
            }
        } catch (e: Exception) {
            say("Error al abrir modelo español: ${e.message}")
            null
        }
    }

    fun start(onVoicemail: (String, String) -> Unit) {
        stop()
        if (!enabled()) return
        val ticket = generation.get()
        decoder.execute {
            val speechModel = loadModel() ?: return@execute
            val binder = remote
            if (binder == null || !binder.isBinderAlive) {
                say("No se analiza esta llamada: Shizuku no está conectado")
                return@execute
            }
            if (ticket != generation.get()) return@execute
            var recognizer: Recognizer? = null
            try {
                val fd = transactOpen(binder)
                if (ticket != generation.get()) { fd.close(); return@execute }
                ParcelFileDescriptor.AutoCloseInputStream(fd).use { stream ->
                    input = stream
                    recognizer = Recognizer(speechModel, 16000f)
                    val rec = recognizer!!
                    val buffer = ByteArray(3200)
                    val deadline = SystemClock.elapsedRealtime() + 45000
                    say("Escuchando audio remoto para detectar buzón…")
                    while (ticket == generation.get() && SystemClock.elapsedRealtime() < deadline) {
                        val count = stream.read(buffer)
                        if (count <= 0) break
                        val final = rec.acceptWaveForm(buffer, count)
                        val result = JSONObject(if (final) rec.result else rec.partialResult)
                        val text = result.optString(if (final) "text" else "partial").trim()
                        val resultCode = VoicemailPhrases.result(text) ?: continue
                        lastMatch = text.take(160)
                        say("Locución detectada ($resultCode): $lastMatch")
                        main.post {
                            if (ticket == generation.get() && enabled()) onVoicemail(lastMatch, resultCode)
                        }
                        break
                    }
                }
            } catch (e: Exception) {
                if (ticket == generation.get()) say("No se pudo analizar el audio: ${e.message}")
            } finally {
                input = null
                try { recognizer?.close() } catch (_: Exception) {}
                transactStop(binder)
            }
        }
    }

    fun stop() {
        generation.incrementAndGet()
        try { input?.close() } catch (_: Exception) {}
        input = null
        val binder = remote
        if (binder != null) decoder.execute { transactStop(binder) }
    }

    private fun transactOpen(binder: IBinder): ParcelFileDescriptor {
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            data.writeInterfaceToken(DownlinkCaptureService.DESCRIPTOR)
            check(binder.transact(DownlinkCaptureService.OPEN, data, reply, 0)) { "Captura no disponible" }
            reply.readException()
            check(reply.readInt() == 1) { "Shizuku no devolvió audio" }
            ParcelFileDescriptor.CREATOR.createFromParcel(reply)
        } finally { data.recycle(); reply.recycle() }
    }

    private fun transactStop(binder: IBinder) {
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        try {
            data.writeInterfaceToken(DownlinkCaptureService.DESCRIPTOR)
            if (binder.isBinderAlive && binder.transact(DownlinkCaptureService.STOP, data, reply, 0)) reply.readException()
        } catch (_: Exception) {} finally { data.recycle(); reply.recycle() }
    }
}
