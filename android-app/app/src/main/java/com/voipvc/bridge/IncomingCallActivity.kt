package com.voipvc.bridge

import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

class IncomingCallActivity : AppCompatActivity() {

    private lateinit var companyImage: ImageView
    private lateinit var companyName: TextView
    private lateinit var phoneNumber: TextView
    private lateinit var callState: TextView
    private lateinit var callTimer: TextView
    private lateinit var micBtn: MaterialButton
    private lateinit var speakerBtn: MaterialButton
    private lateinit var messageBtn: MaterialButton
    private lateinit var blockBtn: MaterialButton
    private lateinit var answerBtn: MaterialButton
    private lateinit var hangupBtn: MaterialButton

    private var telecomUi = false
    private var imageUrl: String = ""
    private var callStartedAt: Long? = null
    private val timerHandler = Handler(Looper.getMainLooper())
    private val timerRunnable = object : Runnable {
        override fun run() {
            val started = callStartedAt ?: return
            val sec = ((System.currentTimeMillis() - started) / 1000L).toInt().coerceAtLeast(0)
            val mm = sec / 60
            val ss = sec % 60
            callTimer.text = String.format(Locale.US, "%02d:%02d", mm, ss)
            timerHandler.postDelayed(this, 1000L)
        }
    }

    private val uiReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == BridgeService.ACTION_CLOSE_CALL_UI) {
                finish()
                return
            }
            if (intent?.action == BridgeService.ACTION_BLOCKLIST_STATE) {
                updateBlockButtonState(phoneNumber.text.toString())
                return
            }
            if (telecomUi && intent?.action == BridgeService.ACTION_TELECOM_CALL_STATE) {
                renderFromIntent(intent)
            } else if (!telecomUi && intent?.action == BridgeService.ACTION_CALL_UI_STATE) {
                renderFromIntent(intent)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_incoming_call)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }

        companyImage = findViewById(R.id.companyImage)
        companyName = findViewById(R.id.companyNameText)
        phoneNumber = findViewById(R.id.phoneNumberText)
        callState = findViewById(R.id.callStateText)
        callTimer = findViewById(R.id.callTimerText)
        micBtn = findViewById(R.id.micButton)
        speakerBtn = findViewById(R.id.speakerButton)
        messageBtn = findViewById(R.id.messageButton)
        blockBtn = findViewById(R.id.blockButton)
        answerBtn = findViewById(R.id.answerButton)
        hangupBtn = findViewById(R.id.hangupButton)

        answerBtn.setOnClickListener {
            if (VoipVcInCallService.answerRingingCall()) {
                answerBtn.isEnabled = false
                callState.text = "Conectando…"
            } else {
                callState.text = "No se pudo contestar. Reintenta."
            }
        }
        micBtn.setOnClickListener {
            if (telecomUi) VoipVcInCallService.toggleMute()?.let { muted ->
                micBtn.text = if (muted) "Activar micrófono" else "Silenciar"
            } else sendServiceAction(BridgeService.ACTION_UI_TOGGLE_MUTE)
        }
        speakerBtn.setOnClickListener {
            if (telecomUi) VoipVcInCallService.toggleSpeaker()?.let { speaker ->
                speakerBtn.text = if (speaker) "Quitar altavoz" else "Altavoz"
            } else sendServiceAction(BridgeService.ACTION_UI_TOGGLE_SPEAKER)
        }
        messageBtn.setOnClickListener {
            val number = phoneNumber.text.toString().takeIf { it != "-" } ?: return@setOnClickListener
            val intent = Intent(Intent.ACTION_SENDTO).apply {
                data = Uri.fromParts("smsto", number, null)
            }
            try {
                startActivity(intent)
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(this, "No hay una aplicación SMS instalada. Instala o activa Mensajes.", Toast.LENGTH_LONG).show()
            }
        }
        blockBtn.setOnClickListener {
            val number = phoneNumber.text.toString().takeIf { it != "-" } ?: return@setOnClickListener
            val shouldBlock = !BlockedNumberStore.contains(this, number)
            val name = companyName.text.toString().ifBlank { number }
            BlockedNumberStore.setBlocked(this, name, number, shouldBlock)
            sendBlockedNumberChange(if (shouldBlock) "add" else "remove", name, number)
            if (shouldBlock) {
                if (telecomUi) {
                    if (!VoipVcInCallService.disconnectCall(number)) {
                        Toast.makeText(this, "Número bloqueado. No se pudo cortar la llamada; pulsa Colgar.", Toast.LENGTH_LONG).show()
                    }
                } else sendServiceAction(BridgeService.ACTION_UI_HANGUP)
            }
            updateBlockButtonState(number)
            Toast.makeText(this, if (shouldBlock) "Agregado a la lista de bloqueos" else "Número quitado de la lista", Toast.LENGTH_SHORT).show()
        }
        hangupBtn.setOnClickListener {
            if (telecomUi) VoipVcInCallService.disconnectCall(phoneNumber.text.toString().let { if (it == "-") "" else it })
            else sendServiceAction(BridgeService.ACTION_UI_HANGUP)
        }

        telecomUi = intent.getBooleanExtra("telecom_ui", false)
        renderFromIntent(intent)
        if (!telecomUi) sendServiceAction(BridgeService.ACTION_UI_SYNC)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        telecomUi = intent.getBooleanExtra("telecom_ui", false)
        renderFromIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter().apply {
            addAction(BridgeService.ACTION_CALL_UI_STATE)
            addAction(BridgeService.ACTION_TELECOM_CALL_STATE)
            addAction(BridgeService.ACTION_CLOSE_CALL_UI)
            addAction(BridgeService.ACTION_BLOCKLIST_STATE)
        }
        ContextCompat.registerReceiver(this, uiReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        if (telecomUi) VoipVcInCallService.currentCallIntent()?.let { renderFromIntent(it) }
    }

    override fun onStop() {
        super.onStop()
        unregisterReceiver(uiReceiver)
        timerHandler.removeCallbacks(timerRunnable)
    }

    private fun sendServiceAction(action: String) {
        val i = Intent(this, BridgeService::class.java).apply { this.action = action }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(i)
        } else {
            startService(i)
        }
    }

    private fun sendBlockedNumberChange(action: String, name: String, number: String) {
        val intent = Intent(this, BridgeService::class.java)
            .setAction(BridgeService.ACTION_UI_BLOCKLIST_CHANGE)
            .putExtra(BridgeService.EXTRA_BLOCKLIST_ACTION, action)
            .putExtra(BridgeService.EXTRA_CONTACT_NAME, name)
            .putExtra(BridgeService.EXTRA_PHONE_NUMBER, number)
        ContextCompat.startForegroundService(this, intent)
    }

    private fun renderFromIntent(data: Intent) {
        val number = data.getStringExtra(BridgeService.EXTRA_PHONE_NUMBER).orEmpty()
        val company = data.getStringExtra(BridgeService.EXTRA_COMPANY_NAME).orEmpty()
        val contact = data.getStringExtra(BridgeService.EXTRA_CONTACT_NAME).orEmpty()
        val state = data.getStringExtra(BridgeService.EXTRA_CALL_STATE).orEmpty()
        val micMuted = data.getBooleanExtra(BridgeService.EXTRA_MIC_MUTED, false)
        val speakerOn = data.getBooleanExtra(BridgeService.EXTRA_SPEAKER_ON, false)
        val img = data.getStringExtra(BridgeService.EXTRA_IMAGE_URL).orEmpty()

        companyName.text = when {
            contact.isNotBlank() -> contact
            company.isNotBlank() -> company
            number.isNotBlank() -> number
            else -> "Contacto"
        }
        phoneNumber.text = if (number.isBlank()) "-" else number
        callState.text = when (state) {
            "dialing" -> "LLAMANDO..."
            "in_call" -> "EN LLAMADA"
            "ringing" -> "SONANDO"
            "ended" -> "FINALIZADA"
            "idle" -> "ESPERA"
            else -> "LLAMANDO..."
        }
        applyStateChipStyle(state)
        answerBtn.visibility = if (state == "ringing") View.VISIBLE else View.GONE
        answerBtn.isEnabled = state == "ringing"
        hangupBtn.text = if (state == "ringing") "Rechazar" else "Colgar"
        micBtn.isEnabled = state == "in_call"
        speakerBtn.isEnabled = state in setOf("dialing", "ringing", "in_call")
        messageBtn.isEnabled = state in setOf("dialing", "ringing", "in_call")
        blockBtn.isEnabled = state in setOf("dialing", "ringing", "in_call")
        messageBtn.visibility = if (state in setOf("dialing", "ringing", "in_call")) View.VISIBLE else View.GONE
        blockBtn.visibility = if (state in setOf("dialing", "ringing", "in_call")) View.VISIBLE else View.GONE
        updateBlockButtonState(number)

        if (state == "in_call") {
            if (callStartedAt == null) callStartedAt = System.currentTimeMillis()
            timerHandler.removeCallbacks(timerRunnable)
            timerHandler.post(timerRunnable)
        } else {
            callStartedAt = null
            timerHandler.removeCallbacks(timerRunnable)
            callTimer.text = "00:00"
        }

        micBtn.text = if (micMuted) "Activar micrófono" else "Silenciar"
        speakerBtn.text = if (speakerOn) "Quitar altavoz" else "Altavoz"
        applyToggleStyles(micMuted, speakerOn)

        if (img.isNotBlank() && img != imageUrl) {
            imageUrl = img
            loadImage(img)
        }

        if (state == "idle" || state == "ended") finish()
    }

    private fun updateBlockButtonState(number: String) {
        if (number.isBlank()) {
            blockBtn.text = "Bloquear"
            return
        }
        blockBtn.text = if (BlockedNumberStore.contains(this, number)) "Bloqueado" else "Bloquear"
    }

    private fun applyToggleStyles(micMuted: Boolean, speakerOn: Boolean) {
        micBtn.background = ContextCompat.getDrawable(
            this,
            if (micMuted) R.drawable.bg_danger_button else R.drawable.bg_secondary_button
        )
        micBtn.setTextColor(
            ContextCompat.getColor(this, if (micMuted) R.color.vc_text_inverse else R.color.vc_text_primary)
        )

        speakerBtn.background = ContextCompat.getDrawable(
            this,
            if (speakerOn) R.drawable.bg_success_button else R.drawable.bg_secondary_button
        )
        speakerBtn.setTextColor(
            ContextCompat.getColor(this, if (speakerOn) R.color.vc_text_inverse else R.color.vc_text_primary)
        )
    }

    private fun applyStateChipStyle(state: String) {
        val bgRes = when (state) {
            "in_call" -> R.drawable.bg_status_success
            "ringing", "dialing" -> R.drawable.bg_status_warning
            "ended" -> R.drawable.bg_status_error
            else -> R.drawable.bg_state_chip
        }
        val colorRes = when (state) {
            "in_call" -> R.color.vc_success
            "ringing", "dialing" -> R.color.vc_warning
            "ended" -> R.color.vc_error
            else -> R.color.vc_text_secondary
        }
        callState.background = ContextCompat.getDrawable(this, bgRes)
        callState.setTextColor(ContextCompat.getColor(this, colorRes))
    }

    private fun loadImage(url: String) {
        Thread {
            try {
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                    doInput = true
                }
                conn.inputStream.use { stream ->
                    val bmp = BitmapFactory.decodeStream(stream)
                    if (bmp != null) runOnUiThread { companyImage.setImageBitmap(bmp) }
                }
                conn.disconnect()
            } catch (_: Exception) {
                // Keep default drawable when remote image is unavailable.
            }
        }.start()
    }
}
