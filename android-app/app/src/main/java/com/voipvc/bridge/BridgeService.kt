@file:Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")

package com.voipvc.bridge

import android.Manifest
import android.annotation.SuppressLint
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.media.*
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.*
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import io.socket.client.IO
import io.socket.client.Ack
import io.socket.client.Socket
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel

/**
 * Always-on foreground service.
 * • Connects to the VOIP VC server via Socket.IO
 * • Monitors call state with PhoneStateListener  (no root)
 * • Streams MIC audio to dashboard              (AudioRecord, no root)
 * • Plays dashboard audio during calls          (AudioTrack VOICE_COMMUNICATION, no root)
 * • Survives swipe-kill via AlarmManager restart
 * • Auto-starts on boot via BootReceiver
 */
class BridgeService : Service() {

    private data class DialResult(val ok: Boolean, val message: String)

    // ── CONSTANTS ─────────────────────────────────────────────────────────────
    companion object {
        private const val TAG = "BridgeService"

        const val CHANNEL_ID      = "phone_vc_channel"
        const val NOTIFICATION_ID = 9201

        // Sample rate accepted by both AudioRecord on Android and AudioContext on web
        const val SAMPLE_RATE  = 16000
        const val CHUNK_FRAMES = 1280  // 80 ms @ 16 kHz  → 2560 bytes

        // Intent actions
        const val ACTION_START  = "com.voipvc.bridge.START"
        const val ACTION_STOP   = "com.voipvc.bridge.STOP"
        const val ACTION_LOGOUT = "com.voipvc.bridge.LOGOUT"
        const val ACTION_UI_HANGUP = "com.voipvc.bridge.UI_HANGUP"
        const val ACTION_UI_ANSWER = "com.voipvc.bridge.UI_ANSWER"
        const val ACTION_UI_TOGGLE_MUTE = "com.voipvc.bridge.UI_TOGGLE_MUTE"
        const val ACTION_UI_TOGGLE_SPEAKER = "com.voipvc.bridge.UI_TOGGLE_SPEAKER"
        const val ACTION_UI_BLOCKLIST_CHANGE = "com.voipvc.bridge.UI_BLOCKLIST_CHANGE"
        const val ACTION_UI_SAVE_MESSAGE_CONTACT = "com.voipvc.bridge.UI_SAVE_MESSAGE_CONTACT"
        const val ACTION_UI_QUOTE_REQUEST = "com.voipvc.bridge.UI_QUOTE_REQUEST"
        const val ACTION_UI_SYNC = "com.voipvc.bridge.UI_SYNC"

        // Extras
        const val EXTRA_SOCKET_URL  = "socket_url"
        const val EXTRA_CODE        = "code"
        const val EXTRA_TOKEN       = "token"
        const val EXTRA_DEVICE_ID   = "device_id"
        const val EXTRA_DEVICE_NAME = "device_name"
        const val EXTRA_PHONE_NUMBER = "phone_number"
        const val EXTRA_COMPANY_NAME = "company_name"
        const val EXTRA_CONTACT_NAME = "contact_name"
        const val EXTRA_IMAGE_URL = "image_url"
        const val EXTRA_BLOCKLIST_ACTION = "blocklist_action"
        const val EXTRA_BLOCKLIST_JSON = "blocklist_json"

        // SharedPreferences
        const val PREFS_NAME       = "voip vc_prefs"
        const val PREF_SOCKET_URL  = "socket_url"
        const val PREF_CODE        = "code"
        const val PREF_TOKEN       = "token"
        const val PREF_DEVICE_ID   = "device_id"
        const val PREF_DEVICE_NAME = "device_name"
        const val PREF_ACTIVE_COMMAND_ID = "active_command_id"
        const val PREF_ACTIVE_CONTACT_ID = "active_contact_id"
        const val PREF_CAMPAIGN_PHONE = "campaign_phone"
        const val PREF_CAMPAIGN_CALL_STATE = "campaign_call_state"
        const val PREF_CAMPAIGN_STATE_OBSERVED = "campaign_state_observed"

        // Status broadcast
        const val ACTION_STATUS        = "com.voipvc.bridge.STATUS"
        const val EXTRA_STATUS_MESSAGE = "status_msg"
        const val ACTION_CALL_UI_STATE = "com.voipvc.bridge.CALL_UI_STATE"
        const val ACTION_BLOCKLIST_STATE = "com.voipvc.bridge.BLOCKLIST_STATE"
        const val ACTION_CLOSE_CALL_UI = "com.voipvc.bridge.CLOSE_CALL_UI"
        const val ACTION_TELECOM_CALL_STATE = "com.voipvc.bridge.TELECOM_CALL_STATE"
        const val EXTRA_CALL_STATE = "call_state"
        const val EXTRA_CALL_DIRECTION = "call_direction"
        const val EXTRA_MIC_MUTED = "mic_muted"
        const val EXTRA_SPEAKER_ON = "speaker_on"
    }

    // ── STATE ─────────────────────────────────────────────────────────────────
    private var socket: Socket? = null
    private var connectionKey = ""

    // Audio
    private var audioRecord : AudioRecord? = null
    private var audioTrack  : AudioTrack?  = null
    private val isStreaming  = AtomicBoolean(false)
    private val isPlaying    = AtomicBoolean(false)
    private var captureJob: Job? = null
    private var playbackJob: Job? = null
    private val audioPlaybackQueue = Channel<ByteArray>(
        capacity = 50,  // Jitter buffer: ~4s at 80ms/chunk (was 4)
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
    // Backpressure for capture: channel to decouple AudioRecord read from socket emit
    private val audioCaptureQueue = Channel<ByteArray>(
        capacity = 20,  // ~1.6s buffer
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    // App-level heartbeat (10s) - faster than Socket.IO ping (30s) for mobile
    private var heartbeatJob: Job? = null
    private val HEARTBEAT_INTERVAL_MS = 10_000L
    private val HEARTBEAT_TIMEOUT_MS = 5_000L

    // Buffer pool for audio chunks to reduce GC pressure
    private val audioBufferPool = Channel<ByteArray>(
        capacity = 30,  // Pool size: 30 buffers
        onBufferOverflow = BufferOverflow.DROP_OLDEST
    )
    private val CHUNK_BYTES = CHUNK_FRAMES * 2
    // Pre-fill pool
    init {
        repeat(30) { audioBufferPool.trySend(ByteArray(CHUNK_BYTES)) }
    }

    private val minBufIn  by lazy { AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,  AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(CHUNK_FRAMES * 2) }
    private val minBufOut by lazy { AudioTrack.getMinBufferSize(SAMPLE_RATE,  AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(CHUNK_FRAMES * 2) }

    // Call monitoring
    @Suppress("DEPRECATION")
    private var phoneStateListener: PhoneStateListener? = null
    private var lastCallState = "idle"
    private var activeDialStartedAtElapsedMs = 0L
    private var currentPhoneNumber = ""
    private var currentCompanyName = ""
    private var currentContactName = ""
    private var currentImageUrl = ""
    private var isMicMuted = false
    private var isSpeakerOn = false
    private val mainHandler = Handler(Looper.getMainLooper())
    @Volatile private var dialAttemptToken = 0
    @Volatile private var currentPairingToken = ""
    private var detectedVoicemail = false
    private var detectedAnnouncement = ""
    private var activeCallId = ""
    private var activeCommandId = ""
    private var activeContactId = ""
    private var campaignPhoneNumber = ""
    private var callAnsweredAtElapsedMs = 0L
    private val callRecorder by lazy { CallRecorder(applicationContext) }
    private var campaignStateObserved = false
    private var campaignTrackingRestored = false
    private var hangupVerificationToken = 0
    private var currentCallDirection = "unknown"
    private var lastTelecomEventAt = 0L
    private var statusSequence = 0L
    private val statusSessionId = UUID.randomUUID().toString()
    private var lastEmittedStatusSignature = ""
    private var lastBlockedNumbersJson = ""
    private var lastDialCommandId = ""
    private var lastDialAck = DialResult(false, "")
    private var wakeLock: PowerManager.WakeLock? = null
    private var connectivityManager: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val telecomStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION_TELECOM_CALL_STATE) return
            val st = intent.getStringExtra(EXTRA_CALL_STATE)?.trim().orEmpty()
            if (st.isBlank()) return
            val incomingNumber = intent.getStringExtra(EXTRA_PHONE_NUMBER).orEmpty().trim()
            val incomingName = intent.getStringExtra(EXTRA_CONTACT_NAME).orEmpty().trim()
            val direction = intent.getStringExtra(EXTRA_CALL_DIRECTION).orEmpty().ifBlank { "unknown" }
            if (intent.hasExtra(EXTRA_SPEAKER_ON)) {
                isSpeakerOn = intent.getBooleanExtra(EXTRA_SPEAKER_ON, false)
            }
            val announcement = intent.getStringExtra("detected_announcement").orEmpty()
                .ifBlank { if (intent.getBooleanExtra("detected_voicemail", false)) "buzon_de_voz" else "" }
            if (announcement in setOf("buzon_de_voz", "sin_servicio", "no_disponible", "numero_inexistente") &&
                activeCommandId.isNotBlank() && numbersMatch(campaignPhoneNumber, incomingNumber)) {
                detectedAnnouncement = announcement
                detectedVoicemail = announcement == "buzon_de_voz"
                persistCampaignTracking()
                setStatus("Locución detectada ($announcement): corte solicitado")
            }
            lastTelecomEventAt = SystemClock.elapsedRealtime()
            handleObservedCallState(st, incomingNumber, incomingName, direction, "telecom")
        }
    }

