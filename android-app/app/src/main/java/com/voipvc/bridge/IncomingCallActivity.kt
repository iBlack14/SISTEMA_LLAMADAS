package com.voipvc.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.BitmapFactory
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
    private lateinit var screenTitle: TextView
    private lateinit var screenHint: TextView
    private lateinit var headerSubtitle: TextView
    private lateinit var callTopSpacer: View
    private lateinit var callTimer: TextView
    private lateinit var audioControlsRow: View
    private lateinit var contactActionsRow: View
    private lateinit var ringingActionsRow: View
    private lateinit var callActionsRow: View
    private lateinit var micBtn: MaterialButton
    private lateinit var speakerBtn: MaterialButton
    private lateinit var messageBtn: MaterialButton
    private lateinit var blockBtn: MaterialButton
    private lateinit var answerBtn: MaterialButton
    private lateinit var hangupBtn: MaterialButton
    private lateinit var endCallBtn: MaterialButton
    private lateinit var quoteBtn: MaterialButton

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
            callTimer.text = String.format(Locale.US, "%02d:%02d · EN LLAMADA", mm, ss)
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
        screenTitle = findViewById(R.id.callScreenTitle)
        screenHint = findViewById(R.id.callScreenHint)
        headerSubtitle = findViewById(R.id.headerCallSubtitle)
        callTopSpacer = findViewById(R.id.callTopSpacer)
        callTimer = findViewById(R.id.callTimerText)
        audioControlsRow = findViewById(R.id.audioControlsRow)
        contactActionsRow = findViewById(R.id.contactActionsRow)
        ringingActionsRow = findViewById(R.id.ringingActionsRow)
        callActionsRow = findViewById(R.id.callActionsRow)
        micBtn = findViewById(R.id.micButton)
        speakerBtn = findViewById(R.id.speakerButton)
        messageBtn = findViewById(R.id.messageButton)
        blockBtn = findViewById(R.id.blockButton)
        answerBtn = findViewById(R.id.answerButton)
        hangupBtn = findViewById(R.id.hangupButton)
        endCallBtn = findViewById(R.id.endCallButton)
        quoteBtn = findViewById(R.id.quoteButton)

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
            val name = companyName.text.toString().ifBlank { number }
            val intent = Intent(this, BridgeService::class.java)
                .setAction(BridgeService.ACTION_UI_SAVE_MESSAGE_CONTACT)
                .putExtra(BridgeService.EXTRA_CONTACT_NAME, name)
                .putExtra(BridgeService.EXTRA_PHONE_NUMBER, number)
            ContextCompat.startForegroundService(this, intent)
        }
        quoteBtn.setOnClickListener {
            val number = phoneNumber.text.toString().takeIf { it != "-" } ?: return@setOnClickListener
            val name = companyName.text.toString().ifBlank { number }
            val intent = Intent(this, BridgeService::class.java)
                .setAction(BridgeService.ACTION_UI_QUOTE_REQUEST)
                .putExtra(BridgeService.EXTRA_CONTACT_NAME, name)
                .putExtra(BridgeService.EXTRA_PHONE_NUMBER, number)
            ContextCompat.startForegroundService(this, intent)
            Toast.makeText(this, "Cotización enviada al panel web", Toast.LENGTH_SHORT).show()
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
        val hangupCurrentCall = {
            if (telecomUi) VoipVcInCallService.disconnectCall(phoneNumber.text.toString().let { if (it == "-") "" else it })
            else sendServiceAction(BridgeService.ACTION_UI_HANGUP)
        }
        hangupBtn.setOnClickListener { hangupCurrentCall() }
        endCallBtn.setOnClickListener { hangupCurrentCall() }

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
        val initials = companyName.text.toString().trim().split(Regex("\\s+")).take(2)
            .mapNotNull { it.firstOrNull()?.toString() }.joinToString("")
        findViewById<TextView>(R.id.companyInitials).apply {
            text = initials.ifBlank { "VC" }.uppercase(Locale.getDefault())
            visibility = View.VISIBLE
        }
        phoneNumber.text = if (number.isBlank()) "-" else number
        callState.text = when (state) {
            "dialing" -> "LLAMANDO..."
            "in_call" -> "EN LLAMADA"
            "ringing" -> "LLAMADA ENTRANTE"
            "ended" -> "FINALIZADA"
            "idle" -> "ESPERA"
            else -> "LLAMANDO..."
        }
        findViewById<TextView>(R.id.headerCallStatus).apply {
            text = when (state) {
                "ringing" -> "SONANDO"
                "dialing" -> "LLAMANDO"
                "in_call" -> "CONECTADA"
                else -> "VOIP VC"
            }
            val tint = when (state) {
                "ringing", "dialing" -> R.color.vc_warning
                "in_call" -> R.color.vc_success
                else -> R.color.vc_text_secondary
            }
            setTextColor(ContextCompat.getColor(this@IncomingCallActivity, tint))
            setBackgroundResource(when (state) {
                "ringing", "dialing" -> R.drawable.bg_status_warning
                "in_call" -> R.drawable.bg_status_success
                else -> R.drawable.bg_state_chip
            })
        }
        applyStateChipStyle(state)
        val ringing = state == "ringing"
        callTopSpacer.layoutParams = callTopSpacer.layoutParams.apply {
            height = dp(if (ringing) 0 else if (state == "in_call") 112 else 80)
        }
        companyImage.layoutParams = (companyImage.layoutParams as android.widget.LinearLayout.LayoutParams).apply {
            topMargin = dp(if (ringing) 42 else 0)
        }
        screenTitle.visibility = if (ringing) View.VISIBLE else View.GONE
        screenHint.visibility = if (ringing) View.VISIBLE else View.GONE
        headerSubtitle.text = if (ringing) "Llamada entrante" else "Controles de llamada"
        val callControlsAvailable = state in setOf("dialing", "in_call")
        val liveCall = ringing || callControlsAvailable
        answerBtn.visibility = if (ringing) View.VISIBLE else View.GONE
        answerBtn.isEnabled = state == "ringing"
        hangupBtn.text = if (state == "ringing") "Rechazar" else "Colgar"
        hangupBtn.visibility = if (ringing) View.VISIBLE else View.GONE
        audioControlsRow.visibility = if (ringing || !liveCall) View.GONE else View.VISIBLE
        contactActionsRow.visibility = if (callControlsAvailable) View.VISIBLE else View.GONE
        ringingActionsRow.visibility = if (ringing) View.VISIBLE else View.GONE
        callActionsRow.visibility = if (callControlsAvailable) View.VISIBLE else View.GONE
        callTimer.visibility = if (state == "in_call") View.VISIBLE else View.GONE
        callState.visibility = if (state == "in_call") View.GONE else View.VISIBLE
        callTimer.text = if (state == "in_call") "00:00 · EN LLAMADA" else "00:00"
        callTimer.setBackgroundResource(if (state == "in_call") R.drawable.bg_status_success else 0)
        callTimer.setTextColor(ContextCompat.getColor(
            this,
            if (state == "in_call") R.color.vc_success else R.color.vc_text_primary
        ))
        if (state == "in_call") callTimer.setPadding(dp(12), dp(8), dp(12), dp(8))
        else callTimer.setPadding(0, 0, 0, 0)
        endCallBtn.isEnabled = callControlsAvailable
        quoteBtn.visibility = if (state == "in_call") View.VISIBLE else View.GONE
        micBtn.isEnabled = state == "in_call"
        speakerBtn.isEnabled = liveCall
        messageBtn.isEnabled = callControlsAvailable
        blockBtn.isEnabled = callControlsAvailable
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

        if (img.isBlank()) {
            companyImage.visibility = View.GONE
        } else if (img != imageUrl) {
            imageUrl = img
            companyImage.visibility = View.GONE
            loadImage(img)
        } else if (companyImage.drawable != null) {
            companyImage.visibility = View.VISIBLE
            findViewById<TextView>(R.id.companyInitials).visibility = View.GONE
        }

        if (state == "idle" || state == "ended") finish()
    }

    private fun updateBlockButtonState(number: String) {
        val blocked = number.isNotBlank() && BlockedNumberStore.contains(this, number)
        blockBtn.text = if (blocked) "Desbloquear" else "Bloquear"
        blockBtn.background = ContextCompat.getDrawable(
            this,
            if (blocked) R.drawable.bg_secondary_button else R.drawable.bg_danger_soft
        )
        blockBtn.setTextColor(ContextCompat.getColor(
            this,
            if (blocked) R.color.vc_text_primary else R.color.vc_error
        ))
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
                    if (bmp != null) runOnUiThread {
                        companyImage.setImageBitmap(bmp)
                        companyImage.visibility = View.VISIBLE
                        findViewById<TextView>(R.id.companyInitials).visibility = View.GONE
                    }
                }
                conn.disconnect()
            } catch (_: Exception) {
                // Keep default drawable when remote image is unavailable.
            }
        }.start()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
