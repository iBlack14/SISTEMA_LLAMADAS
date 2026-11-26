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
    /** True while waiting for onServiceConnected after bindUserService. */
    val isConnecting: Boolean get() = binding && remote == null
    /** True once the Shizuku UserService is bound and alive. */
    val isConnected: Boolean get() = remote?.isBinderAlive == true

    fun dashboardState(): String = when {
        !enabled() || !shizukuAuthorized() -> "disabled"
        !isConnected || model == null -> "preparing"
        else -> "ready"
    }

    /**
     * Consumidor opcional del PCM del interlocutor que se está leyendo para el
     * reconocimiento. Lo usa CallRecorder para incluir la voz remota en la
     * grabación. No se persiste nada aquí: solo se reenvían los bytes.
     */
    @Volatile var downlinkSink: ((ByteArray) -> Unit)? = null

    /** La grabación pidió el downlink y hay que mantenerlo aunque no se detecte buzón. */
    @Volatile private var captureRequested = false
    @Volatile private var captureOnlyQueued = false

    private fun shizukuAuthorized(): Boolean = try {
        initialized && Shizuku.pingBinder() &&
            Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    } catch (_: Exception) {
        false
    }

    private fun say(message: String) {
        status = message
        Log.i("BuzonDetector", message)
    }

    @Synchronized fun initialize(context: Context) {
        if (initialized) return
        initialized = true
        app = context.applicationContext
        VoicemailModelInstaller.install(app)
        Shizuku.addBinderReceivedListenerSticky {
            if (enabled() || captureRequested) connect()
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
        if (enabled() || captureRequested) connect()
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
        args = null
        say("Detección de buzón desactivada")
    }

    /** Force-unbind the current UserService and reconnect from scratch. */
    fun reconnect() {
        stop()
        val serviceArgs = args
        if (serviceArgs != null) {
            try { Shizuku.unbindUserService(serviceArgs, connection, true) } catch (_: Exception) {}
        }
        remote = null
        binding = false
        args = null
        say("Reiniciando conexión con Shizuku…")
        if (enabled()) {
            main.postDelayed({ connect() }, 800)
        }
    }

    private fun connect() {
        main.post {
            try {
                if ((!enabled() && !captureRequested) || !Shizuku.pingBinder() ||
                    Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) return@post
                if (remote == null && !binding) {
                    binding = true
                    say("Conectando captura de audio con Shizuku…")
                    val serviceArgs = Shizuku.UserServiceArgs(
                        ComponentName(BuildConfig.APPLICATION_ID, DownlinkCaptureService::class.java.name)
                    )
                        .daemon(false).processNameSuffix("buzon").tag("voipvc-downlink-v2")
                        .debuggable(BuildConfig.DEBUG).version(BuildConfig.VERSION_CODE)
                    args = serviceArgs
                    Log.i("BuzonDetector", "Binding UserService component=${DownlinkCaptureService::class.java.name} Shizuku=${Shizuku.getVersion()} uid=${Shizuku.getUid()} version=${BuildConfig.VERSION_CODE}")
                    Shizuku.bindUserService(serviceArgs, connection)
                    main.postDelayed({
                        if (binding && remote == null) {
                            binding = false
                            val runningVersion = try {
                                Shizuku.peekUserService(serviceArgs, connection)
                            } catch (e: Exception) {
                                Log.e("BuzonDetector", "Could not inspect timed-out UserService", e)
                                -2
                            }
                            Log.e("BuzonDetector", "UserService bind timed out; peek version=$runningVersion")
                            say("Shizuku no inició el servicio de audio (API ${Shizuku.getVersion()}, servicio $runningVersion). Reinicia Shizuku y reintenta.")
                        }
                    }, 8000)
                }
                if (enabled()) decoder.execute { loadModel() }
            } catch (e: Exception) {
                binding = false
                Log.e("BuzonDetector", "Could not bind Shizuku UserService", e)
                say("Error de Shizuku: ${e.message}")
            }
        }
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            Log.i("BuzonDetector", "Shizuku UserService callback: connected name=$name binder=${binder?.javaClass?.name} alive=${binder?.isBinderAlive}")
            remote = binder
            binding = false
            if (binder == null || !binder.isBinderAlive) {
                say("Shizuku respondió sin un binder activo; reinicia la conexión")
            } else {
                say(if (model != null) "Detector listo: audio celular y español sin conexión"
                    else "Shizuku conectado; preparando modelo de español…")
                if (captureRequested) startRecordingCapture()
            }
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            Log.w("BuzonDetector", "Shizuku UserService disconnected: $name")
            remote = null
            binding = false
            stop()
            say("Captura desconectada; activa nuevamente la detección")
        }
        override fun onBindingDied(name: ComponentName?) {
            Log.e("BuzonDetector", "Shizuku UserService binding died: $name")
            remote = null
            binding = false
            say("Shizuku cerró el servicio de audio; reinicia la conexión")
        }
        override fun onNullBinding(name: ComponentName?) {
            Log.e("BuzonDetector", "Shizuku UserService returned a null binder: $name")
            remote = null
            binding = false
            say("El servicio de audio devolvió una conexión vacía")
        }
    }

    fun prepareModel() {
        if (initialized) decoder.execute { loadModel() }
    }

    private fun loadModel(): Model? {
        model?.let { return it }
        val folder = VoicemailModelInstaller.findModel(app)
        if (folder == null) {
            say("Preparando el modelo español incluido en la APK…")
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
            val voskQueue = java.util.concurrent.ArrayBlockingQueue<ByteArray>(64)
            @Volatile var recognizing = true
            var voskThread: Thread? = null
            try {
                val fd = transactOpen(binder)
                if (ticket != generation.get()) { fd.close(); return@execute }
                ParcelFileDescriptor.AutoCloseInputStream(fd).use { stream ->
                    input = stream
                    recognizer = Recognizer(speechModel, 16000f)
                    val rec = recognizer!!
                    val buffer = ByteArray(1600)
                    val deadline = SystemClock.elapsedRealtime() + 90000
                    val toneDetector = BusyToneDetector(16000)
                    say("Escuchando audio remoto para detectar buzón…")
                    voskThread = Thread({
                        try {
                            while (ticket == generation.get() && recognizing) {
                                val chunk = voskQueue.poll(150, java.util.concurrent.TimeUnit.MILLISECONDS) ?: continue
                                if (SystemClock.elapsedRealtime() >= deadline) {
                                    recognizing = false
                                    break
                                }
                                if (toneDetector.accept(chunk, chunk.size)) {
                                    lastMatch = "Tono de ocupado repetido"
                                    say("Tono de ocupado repetido detectado; solicitando corte")
                                    recognizing = false
                                    main.post {
                                        if (ticket == generation.get() && enabled()) onVoicemail(lastMatch, "tono_ocupado")
                                    }
                                    break
                                }
                                val final = rec.acceptWaveForm(chunk, chunk.size)
                                val result = JSONObject(if (final) rec.result else rec.partialResult)
                                val text = result.optString(if (final) "text" else "partial").trim()
                                val resultCode = VoicemailPhrases.result(text) ?: continue
                                lastMatch = text.take(160)
                                say("Locución detectada ($resultCode): $lastMatch")
                                recognizing = false
                                main.post {
                                    if (ticket == generation.get() && enabled()) onVoicemail(lastMatch, resultCode)
                                }
                                break
                            }
                        } catch (_: InterruptedException) {
                        } catch (e: Exception) {
                            Log.w("BuzonDetector", "Vosk worker error: ${e.message}")
                        }
                    }, "buzon-vosk").apply { start() }

                    try { Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO) } catch (_: Exception) {}
                    while (ticket == generation.get()) {
                        val count = stream.read(buffer)
                        if (count <= 0) break
                        val copy = buffer.copyOf(count)
                        // La lectura del downlink alimenta primero la grabación sin bloquearse en Vosk.
                        if (captureRequested) downlinkSink?.invoke(copy)
                        if (recognizing && SystemClock.elapsedRealtime() >= deadline) {
                            recognizing = false
                        }
                        if (recognizing) {
                            voskQueue.offer(copy)
                        } else if (!captureRequested) {
                            break
                        }
                    }
                }
            } catch (e: Exception) {
                if (ticket == generation.get()) say("No se pudo analizar el audio: ${e.message}")
            } finally {
                recognizing = false
                voskThread?.interrupt()
                try { voskThread?.join(300) } catch (_: Exception) {}
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

    /**
     * Mantiene abierto el downlink de Shizuku para que CallRecorder reciba la
     * voz del interlocutor. No ejecuta reconocimiento; si ya hay una sesión de
     * detección de buzón activa, esa misma sesión reenvía el PCM.
     */
    fun startRecordingCapture() {
        captureRequested = true
        if (!initialized || downlinkSink == null) return
        if (!shizukuAuthorized()) return
        if (remote == null) {
            if (!binding) connect()
            main.postDelayed({ if (captureRequested && remote == null) startRecordingCapture() }, 1500)
            return
        }
        if (input != null || captureOnlyQueued) return // el detector ya está reenviando audio
        captureOnlyQueued = true
        decoder.execute { runCaptureOnly() }
    }

    fun stopRecordingCapture() {
        captureRequested = false
        stop()
    }

    private fun runCaptureOnly() {
        val binder = remote
        if (binder == null) { captureOnlyQueued = false; return }
        if (input != null) { captureOnlyQueued = false; return }
        val ticket = generation.get()
        try {
            val fd = transactOpen(binder)
            ParcelFileDescriptor.AutoCloseInputStream(fd).use { stream ->
                input = stream
                val buffer = ByteArray(1600)
                Log.i("BuzonDetector", "Downlink de grabación abierto")
                while (ticket == generation.get() && captureRequested && binder.isBinderAlive) {
                    val count = stream.read(buffer)
                    if (count <= 0) break
                    downlinkSink?.invoke(buffer.copyOf(count))
                }
            }
        } catch (e: Exception) {
            if (ticket == generation.get()) say("No se pudo grabar el audio remoto: ${e.message}")
        } finally {
            captureOnlyQueued = false
            input = null
            transactStop(binder)
        }
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