    // ── LIFECYCLE ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        restoreCampaignTracking()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Phone-VC iniciando…"))
        registerCallMonitor()
        val filter = IntentFilter(ACTION_TELECOM_CALL_STATE)
        ContextCompat.registerReceiver(
            this,
            telecomStateReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )

        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as? PowerManager
            wakeLock = powerManager?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VoipVcBridge::ServiceWakeLock")?.apply {
                setReferenceCounted(false)
                acquire(2 * 60 * 60 * 1000L) // 2h safe window
            }
        } catch (e: Exception) {
            Log.w(TAG, "No se pudo obtener WakeLock: ${e.message}")
        }

        try {
            connectivityManager = getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    mainHandler.post {
                        if (socket?.connected() != true && connectionKey.isNotBlank()) {
                            Log.d(TAG, "Red detectada/restaurada. Reconectando socket inmediatamente…")
                            socket?.connect()
                        }
                    }
                }
            }
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            networkCallback?.let { connectivityManager?.registerNetworkCallback(request, it) }
        } catch (e: Exception) {
            Log.w(TAG, "No se pudo registrar NetworkCallback: ${e.message}")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val url     = intent.getStringExtra(EXTRA_SOCKET_URL)  ?: ""
                val code    = intent.getStringExtra(EXTRA_CODE)        ?: ""
                val token   = intent.getStringExtra(EXTRA_TOKEN)       ?: ""
                val devId   = intent.getStringExtra(EXTRA_DEVICE_ID)   ?: ""
                val devName = intent.getStringExtra(EXTRA_DEVICE_NAME) ?: ""
                tryConnect(url, code, token, devId, devName)
            }
            ACTION_STOP -> stopSelf()
            ACTION_LOGOUT -> logoutAndStop()
            ACTION_UI_HANGUP -> hangup()
            ACTION_UI_ANSWER -> answerIncomingCall()
            ACTION_UI_TOGGLE_MUTE -> setMicMute(!isMicMuted)
            ACTION_UI_TOGGLE_SPEAKER -> setSpeakerOn(!isSpeakerOn)
            ACTION_UI_BLOCKLIST_CHANGE -> sendBlockedNumberChange(intent)
            ACTION_UI_SAVE_MESSAGE_CONTACT -> sendMessageContactToWeb(intent)
            ACTION_UI_QUOTE_REQUEST -> sendQuoteRequestToWeb(intent)
            ACTION_UI_SYNC -> {
                emitCallUiState()
                emitPhoneStatus(lastCallState, "ui_sync", correlateCampaign = activeCommandId.isNotBlank())
            }
            null -> buildRestartIntentFromPrefs()?.let { restart ->
                tryConnect(
                    restart.getStringExtra(EXTRA_SOCKET_URL).orEmpty(),
                    restart.getStringExtra(EXTRA_CODE).orEmpty(),
                    restart.getStringExtra(EXTRA_TOKEN).orEmpty(),
                    restart.getStringExtra(EXTRA_DEVICE_ID).orEmpty(),
                    restart.getStringExtra(EXTRA_DEVICE_NAME).orEmpty()
                )
            }
        }
        return START_STICKY  // Android will restart this service if killed
    }

    /** The foreground service normally survives task removal; START_STICKY is
     * responsible for process recovery without creating a second socket. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
        stopAudio()
        unregisterCallMonitor()
        unregisterReceiver(telecomStateReceiver)
        try {
            networkCallback?.let { connectivityManager?.unregisterNetworkCallback(it) }
        } catch (_: Exception) {}
        networkCallback = null
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {}
        wakeLock = null
        socket?.disconnect()
        socket?.off()
        socket = null
        connectionKey = ""
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── SOCKET CONNECTION ─────────────────────────────────────────────────────

    private fun tryConnect(url: String, code: String, token: String, devId: String, devName: String) {
        if (url.isBlank() || code.isBlank() || token.isBlank() || devId.isBlank()) {
            setStatus("⚠️ Datos incompletos")
            return
        }

        val requestedConnectionKey = listOf(url.trim(), code.trim(), token.trim(), devId.trim()).joinToString("|")
        if (requestedConnectionKey == connectionKey && socket != null) {
            if (socket?.connected() != true) socket?.connect()
            emitCallUiState()
            setStatus(if (socket?.connected() == true) "✅ Activo — esperando llamadas" else "🔄 Reconectando…")
            return
        }
        connectionKey = requestedConnectionKey
        currentPairingToken = token.trim()

        socket?.disconnect()
        socket?.off()

        val client: Socket
        try {
            val options = IO.Options().apply {
                transports = arrayOf("websocket", "polling")
                reconnection = true
                reconnectionAttempts = Int.MAX_VALUE
                reconnectionDelay = 1_000L
                reconnectionDelayMax = 5_000L
                timeout = 15_000L
                forceNew = true
            }
            client = IO.socket(url, options)
            socket = client
        } catch (e: Exception) {
            setStatus("URL inválida: ${e.message}")
            return
        }

        client.on(Socket.EVENT_CONNECT) {
            if (client !== socket) return@on
            Log.i(TAG, "[SOCKET] connected; joining phone session=${code.takeLast(2)} device=${devId.takeLast(6)}")
            try {
                if (wakeLock?.isHeld == false) wakeLock?.acquire(2 * 60 * 60 * 1000L)
            } catch (_: Exception) {}
            val payload = JSONObject()
                .put("code", code).put("role", "phone")
                .put("protocolVersion", 2)
                .put("token", currentPairingToken)
                .put("deviceId", devId).put("deviceName", devName)
            client.emit("session:join", payload)
        }

        client.on("session:joined") { args ->
            if (client !== socket) return@on
            val rotatedToken = (args.firstOrNull() as? JSONObject)?.optString("token").orEmpty()
            Log.i(TAG, "[SOCKET] joined phone session=${code.takeLast(2)} device=${devId.takeLast(6)}")
            mainHandler.post {
                if (client !== socket) return@post
                if (rotatedToken.isNotBlank()) currentPairingToken = rotatedToken
                setStatus("✅ Activo — esperando llamadas")
                // Save credentials for reboot auto-start
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
                    .putString(PREF_SOCKET_URL, url) .putString(PREF_CODE, code)
                    .putString(PREF_TOKEN, currentPairingToken)    .putString(PREF_DEVICE_ID, devId)
                    .putString(PREF_DEVICE_NAME, devName).apply()
                // Re-announce the actual local call after a network micro-cut so
                // the server can resume the same command during its grace window.
                emitPhoneStatus(lastCallState, "reconnect", correlateCampaign = activeCommandId.isNotBlank())
                if (campaignTrackingRestored) {
                    campaignTrackingRestored = false
                    mainHandler.postDelayed({
                        if (
                            activeCommandId.isNotBlank() &&
                            lastCallState in setOf("dialing", "ringing", "in_call") &&
                            !isActuallyInCall()
                        ) {
                            handleObservedCallState(
                                "failed",
                                campaignPhoneNumber,
                                "",
                                "outgoing",
                                "process_recovery"
                            )
                        }
                    }, 3_000L)
                }
            }
        }

        client.on("session:error") { args ->
            if (client !== socket) return@on
            val msg = (args.firstOrNull() as? JSONObject)?.optString("message") ?: "Error de sesión"
            mainHandler.post { setStatus("❌ $msg") }
        }

        // App-level heartbeat: send ping every 10s, expect pong within 5s
        client.on("app:heartbeat_pong") { args ->
            if (client !== socket) return@on
            // Heartbeat acknowledged, connection is alive
        }
        // Start heartbeat after successful join
        startHeartbeat(client)

        // Keep APK UI in sync with the authoritative session state from server.
        client.on("state:changed") { args ->
            if (client !== socket) return@on
            val data = args.firstOrNull() as? JSONObject ?: return@on
            val blockedNumbers = data.optJSONArray("blockedNumbers")
            if (blockedNumbers != null) {
                val blockedJson = blockedNumbers.toString()
                if (blockedJson != lastBlockedNumbersJson) {
                    lastBlockedNumbersJson = blockedJson
                    val entries = BlockedNumberStore.fromJsonArray(blockedNumbers)
                    mainHandler.post {
                        if (client !== socket) return@post
                        BlockedNumberStore.replace(this@BridgeService, entries)
                        sendBroadcast(
                            Intent(ACTION_BLOCKLIST_STATE)
                                .setPackage(packageName)
                                .putExtra(EXTRA_BLOCKLIST_JSON, BlockedNumberStore.toJsonArray(entries).toString())
                        )
                    }
                }
            }
            val workers = data.optJSONArray("phoneWorkers") ?: return@on
            var ownWorker: JSONObject? = null
            for (index in 0 until workers.length()) {
                val candidate = workers.optJSONObject(index) ?: continue
                if (candidate.optString("id") == devId) {
                    ownWorker = candidate
                    break
                }
            }
            val workerState = ownWorker ?: return@on
            // Android/Telecom is authoritative for the physical call state.
            // Server echoes are useful only to restore missing display data;
            // feeding them back into lastCallState caused state oscillations.
            mainHandler.post {
                if (client !== socket) return@post
                if (currentPhoneNumber.isBlank() && !isActuallyInCall()) {
                    currentPhoneNumber = workerState.optString("currentNumber")
                }
            }
        }

        client.on("session:force_logout") {
            if (client === socket) mainHandler.post { logoutAndStop() }
        }

        client.on("phone:reconnect_request") {
            if (client === socket) {
                mainHandler.post {
                    emitPhoneStatus(lastCallState, "reconnect", correlateCampaign = activeCommandId.isNotBlank())
                }
            }
        }

        client.on("session:reconnect_request") {
            if (client === socket) {
                mainHandler.post {
                    emitPhoneStatus(lastCallState, "reconnect", correlateCampaign = activeCommandId.isNotBlank())
                }
            }
        }

        client.on("blocked-numbers:error") { args ->
            val message = (args.firstOrNull() as? JSONObject)?.optString("message").orEmpty()
            if (message.isNotBlank()) mainHandler.post { setStatus("No se pudo sincronizar la lista: $message") }
        }

        client.on("phone:status_ack") { args ->
            if (client !== socket) return@on
            val data = args.firstOrNull() as? JSONObject ?: return@on
            mainHandler.post {
                if (client !== socket) return@post
                val commandId = data.optString("commandId")
                val contactId = data.optString("contactId")
                if (
                    data.optBoolean("accepted") &&
                    data.optBoolean("terminal") &&
                    commandId == activeCommandId &&
                    contactId == activeContactId
                ) {
                    clearCampaignTracking()
                }
            }
        }

        client.on("phone:message-contact:ack") { args ->
            if (client !== socket) return@on
            val data = args.firstOrNull() as? JSONObject ?: return@on
            val message = data.optString("message").ifBlank {
                if (data.optBoolean("ok")) "Contacto guardado en la web." else "No se pudo guardar el contacto."
            }
            mainHandler.post { setStatus(message) }
        }

        client.on("call:action") { args ->
            if (client !== socket) return@on
            val data = args.firstOrNull() as? JSONObject ?: return@on
            val serverAck = args.lastOrNull() as? Ack
            val receivedAtElapsedMs = SystemClock.elapsedRealtime()
            mainHandler.post {
              if (client !== socket) {
                  serverAck?.call(JSONObject().put("ok", false).put("message", "socket_replaced"))
                  return@post
              }
              val commandId = data.optString("commandId")
              val action = data.optString("action")
              val callId = data.optString("callId")
              Log.i(TAG, "[CALL_ACTION] received action=$action command=${commandId.takeLast(8)} call=${callId.takeLast(8)} mainQueueMs=${SystemClock.elapsedRealtime() - receivedAtElapsedMs}")
              when (action) {
                "dial"   -> {
                    val phoneNumber = data.optString("phoneNumber")
                    val companyName = data.optString("companyName")
                    val contactName = data.optString("contactName")
                    val imageUrl = data.optString("imageUrl")
                    val contactId = data.optString("contactId")
                    val result = if (commandId.isNotBlank() && commandId == activeCommandId && callId == activeCallId) {
                        val physicallyActive = isActuallyInCall()
                        Log.w(TAG, "[DIAL] orden repetida; no se vuelve a marcar command=${commandId.takeLast(8)} call=${callId.takeLast(8)} physicalCall=$physicallyActive")
                        if (physicallyActive) {
                            emitPhoneStatus(lastCallState.ifBlank { "dialing" }, "command_duplicate", correlateCampaign = true)
                            DialResult(true, "La llamada de esta orden ya está activa")
                        } else {
                            DialResult(false, "La orden ya existe, pero Android no confirma una llamada activa; requiere revisar el teléfono")
                        }
                    } else if (commandId.isNotBlank() && commandId == lastDialCommandId) {
                        Log.w(TAG, "[DIAL] duplicate command ignored command=${commandId.takeLast(8)}")
                        lastDialAck
                    } else {
                        dialNumber(
                            phoneNumber,
                            companyName,
                            contactName,
                            imageUrl,
                            commandId,
                            contactId,
                            callId,
                            receivedAtElapsedMs
                        ).also {
                            lastDialCommandId = commandId
                            lastDialAck = it
                        }
                    }
                    emitCommandAck(commandId, "dial", result.ok, result.message, serverAck)
                }
                "hangup" -> {
                    val requestedContactId = data.optString("contactId")
                    val matchesActiveCall = requestedContactId.isBlank() ||
                        activeContactId.isBlank() ||
                        requestedContactId == activeContactId
                    val ok = matchesActiveCall && hangup()
                    emitCommandAck(
                        commandId,
                        "hangup",
                        ok,
                        when {
                            !matchesActiveCall -> "La orden pertenece a otra llamada"
                            ok -> "Corte solicitado; esperando confirmación física"
                            else -> "Android no pudo solicitar el corte"
                        },
                        serverAck
                    )
                }
                "answer" -> {
                    emitCommandAck(commandId, "answer", answerIncomingCall(), "Respuesta procesada", serverAck)
                }
                "mute"   -> emitCommandAck(commandId, "mute", setMicMute(true), "Micrófono procesado", serverAck)
                "unmute" -> emitCommandAck(commandId, "unmute", setMicMute(false), "Micrófono procesado", serverAck)
                "speaker_on" -> emitCommandAck(commandId, "speaker_on", setSpeakerOn(true), "Altavoz procesado", serverAck)
                "speaker_off" -> emitCommandAck(commandId, "speaker_off", setSpeakerOn(false), "Altavoz procesado", serverAck)
                  else -> emitCommandAck(commandId, data.optString("action"), false, "Acción no soportada", serverAck)
              }
            }
        }

        // Receive web mic audio → play on phone speaker during call
        client.on("audio:dashboard") { args ->
            if (client !== socket) return@on
            val raw = args.firstOrNull()
            val bytes: ByteArray? = when (raw) {
                is ByteArray -> raw
                else -> null
            }
            bytes?.let { audioPlaybackQueue.trySend(it) }
        }

        client.on(Socket.EVENT_DISCONNECT) {
            val reason = it.firstOrNull()?.toString().orEmpty()
            Log.w(TAG, "[SOCKET] disconnected session=${code.takeLast(2)} reason=${reason.take(120)}")
            stopHeartbeat()
            if (client === socket) mainHandler.post { setStatus("🔄 Reconectando…") }
        }
        client.on(Socket.EVENT_CONNECT_ERROR) { args ->
            val error = args.firstOrNull()
            val cause = error as? Throwable
            Log.e(TAG, "[SOCKET] connect-error session=${code.takeLast(2)} error=${cause?.javaClass?.simpleName ?: error?.javaClass?.simpleName}: ${cause?.message ?: error}")
            if (client === socket) mainHandler.post { setStatus("🔄 Sin servidor — reintentando…") }
        }

        client.connect()
        setStatus("🔗 Conectando…")
    }

    // ── CALL ACTIONS ──────────────────────────────────────────────────────────

    @SuppressLint("MissingPermission")
    private fun dialNumber(
        number: String,
        companyName: String,
        contactName: String,
        imageUrl: String,
        commandId: String,
        contactId: String,
        callId: String,
        receivedAtElapsedMs: Long
    ): DialResult {
        Log.i(TAG, "[DIAL] start command=${commandId.takeLast(8)} call=${callId.takeLast(8)} contactPresent=${contactId.isNotBlank()} receivedToStartMs=${SystemClock.elapsedRealtime() - receivedAtElapsedMs}")
        if (number.isBlank() || commandId.isBlank()) {
            Log.w(TAG, "[DIAL] rejected: number or command id is empty")
            return DialResult(false, "Número o identificador de llamada inválido")
        }
        if (BlockedNumberStore.contains(this, number)) {
            Log.w(TAG, "[DIAL] rejected: number is blocked locally")
            return DialResult(false, "Número bloqueado. Quítalo de la lista de bloqueos antes de llamar.")
        }
        if (isActuallyInCall() || activeCommandId.isNotBlank()) {
            Log.w(TAG, "[DIAL] rejected: another call is active")
            return DialResult(false, "El teléfono ya está atendiendo otra llamada")
        }
        dialAttemptToken += 1
        hangupVerificationToken += 1
        val thisAttempt = dialAttemptToken
        // Telecom applies speaker routing when it creates the cellular call.
        // Do not publish the previous call state before initializing this attempt.
        isSpeakerOn = true
        currentPhoneNumber = number
        currentContactName = when {
            contactName.isNotBlank() -> contactName
            companyName.isNotBlank() -> companyName
            else -> number
        }
        currentCompanyName = when {
            companyName.isNotBlank() -> companyName
            currentContactName.isNotBlank() -> currentContactName
            else -> number
        }
        currentImageUrl = imageUrl
        detectedVoicemail = false
        detectedAnnouncement = ""
        activeCommandId = commandId
        activeCallId = callId
        activeDialStartedAtElapsedMs = SystemClock.elapsedRealtime()
        activeContactId = contactId
        campaignPhoneNumber = number
        campaignStateObserved = false
        campaignTrackingRestored = false
        currentCallDirection = "outgoing"
        lastCallState = "dialing"
        persistCampaignTracking()
        launchCallUi()
        emitCallUiState()

        if (!hasPermission(Manifest.permission.CALL_PHONE)) {
            Log.e(TAG, "[DIAL] rejected: CALL_PHONE permission missing")
            return abortDial("Falta permiso CALL_PHONE")
        }
        if (!isDefaultDialer()) {
            Log.e(TAG, "[DIAL] rejected: app is not the default dialer")
            return abortDial("Phone-VC no es el marcador predeterminado")
        }

        try {
            val tm = getSystemService(TELECOM_SERVICE) as? TelecomManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && tm != null) {
                tm.placeCall(Uri.parse("tel:$number"), Bundle())
                Log.i(TAG, "[DIAL] TelecomManager.placeCall accepted command=${commandId.takeLast(8)} call=${callId.takeLast(8)} receivedToPlaceCallMs=${SystemClock.elapsedRealtime() - receivedAtElapsedMs}")
                emitPhoneStatus("dialing", "command", correlateCampaign = true)
                setStatus("📞 Intentando llamada a $number")

                // Never place a second automatic call: on some phones the
                // original implementation could dial the contact twice while
                // Android was still reporting the first request.
                mainHandler.postDelayed({
                    if (thisAttempt != dialAttemptToken) return@postDelayed
                    if (!isActuallyInCall()) {
                        Log.e(TAG, "[DIAL] no Telecom call state within timeout command=${commandId.takeLast(8)} call=${callId.takeLast(8)} elapsedMs=${SystemClock.elapsedRealtime() - activeDialStartedAtElapsedMs}")
                        handleObservedCallState(
                            "failed",
                            number,
                            "",
                            "outgoing",
                            "dial_timeout"
                        )
                        setStatus("⚠️ Android no inició la llamada")
                    }
                }, 10_000)
                return DialResult(true, "Comando recibido e inicio de llamada solicitado")
            }
        } catch (e: Exception) {
            Log.e(TAG, "[DIAL] TelecomManager.placeCall failed command=${commandId.takeLast(8)} call=${callId.takeLast(8)}", e)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return abortDial("Android bloqueó la marcación automática")
        }

        try {
            startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:$number")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            emitPhoneStatus("dialing", "command", correlateCampaign = true)
            setStatus("📞 Llamando $number")
            return DialResult(true, "Comando recibido e inicio de llamada solicitado")
        } catch (e: Exception) {
            return abortDial("No se pudo iniciar la llamada: ${e.message}")
        }
    }

    private fun abortDial(reason: String): DialResult {
        Log.e(TAG, "[DIAL] aborted command=${activeCommandId.takeLast(8)} call=${activeCallId.takeLast(8)} reason=$reason")
        dialAttemptToken += 1
        lastCallState = "failed"
        emitPhoneStatus("failed", "dial_error", correlateCampaign = true)
        stopAudio()
        clearCampaignTracking()
        currentPhoneNumber = ""
        currentCompanyName = ""
        currentContactName = ""
        currentImageUrl = ""
        currentCallDirection = "unknown"
        emitCallUiState()
        closeCallUi()
        setStatus("⚠️ $reason")
        return DialResult(false, reason)
    }

    /** Shows a high-priority notification with a tap-to-call action (Android 10+ safe) */
    private fun showDialNotification(number: String, autoLaunch: Boolean = false) {
        val title = listOf(currentCompanyName, currentContactName).firstOrNull { it.isNotBlank() } ?: number
        val fullScreenIntent = PendingIntent.getActivity(
            this,
            3,
            callUiIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val callIntent = Intent(Intent.ACTION_CALL, Uri.parse("tel:$number"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(
            this, 2, callIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("📞 $title")
            .setContentText(number)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenIntent, true)
            .setContentIntent(fullScreenIntent)
            .setAutoCancel(true)
            .build()
        (getSystemService(NotificationManager::class.java))?.notify(9202, n)
        if (autoLaunch) {
            try {
                pi.send()
                setStatus("📱 Intentando abrir pantalla de llamada…")
            } catch (_: Exception) {
                setStatus("📱 Toca la notificación para llamar a $number")
            }
        } else {
            setStatus("📱 Toca la notificación para llamar a $number")
        }
    }

    private fun launchSystemDialerCall(number: String): Boolean {
        val candidates = listOf(
            "com.samsung.android.dialer",
            "com.google.android.dialer",
            "com.android.dialer"
        )
        val uri = Uri.parse("tel:$number")
        for (pkg in candidates) {
            try {
                val i = Intent(Intent.ACTION_CALL, uri)
                    .setPackage(pkg)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (i.resolveActivity(packageManager) != null) {
                    startActivity(i)
                    return true
                }
            } catch (_: Exception) {}
        }
        return false
    }

    private fun setMicMute(mute: Boolean): Boolean {
        try {
            val am = getSystemService(AUDIO_SERVICE) as? AudioManager
            if (am == null) {
                setStatus("⚠️ AudioManager no disponible")
                return false
            }
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            am.isMicrophoneMute = mute
            isMicMuted = mute
            emitCallUiState()
            emitPhoneStatus(lastCallState, "controls", correlateCampaign = activeCommandId.isNotBlank())
            launchCallUi()
            setStatus(if (mute) "🔇 Micrófono silenciado" else "🎙️ Micrófono activo")
            return true
        } catch (e: Exception) {
            setStatus("⚠️ No se pudo cambiar micro: ${e.message}")
            return false
        }
    }

    private fun setSpeakerOn(enabled: Boolean): Boolean {
        if (VoipVcInCallService.isTrackingCalls()) {
            val ok = VoipVcInCallService.setSpeaker(enabled)
            if (!ok) setStatus("⚠️ Android no pudo cambiar el altavoz")
            // Confirmed route arrives through the Telecom audio callback.
            return ok
        }
        try {
            val am = getSystemService(AUDIO_SERVICE) as? AudioManager
            if (am == null) {
                setStatus("⚠️ AudioManager no disponible")
                return false
            }
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            var ok = true

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (enabled) {
                    val speaker = am.availableCommunicationDevices
                        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    ok = if (speaker != null) am.setCommunicationDevice(speaker) else false
                } else {
                    val earpiece = am.availableCommunicationDevices
                        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
                    ok = if (earpiece != null) am.setCommunicationDevice(earpiece) else {
                        am.clearCommunicationDevice()
                        true
                    }
                }
            }

            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = enabled
            isSpeakerOn = enabled && ok
            emitCallUiState()
            emitPhoneStatus(lastCallState, "controls", correlateCampaign = activeCommandId.isNotBlank())
            launchCallUi()
            if (!ok) {
                setStatus("⚠️ No se pudo cambiar ruta de audio en este dispositivo")
                return false
            }
            setStatus(if (isSpeakerOn) "🔊 Altavoz activado" else "🔈 Altavoz desactivado")
            return isSpeakerOn == enabled
        } catch (e: Exception) {
            setStatus("⚠️ No se pudo cambiar altavoz: ${e.message}")
            return false
        }
    }

    private fun answerIncomingCall(): Boolean {
        if (!hasPermission(Manifest.permission.ANSWER_PHONE_CALLS)) {
            setStatus("⚠️ Falta permiso ANSWER_PHONE_CALLS")
            return false
        }
        val ok = VoipVcInCallService.answerRingingCall()
        if (!ok) {
            setStatus("⚠️ No hay llamada entrante para contestar")
            return false
        }
        lastCallState = "in_call"
        startAudio()
        emitPhoneStatus("in_call", "user_action", correlateCampaign = activeCommandId.isNotBlank())
        emitCallUiState()
        launchCallUi()
        setStatus("✅ Llamada contestada")
        return true
    }


    @SuppressLint("MissingPermission")
    private fun hangup(): Boolean {
        dialAttemptToken += 1 // cancel pending dial fallback callbacks
        val targetNumber = campaignPhoneNumber.ifBlank { currentPhoneNumber }
        if (!isDefaultDialer()) {
            setStatus("⚠️ Activa Phone-VC como marcador default")
            return false
        }
        try {
            if (!VoipVcInCallService.hasLiveCall(targetNumber)) {
                val targetAlreadyEnded = VoipVcInCallService.isCallDefinitelyAbsent(targetNumber) ||
                    (
                        !VoipVcInCallService.isTrackingCalls() &&
                            hasPermission(Manifest.permission.READ_PHONE_STATE) &&
                            !isActuallyInCall()
                    )
                if (targetAlreadyEnded && activeCommandId.isNotBlank()) {
                    handleObservedCallState(
                        "ended",
                        targetNumber,
                        "",
                        "outgoing",
                        "hangup_already_ended"
                    )
                    return true
                }
                setStatus("⚠️ No se pudo identificar la llamada que debe cortarse")
                return false
            }

            val requested = VoipVcInCallService.disconnectCall(targetNumber)
            scheduleHangupVerification(targetNumber)
            if (requested) {
                setStatus("📵 Corte solicitado; esperando confirmación…")
                return true
            }
            setStatus("⚠️ Android rechazó el corte; verificando nuevamente…")
            return false
        } catch (e: Exception) {
            setStatus("Error al colgar: ${e.message}")
            return false
        }
    }

    private fun scheduleHangupVerification(targetNumber: String) {
        hangupVerificationToken += 1
        val token = hangupVerificationToken
        mainHandler.postDelayed({
            if (token != hangupVerificationToken || activeCommandId.isBlank()) return@postDelayed
            if (VoipVcInCallService.hasLiveCall(targetNumber)) {
                VoipVcInCallService.disconnectCall(targetNumber)
            }
        }, 1_000L)
        mainHandler.postDelayed({
            if (token != hangupVerificationToken || activeCommandId.isBlank()) return@postDelayed
            val targetEnded = !VoipVcInCallService.hasLiveCall(targetNumber) &&
                (
                    VoipVcInCallService.isCallDefinitelyAbsent(targetNumber) ||
                        (
                            !VoipVcInCallService.isTrackingCalls() &&
                                hasPermission(Manifest.permission.READ_PHONE_STATE) &&
                                !isActuallyInCall()
                        )
                )
            if (targetEnded) {
                handleObservedCallState(
                    "ended",
                    targetNumber,
                    "",
                    "outgoing",
                    "hangup_verification"
                )
            } else {
                setStatus("⚠️ No se confirmó el corte; revisa el teléfono")
            }
        }, 3_500L)
    }

    private fun isDefaultDialer(): Boolean =
        (getSystemService(TELECOM_SERVICE) as? TelecomManager)?.defaultDialerPackage == packageName

    private fun isActuallyInCall(): Boolean {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return false
        }
        val tm = getSystemService(TELECOM_SERVICE) as? TelecomManager
        return tm?.isInCall == true
    }

    private fun normalizedNumber(value: String): String {
        var digits = value.filter(Char::isDigit)
        if (digits.length == 11 && digits.startsWith("51")) digits = digits.drop(2)
        return digits
    }

    private fun numbersMatch(first: String, second: String): Boolean {
        val a = normalizedNumber(first)
        val b = normalizedNumber(second)
        return a.isNotBlank() && b.isNotBlank() && a == b
    }

    private fun isRegressiveTransition(previous: String, next: String): Boolean =
        (previous == "in_call" && (next == "dialing" || next == "ringing")) ||
            (previous == "ringing" && next == "dialing")

    private fun handleObservedCallState(
        rawState: String,
        observedNumber: String,
        observedName: String,
        direction: String,
        source: String
    ) {
        if (rawState !in setOf("idle", "dialing", "ringing", "in_call", "ended", "failed")) return

        val hasCampaignCall = activeCommandId.isNotBlank()
        val normalizedDirection = direction.lowercase()
        val hasCampaignIdentity = if (observedNumber.isBlank()) {
            normalizedDirection == "outgoing"
        } else {
            numbersMatch(campaignPhoneNumber, observedNumber)
        }
        val belongsToCampaign = hasCampaignCall &&
            normalizedDirection != "incoming" &&
            hasCampaignIdentity

        if (hasCampaignCall && !belongsToCampaign) {
            // Report the observation for diagnostics, without campaign IDs.
            // The server will keep it isolated from the assigned outbound call.
            emitPhoneStatus(
                rawState,
                source,
                correlateCampaign = false,
                phoneNumberOverride = observedNumber,
                directionOverride = direction
            )
            Log.i(TAG, "Ignoring unrelated $direction call while campaign command is active")
            return
        }

        if (!hasCampaignCall && observedNumber.isNotBlank()) currentPhoneNumber = observedNumber
        if (!hasCampaignCall && observedName.isNotBlank()) {
            currentContactName = observedName
            if (currentCompanyName.isBlank()) currentCompanyName = observedName
        }
        if (hasCampaignCall) currentPhoneNumber = campaignPhoneNumber
        currentCallDirection = if (hasCampaignCall) "outgoing" else direction

        if (hasCampaignCall && rawState in setOf("dialing", "ringing", "in_call")) {
            campaignStateObserved = true
        }
        if (hasCampaignCall && rawState == "idle" && !campaignStateObserved) {
            Log.d(TAG, "Ignoring premature idle before campaign call activity")
            return
        }

        val state = if (hasCampaignCall && rawState == "idle") "ended" else rawState
        if (isRegressiveTransition(lastCallState, state)) {
            Log.d(TAG, "Ignoring regressive state $lastCallState -> $state from $source")
            return
        }

        val previousState = lastCallState
        lastCallState = state
        Log.i(TAG, "[CALL_STATE] $previousState->$state source=$source command=${activeCommandId.takeLast(8)} call=${activeCallId.takeLast(8)} elapsedMs=${if (activeDialStartedAtElapsedMs > 0) SystemClock.elapsedRealtime() - activeDialStartedAtElapsedMs else -1}")
        if (belongsToCampaign) persistCampaignTracking(state)
        emitPhoneStatus(state, source, correlateCampaign = belongsToCampaign)
        emitCallUiState()

        when (state) {
            "dialing" -> {
                launchCallUi()
                val elapsedSec = if (activeDialStartedAtElapsedMs > 0) (SystemClock.elapsedRealtime() - activeDialStartedAtElapsedMs) / 1000 else 0
                setStatus("📞 Llamando... ${elapsedSec}s")
                if (hasCampaignCall && belongsToCampaign && activeDialStartedAtElapsedMs > 0) {
                    val dialElapsedMs = SystemClock.elapsedRealtime() - activeDialStartedAtElapsedMs
                    // Escalating timeout: 20s for likely busy/voicemail, 40s for no-answer
                    when {
                        dialElapsedMs > 20_000 && dialElapsedMs <= 25_000 -> {
                            Log.w(TAG, "[DIAL_TIMEOUT] 20s exceeded - likely busy/voicemail command=${activeCommandId.takeLast(8)} call=${activeCallId.takeLast(8)}")
                            handleObservedCallState("failed", campaignPhoneNumber, "", "outgoing", "dial_timeout_busy")
                            return
                        }
                        dialElapsedMs > 40_000 -> {
                            Log.w(TAG, "[DIAL_TIMEOUT] 40s exceeded - no answer command=${activeCommandId.takeLast(8)} call=${activeCallId.takeLast(8)}")
                            handleObservedCallState("failed", campaignPhoneNumber, "", "outgoing", "dial_timeout_no_answer")
                            return
                        }
                    }
                }
            }
            "ringing" -> {
                launchCallUi()
                setStatus("📲 Llamada entrante")
            }
            "in_call" -> {
                startAudio()
                if (activeCallId.isNotBlank()) {
                    if (callAnsweredAtElapsedMs == 0L) callAnsweredAtElapsedMs = SystemClock.elapsedRealtime()
                    callRecorder.start(activeCallId, activeContactId, campaignPhoneNumber.ifBlank { currentPhoneNumber })
                }
                launchCallUi()
                setStatus("🔊 En llamada")
            }
            "ended", "failed", "idle" -> {
                dialAttemptToken += 1
                hangupVerificationToken += 1
                stopAudio()
                if (callAnsweredAtElapsedMs > 0L && activeCallId.isNotBlank()) {
                    val elapsedSec = ((SystemClock.elapsedRealtime() - callAnsweredAtElapsedMs) / 1000L).toInt().coerceAtLeast(1)
                    val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    val baseUrl = prefs.getString(PREF_SOCKET_URL, "").orEmpty()
                    val sessionCode = prefs.getString(PREF_CODE, "").orEmpty()
                    callRecorder.stopAndUpload(serviceScope, baseUrl, sessionCode, currentPairingToken, elapsedSec)
                } else {
                    callRecorder.cancel()
                }
                callAnsweredAtElapsedMs = 0L
                setStatus("✅ Activo — esperando llamadas")
                closeCallUi()
                if (!isActuallyInCall()) {
                    currentPhoneNumber = ""
                    currentCompanyName = ""
                    currentContactName = ""
                    currentImageUrl = ""
                }
                if (hasCampaignCall && belongsToCampaign) {
                    clearCampaignTracking()
                }
            }
        }
    }

    private fun clearCampaignTracking() {
        detectedVoicemail = false
        detectedAnnouncement = ""
        activeCallId = ""
        activeCommandId = ""
        activeDialStartedAtElapsedMs = 0L
        activeContactId = ""
        campaignPhoneNumber = ""
        campaignStateObserved = false
        campaignTrackingRestored = false
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .remove("detected_voicemail")
            .remove("detected_announcement")
            .remove("active_call_id")
            .remove(PREF_ACTIVE_COMMAND_ID)
            .remove(PREF_ACTIVE_CONTACT_ID)
            .remove(PREF_CAMPAIGN_PHONE)
            .remove(PREF_CAMPAIGN_CALL_STATE)
            .remove(PREF_CAMPAIGN_STATE_OBSERVED)
            .apply()
    }

    private fun persistCampaignTracking(state: String = lastCallState) {
        if (activeCommandId.isBlank()) return
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit()
            .putBoolean("detected_voicemail", detectedVoicemail)
            .putString("detected_announcement", detectedAnnouncement)
            .putString("active_call_id", activeCallId)
            .putString(PREF_ACTIVE_COMMAND_ID, activeCommandId)
            .putString(PREF_ACTIVE_CONTACT_ID, activeContactId)
            .putString(PREF_CAMPAIGN_PHONE, campaignPhoneNumber)
            .putString(PREF_CAMPAIGN_CALL_STATE, state)
            .putBoolean(PREF_CAMPAIGN_STATE_OBSERVED, campaignStateObserved)
            .apply()
    }

    private fun restoreCampaignTracking() {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        detectedVoicemail = prefs.getBoolean("detected_voicemail", false)
        detectedAnnouncement = prefs.getString("detected_announcement", "").orEmpty()
        activeCallId = prefs.getString("active_call_id", "").orEmpty()
        activeCommandId = prefs.getString(PREF_ACTIVE_COMMAND_ID, "").orEmpty()
        activeContactId = prefs.getString(PREF_ACTIVE_CONTACT_ID, "").orEmpty()
        campaignPhoneNumber = prefs.getString(PREF_CAMPAIGN_PHONE, "").orEmpty()
        if (activeCommandId.isBlank()) return
        lastCallState = prefs.getString(PREF_CAMPAIGN_CALL_STATE, "dialing").orEmpty().ifBlank { "dialing" }
        currentPhoneNumber = campaignPhoneNumber
        currentCallDirection = "outgoing"
        campaignStateObserved = prefs.getBoolean(
            PREF_CAMPAIGN_STATE_OBSERVED,
            lastCallState in setOf("ringing", "in_call", "ended", "failed")
        )
        campaignTrackingRestored = true
    }

    // ── CALL STATE MONITOR (no root, just READ_PHONE_STATE) ───────────────────

    @Suppress("DEPRECATION")
    private fun registerCallMonitor() {
        val tm = getSystemService(TELEPHONY_SERVICE) as? TelephonyManager ?: return
        if (!hasPermission(Manifest.permission.READ_PHONE_STATE)) return

        phoneStateListener = object : PhoneStateListener() {
            override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                val callState = when (state) {
                    TelephonyManager.CALL_STATE_RINGING -> "ringing"
                    // OFFHOOK can happen before remote party answers (outgoing dialing).
                    // Real "in_call" is driven by Telecom ACTIVE state via VoipVcInCallService.
                    TelephonyManager.CALL_STATE_OFFHOOK -> "dialing"
                    else                                -> "idle"
                }
                val scheduledAt = SystemClock.elapsedRealtime()
                val number = phoneNumber.orEmpty()
                val direction = if (callState == "ringing") "incoming"
                    else if (activeCommandId.isNotBlank()) "outgoing" else "unknown"

                // InCallService has richer, authoritative states. Telephony is
                // retained only as a delayed fallback for vendor-specific ROMs.
                mainHandler.postDelayed({
                    if (lastTelecomEventAt >= scheduledAt || VoipVcInCallService.isTrackingCalls()) {
                        return@postDelayed
                    }
                    handleObservedCallState(callState, number, "", direction, "telephony_fallback")
                }, 750L)
            }
        }

        @Suppress("DEPRECATION")
        tm.listen(phoneStateListener, PhoneStateListener.LISTEN_CALL_STATE)
    }

    @Suppress("DEPRECATION")
    private fun unregisterCallMonitor() {
        try {
            (getSystemService(TELEPHONY_SERVICE) as? TelephonyManager)
                ?.listen(phoneStateListener, PhoneStateListener.LISTEN_NONE)
        } catch (_: Exception) {}
        phoneStateListener = null
    }

    // ── AUDIO BRIDGE (no root required) ──────────────────────────────────────

    /**
     * Starts:
     * 1. AudioRecord — captures phone MIC → sends to web via socket "audio:phone"
     * 2. AudioTrack  — receives web MIC audio → plays on phone speaker
     */
    @SuppressLint("MissingPermission")
    private fun startAudio() {
        if (isStreaming.getAndSet(true)) return

        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) {
            setStatus("⚠️ Falta permiso RECORD_AUDIO")
            isStreaming.set(false)
            return
        }

        // ── AudioTrack (playback) ─────────────────────────────────────────────
        try {
            audioTrack = AudioTrack(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .build(),
                minBufOut,
                AudioTrack.MODE_STREAM,
                AudioManager.AUDIO_SESSION_ID_GENERATE
            )
            audioTrack!!.play()
            isPlaying.set(true)
            playbackJob = serviceScope.launch(Dispatchers.IO) {
                // Jitter buffer: pre-fill with 3 chunks (~240ms) before starting playback
                val preBuffer = mutableListOf<ByteArray>()
                for (bytes in audioPlaybackQueue) {
                    if (!isPlaying.get()) break
                    preBuffer.add(bytes)
                    if (preBuffer.size >= 3) {
                        // Pre-buffer full, start playback
                        for (buf in preBuffer) playAudio(buf)
                        preBuffer.clear()
                        break
                    }
                }
                // Continue normal playback
                for (bytes in audioPlaybackQueue) {
                    if (isPlaying.get()) playAudio(bytes)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "AudioTrack failed", e)
        }

        // ── AudioRecord (capture) ─────────────────────────────────────────────
        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBufIn
            )
        } catch (e: Exception) {
            Log.e(TAG, "AudioRecord failed", e)
            stopAudio()
            return
        }

        if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
            setStatus("⚠️ AudioRecord no disponible")
            stopAudio()
            return
        }

        try {
            audioRecord!!.startRecording()
        } catch (e: Exception) {
            Log.e(TAG, "Could not start microphone capture", e)
            stopAudio()
            setStatus("⚠️ No se pudo iniciar el micrófono")
            return
        }

        val chunkBytes = CHUNK_FRAMES * 2
        // Capture: read from AudioRecord -> captureQueue (backpressure)
        captureJob = serviceScope.launch(Dispatchers.IO) {
            val buf = ByteArray(CHUNK_BYTES)
            while (isActive && isStreaming.get()) {
                val read = audioRecord?.read(buf, 0, CHUNK_BYTES) ?: -1
                if (read > 0) {
                    val chunk = buf.copyOf(read)
                    callRecorder.writePcm(chunk)
                    audioCaptureQueue.trySend(chunk)
                }
            }
        }
        // Emit from captureQueue -> socket (separate coroutine for backpressure)
        serviceScope.launch(Dispatchers.IO) {
            for (chunk in audioCaptureQueue) {
                if (socket?.connected() == true) {
                    socket!!.emit("audio:phone", chunk)
                } else {
                    // Socket disconnected, drop chunk to avoid buildup
                }
            }
        }

        Log.d(TAG, "Audio bridge started via Coroutines")
    }

    private fun stopAudio() {
        isStreaming.set(false)
        isPlaying.set(false)
        captureJob?.cancel()
        captureJob = null
        playbackJob?.cancel()
        playbackJob = null
        while (audioPlaybackQueue.tryReceive().isSuccess) { /* discard stale audio */ }
        while (audioCaptureQueue.tryReceive().isSuccess) { /* discard stale capture */ }
        while (audioBufferPool.tryReceive().isSuccess) { /* discard pool buffers */ }
        try { audioRecord?.stop(); audioRecord?.release() } catch (_: Exception) {}
        try { audioTrack?.stop(); audioTrack?.release()  } catch (_: Exception) {}
        audioRecord = null
        audioTrack  = null
        try {
            val audioManager = getSystemService(AUDIO_SERVICE) as? AudioManager
            @Suppress("DEPRECATION")
            audioManager?.isMicrophoneMute = false
            @Suppress("DEPRECATION")
            audioManager?.isSpeakerphoneOn = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audioManager?.clearCommunicationDevice()
            audioManager?.mode = AudioManager.MODE_NORMAL
        } catch (_: Exception) {}
        isMicMuted = false
        isSpeakerOn = false
    }

    // App-level heartbeat (10s interval, 5s timeout) - faster than Socket.IO ping for mobile
    private fun startHeartbeat(client: Socket) {
        stopHeartbeat()
        Log.i(TAG, "[HEARTBEAT] starting clientConnected=${client.connected()}")
        heartbeatJob = serviceScope.launch {
            Log.i(TAG, "[HEARTBEAT] coroutine running")
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                if (!isActive) break
                // Wait for socket to be connected (handles brief disconnects during calls)
                var waitCount = 0
                while (isActive && !client.connected() && waitCount < 30) { // wait up to 30s
                    delay(1000)
                    waitCount++
                }
                if (!isActive || !client.connected()) {
                    Log.w(TAG, "[HEARTBEAT] socket not connected after wait, will retry next interval")
                    continue
                }
                val sentAt = System.currentTimeMillis()
                client.emit("app:heartbeat_ping", JSONObject().put("t", sentAt), Ack { ackArgs ->
                    val latencyMs = System.currentTimeMillis() - sentAt
                    if (latencyMs > HEARTBEAT_TIMEOUT_MS) {
                        Log.w(TAG, "[HEARTBEAT] pong timeout latency=${latencyMs}ms")
                        if (client === socket) {
                            mainHandler.post { client.disconnect() }
                        }
                    } else {
                        Log.d(TAG, "[HEARTBEAT] pong ok latency=${latencyMs}ms")
                    }
                })
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = null
    }

    private fun buildRestartIntentFromPrefs(): Intent? {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val url = prefs.getString(PREF_SOCKET_URL, "") ?: ""
        val code = prefs.getString(PREF_CODE, "") ?: ""
        val token = prefs.getString(PREF_TOKEN, "") ?: ""
        val devId = prefs.getString(PREF_DEVICE_ID, "") ?: ""
        val devName = prefs.getString(PREF_DEVICE_NAME, "") ?: ""

        if (url.isBlank() || code.isBlank() || token.isBlank()) return null

        return Intent(this, BridgeService::class.java).apply {
            action = ACTION_START
            putExtra(EXTRA_SOCKET_URL, url)
            putExtra(EXTRA_CODE, code)
            putExtra(EXTRA_TOKEN, token)
            putExtra(EXTRA_DEVICE_ID, devId)
            putExtra(EXTRA_DEVICE_NAME, devName)
        }
    }

    private fun playAudio(bytes: ByteArray) {
        if (!isPlaying.get()) return
        try { audioTrack?.write(bytes, 0, bytes.size) } catch (_: Exception) {}
    }

    private fun callUiIntent(): Intent =
        Intent(this, IncomingCallActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(EXTRA_PHONE_NUMBER, currentPhoneNumber)
            putExtra(EXTRA_COMPANY_NAME, currentCompanyName)
            putExtra(EXTRA_CONTACT_NAME, currentContactName)
            putExtra(EXTRA_IMAGE_URL, currentImageUrl)
            putExtra(EXTRA_CALL_STATE, lastCallState)
            putExtra(EXTRA_MIC_MUTED, isMicMuted)
            putExtra(EXTRA_SPEAKER_ON, isSpeakerOn)
        }

    private fun launchCallUi() {
        if (currentPhoneNumber.isBlank() && lastCallState == "idle") return
        try { startActivity(callUiIntent()) } catch (_: Exception) {}
    }

    private fun emitCallUiState() {
        sendBroadcast(
            Intent(ACTION_CALL_UI_STATE).apply {
                setPackage(packageName)
                putExtra(EXTRA_PHONE_NUMBER, currentPhoneNumber)
                putExtra(EXTRA_COMPANY_NAME, currentCompanyName)
                putExtra(EXTRA_CONTACT_NAME, currentContactName)
                putExtra(EXTRA_IMAGE_URL, currentImageUrl)
                putExtra(EXTRA_CALL_STATE, lastCallState)
                putExtra(EXTRA_MIC_MUTED, isMicMuted)
                putExtra(EXTRA_SPEAKER_ON, isSpeakerOn)
            }
        )
    }

    private fun closeCallUi() {
        sendBroadcast(Intent(ACTION_CLOSE_CALL_UI).setPackage(packageName))
    }

    private fun emitCommandAck(commandId: String, action: String, ok: Boolean, message: String, serverAck: Ack? = null) {
        Log.i(TAG, "[CALL_ACK] action=$action command=${commandId.takeLast(8)} ok=$ok connected=${socket?.connected() == true} message=$message")
        serverAck?.call(JSONObject().put("ok", ok).put("action", action).put("message", message))
        if (commandId.isBlank() || socket?.connected() != true) return
        socket?.emit(
            "phone:command_ack",
            JSONObject()
                .put("commandId", commandId)
                .put("action", action)
                .put("ok", ok)
                .put("message", message)
        )
    }

    private fun logoutAndStop() {
        try {
            dialAttemptToken += 1
            stopAudio()
            closeCallUi()
            socket?.disconnect()
            socket?.off()
            socket = null
            connectionKey = ""
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().clear().apply()
            lastCallState = "idle"
            currentPhoneNumber = ""
            currentCompanyName = ""
            currentContactName = ""
            currentImageUrl = ""
            isMicMuted = false
            isSpeakerOn = false
            clearCampaignTracking()
            lastDialCommandId = ""
            lastDialAck = DialResult(false, "")
            setStatus("🔒 Sesión cerrada. APK detenida.")
        } catch (e: Exception) {
            setStatus("⚠️ Error al cerrar sesión: ${e.message}")
        } finally {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun emitPhoneStatus(
        state: String,
        source: String,
        correlateCampaign: Boolean,
        phoneNumberOverride: String? = null,
        directionOverride: String? = null
    ) {
        val reportedNumber = phoneNumberOverride ?: currentPhoneNumber
        val reportedDirection = directionOverride ?: currentCallDirection
        val commandId = if (correlateCampaign) activeCommandId else ""
        val contactId = if (correlateCampaign) activeContactId else ""
        val callId = if (correlateCampaign) activeCallId else ""
        val noLiveCalls = state in setOf("idle", "ended", "failed") &&
            hasPermission(Manifest.permission.READ_PHONE_STATE) &&
            !VoipVcInCallService.isTrackingCalls() &&
            !isActuallyInCall()
        val signature = listOf(
            state,
            normalizedNumber(reportedNumber),
            commandId,
            contactId,
            callId,
            reportedDirection,
            source,
            campaignStateObserved.toString(),
            detectedVoicemail.toString(),
            detectedAnnouncement,
            noLiveCalls.toString(),
            isMicMuted.toString(),
            isSpeakerOn.toString()
        ).joinToString("|")
        if (socket?.connected() != true) return
        if (signature == lastEmittedStatusSignature && source != "reconnect") return
        lastEmittedStatusSignature = signature
        statusSequence += 1
        Log.i(TAG, "[PHONE_STATUS] emit state=$state source=$source command=${commandId.takeLast(8)} call=${if (correlateCampaign) activeCallId.takeLast(8) else ""} sequence=$statusSequence terminalConfirmed=$noLiveCalls")

        socket?.emit(
            "phone:status",
            JSONObject()
                .put("callState", state)
                .put("phoneNumber", reportedNumber)
                .put("contactName", currentContactName)
                .put("companyName", currentCompanyName)
                .put("commandId", commandId)
                .put("callId", if (correlateCampaign) activeCallId else "")
                .put("contactId", contactId)
                .put("detectedVoicemail", correlateCampaign && detectedVoicemail)
            .put("detectedAnnouncement", if (correlateCampaign) detectedAnnouncement else "")
                .put("terminalConfirmed", noLiveCalls)
                .put("externalIncoming", reportedDirection == "incoming")
                .put("callDirection", reportedDirection)
                .put("source", source)
                .put("physicalObserved", campaignStateObserved)
                .put("noLiveCalls", noLiveCalls)
                .put("statusSessionId", statusSessionId)
                .put("statusSequence", statusSequence)
                .put("micMuted", isMicMuted)
                .put("speakerOn", isSpeakerOn)
        )
    }

    // ── HELPERS ───────────────────────────────────────────────────────────────

    private fun hasPermission(perm: String) =
        ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED

    private fun sendBlockedNumberChange(intent: Intent) {
        val action = intent.getStringExtra(EXTRA_BLOCKLIST_ACTION).orEmpty()
        val number = intent.getStringExtra(EXTRA_PHONE_NUMBER).orEmpty().trim()
        val name = intent.getStringExtra(EXTRA_CONTACT_NAME).orEmpty().trim().ifBlank { number }
        if (action !in setOf("add", "remove") || number.filter(Char::isDigit).length !in 6..15) {
            setStatus("No se pudo actualizar la lista: nombre o número inválido")
            return
        }
        val client = socket
        if (client?.connected() != true) {
            Log.w(TAG, "Blocked number saved locally; server is not connected")
            return
        }
        client.emit(
            "blocked-numbers:change",
            JSONObject().put("action", action).put("name", name).put("phone", number)
        )
    }

    private fun sendMessageContactToWeb(intent: Intent) {
        val name = intent.getStringExtra(EXTRA_CONTACT_NAME).orEmpty().trim().take(120)
        val number = intent.getStringExtra(EXTRA_PHONE_NUMBER).orEmpty().trim()
        if (number.isBlank()) {
            setStatus("No se pudo guardar: falta el número del contacto.")
            return
        }
        val client = socket
        if (client?.connected() != true) {
            setStatus("No se pudo enviar el contacto: el celular no está conectado a la web.")
            return
        }
        client.emit(
            "phone:message-contact:add",
            JSONObject()
                .put("name", name.ifBlank { number })
                .put("phone", number)
        )
    }

    private fun sendQuoteRequestToWeb(intent: Intent) {
        val name = intent.getStringExtra(EXTRA_CONTACT_NAME).orEmpty().trim().take(120)
        val number = intent.getStringExtra(EXTRA_PHONE_NUMBER).orEmpty().trim()
        val reservationType = intent.getStringExtra("reservation_type")
            ?.takeIf { it == "appointment" } ?: "quote"
        if (number.isBlank()) {
            setStatus("No se pudo enviar cotización: falta el número de teléfono.")
            return
        }
        val client = socket
        if (client?.connected() != true) {
            setStatus("No se pudo enviar: el celular no está conectado al panel web.")
            return
        }
        client.emit(
            "phone:quote:request",
            JSONObject()
                .put("name", name.ifBlank { number })
                .put("phone", number)
                .put("reservationType", reservationType)
        )
        setStatus(if (reservationType == "appointment") "📅 Agenda enviada al panel web: $number" else "📋 Cotización enviada al panel web: $number")
    }

    private fun setStatus(msg: String) {
        Log.d(TAG, msg)
        // Update notification
        (getSystemService(NotificationManager::class.java))
            ?.notify(NOTIFICATION_ID, buildNotification(msg))
        // Broadcast to MainActivity
        sendBroadcast(
            Intent(ACTION_STATUS)
                .setPackage(packageName)
                .putExtra(EXTRA_STATUS_MESSAGE, msg)
        )
    }

    // ── NOTIFICATION ──────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ch = NotificationChannel(
            CHANNEL_ID, "Phone-VC Bridge", NotificationManager.IMPORTANCE_HIGH
        ).apply { setShowBadge(false) }
        (getSystemService(NotificationManager::class.java))?.createNotificationChannel(ch)
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Phone-VC")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
