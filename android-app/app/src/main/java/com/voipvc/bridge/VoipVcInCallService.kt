package com.voipvc.bridge

import android.content.Intent
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import androidx.core.app.NotificationCompat
import android.os.Build
import android.telecom.Call
import android.telecom.InCallService
import android.telecom.VideoProfile
import android.util.Log

class VoipVcInCallService : InCallService() {
    companion object {
        private const val TAG = "VoipVcInCallService"

        @Volatile
        private var activeService: VoipVcInCallService? = null

        fun answerRingingCall(): Boolean {
            val service = activeService ?: return false
            val ringingCall = service.calls.firstOrNull { it.state == Call.STATE_RINGING } ?: return false
            return try {
                ringingCall.answer(VideoProfile.STATE_AUDIO_ONLY)
                true
            } catch (e: Exception) {
                Log.w(TAG, "Failed to answer incoming call: ${e.message}")
                false
            }
        }

        fun currentCallIntent(): Intent? = activeService?.let { service ->
            val call = service.calls.firstOrNull { it.state == Call.STATE_RINGING }
                ?: liveCalls().firstOrNull() ?: return@let null
            service.presentationIntent(call, service.mapCallState(call.state))
        }

        fun toggleMute(): Boolean? {
            val service = activeService ?: return null
            val muted = !(service.callAudioState?.isMuted ?: false)
            service.setMuted(muted)
            return muted
        }

        fun setSpeaker(enabled: Boolean): Boolean {
            val service = activeService ?: return false
            return try {
                service.setAudioRoute(if (enabled) android.telecom.CallAudioState.ROUTE_SPEAKER
                    else android.telecom.CallAudioState.ROUTE_WIRED_OR_EARPIECE)
                true
            } catch (e: Exception) {
                Log.w(TAG, "Cannot route call audio", e)
                false
            }
        }

        fun toggleSpeaker(): Boolean? {
            val service = activeService ?: return null
            val speaker = service.callAudioState?.route != android.telecom.CallAudioState.ROUTE_SPEAKER
            return if (setSpeaker(speaker)) speaker else null
        }

        fun isTrackingCalls(): Boolean = liveCalls().isNotEmpty()

        fun hasLiveCall(phoneNumber: String): Boolean = findLiveCall(phoneNumber) != null

        fun isCallDefinitelyAbsent(phoneNumber: String): Boolean {
            if (activeService == null) return false
            val calls = liveCalls()
            if (calls.isEmpty()) return true
            val expected = normalizeNumber(phoneNumber)
            if (expected.isBlank()) return false
            if (calls.any {
                    normalizeNumber(it.details.handle?.schemeSpecificPart.orEmpty()) == expected
                }) return false
            // We can distinguish unrelated calls only when every live handle is
            // visible; a hidden/empty number remains ambiguous and must block.
            return calls.all {
                normalizeNumber(it.details.handle?.schemeSpecificPart.orEmpty()).isNotBlank()
            }
        }

        fun disconnectCall(phoneNumber: String): Boolean {
            val call = findLiveCall(phoneNumber) ?: return false
            return try {
                call.disconnect()
                true
            } catch (e: Exception) {
                Log.w(TAG, "Failed to disconnect call: ${e.message}")
                false
            }
        }

        private fun findLiveCall(phoneNumber: String): Call? {
            val liveCalls = liveCalls()
            val expected = normalizeNumber(phoneNumber)
            if (expected.isBlank()) return liveCalls.singleOrNull()
            return liveCalls.firstOrNull {
                normalizeNumber(it.details.handle?.schemeSpecificPart.orEmpty()) == expected
            }
        }

        private fun liveCalls(): List<Call> = activeService?.calls?.filter {
            it.state != Call.STATE_DISCONNECTED && it.state != Call.STATE_DISCONNECTING
        }.orEmpty()

        private fun normalizeNumber(value: String): String {
            var digits = value.filter(Char::isDigit)
            if (digits.length == 11 && digits.startsWith("51")) digits = digits.drop(2)
            return digits
        }
    }

    private val callbacks = mutableMapOf<Call, Call.Callback>()
    private val callDirections = mutableMapOf<Call, String>()
    private var lastBroadcastSignature = ""
    private var analyzedCall: Call? = null

    override fun onCreate() {
        super.onCreate()
        activeService = this
        VoicemailDetector.initialize(this)
    }

    override fun onDestroy() {
        VoicemailDetector.stop()
        if (activeService === this) activeService = null
        super.onDestroy()
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        setSpeaker(true)
        val cb = object : Call.Callback() {
            override fun onStateChanged(call: Call, state: Int) {
                val mapped = mapCallState(state)
                if (state == Call.STATE_ACTIVE || state == Call.STATE_DIALING) {
                    setSpeaker(true)
                    // Some networks expose no downlink during dialing. Retry once connected.
                    if (state == Call.STATE_ACTIVE && analyzedCall === call) {
                        VoicemailDetector.stop()
                        analyzedCall = null
                    }
                    analyzeOutgoingCall(call)
                } else if (analyzedCall === call) {
                    VoicemailDetector.stop()
                    analyzedCall = null
                }
                // Do not let another ringing/active call hide the terminal
                // event of the campaign call that just disconnected.
                if (mapped == "ended") broadcastCallState(call, mapped)
                else broadcastAggregateState()
            }

            override fun onDetailsChanged(call: Call, details: Call.Details) {
                analyzeOutgoingCall(call)
                broadcastAggregateState()
            }
        }
        callbacks[call] = cb
        call.registerCallback(cb)
        analyzeOutgoingCall(call)
        broadcastAggregateState()
    }

    override fun onCallAudioStateChanged(audioState: android.telecom.CallAudioState) {
        super.onCallAudioStateChanged(audioState)
        broadcastAggregateState()
    }

    override fun onCallRemoved(call: Call) {
        if (analyzedCall === call) { VoicemailDetector.stop(); analyzedCall = null }
        callbacks.remove(call)?.let { call.unregisterCallback(it) }
        broadcastAggregateState()
        callDirections.remove(call)
        super.onCallRemoved(call)
    }

    private fun analyzeOutgoingCall(call: Call) {
        if (Build.VERSION.SDK_INT < 31 || call.state !in setOf(Call.STATE_ACTIVE, Call.STATE_DIALING) ||
            call.details.callDirection != Call.Details.DIRECTION_OUTGOING ||
            analyzedCall === call || !VoicemailDetector.enabled()) return
        val live = calls.filter { it.state != Call.STATE_DISCONNECTED && it.state != Call.STATE_DISCONNECTING }
        if (live.size != 1) return
        analyzedCall = call
        VoicemailDetector.start { _, resultCode ->
            if (analyzedCall !== call || call.state !in setOf(Call.STATE_ACTIVE, Call.STATE_DIALING) ||
                !calls.contains(call) || calls.count {
                    it.state != Call.STATE_DISCONNECTED && it.state != Call.STATE_DISCONNECTING
                } != 1) return@start
            val number = call.details.handle?.schemeSpecificPart.orEmpty()
            // This exact Call object is checked again before requesting the cut.
            sendBroadcast(Intent(BridgeService.ACTION_TELECOM_CALL_STATE).setPackage(packageName)
                .putExtra(BridgeService.EXTRA_CALL_STATE, mapCallState(call.state))
                .putExtra(BridgeService.EXTRA_PHONE_NUMBER, number)
                .putExtra(BridgeService.EXTRA_CALL_DIRECTION, "outgoing")
                .putExtra("detected_voicemail", resultCode == "buzon_de_voz")
                .putExtra("detected_announcement", resultCode))
            try {
                call.disconnect()
                Log.i(TAG, "Voicemail phrase matched; disconnect requested for current outgoing call")
            } catch (e: SecurityException) {
                Log.e(TAG, "Voicemail detected but Android denied disconnect", e)
            }
        }
    }

    private fun mapCallState(state: Int): String = when (state) {
        Call.STATE_ACTIVE, Call.STATE_HOLDING -> "in_call"
        Call.STATE_RINGING -> "ringing"
        Call.STATE_DIALING, Call.STATE_CONNECTING, Call.STATE_SELECT_PHONE_ACCOUNT, Call.STATE_NEW -> "dialing"
        Call.STATE_DISCONNECTED, Call.STATE_DISCONNECTING -> "ended"
        else -> "idle"
    }

    private fun broadcastAggregateState() {
        val activeCall = calls.firstOrNull { mapCallState(it.state) == "in_call" }
        val ringingCall = calls.firstOrNull { mapCallState(it.state) == "ringing" }
        val dialingCall = calls.firstOrNull { mapCallState(it.state) == "dialing" }
        val endedCall = calls.firstOrNull { mapCallState(it.state) == "ended" }

        val primaryCall = ringingCall ?: activeCall ?: dialingCall ?: endedCall
        val mapped = when {
            ringingCall != null -> "ringing"
            activeCall != null -> "in_call"
            dialingCall != null -> "dialing"
            endedCall != null -> "ended"
            else -> "idle"
        }

        broadcastCallState(primaryCall, mapped)
        updateCallPresentation(primaryCall, mapped)
    }

    private fun presentationIntent(call: Call, state: String): Intent =
        Intent(this, IncomingCallActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(BridgeService.EXTRA_PHONE_NUMBER, call.details.handle?.schemeSpecificPart.orEmpty())
            .putExtra(BridgeService.EXTRA_CONTACT_NAME, call.details.callerDisplayName.orEmpty())
            .putExtra(BridgeService.EXTRA_CALL_STATE, state)
            .putExtra(BridgeService.EXTRA_SPEAKER_ON,
                callAudioState?.route == android.telecom.CallAudioState.ROUTE_SPEAKER)
            .putExtra("telecom_ui", true)

    private var presentedCall: Call? = null

    private fun updateCallPresentation(call: Call?, state: String) {
        val manager = getSystemService(NotificationManager::class.java)
        if (call == null || state in setOf("idle", "ended")) {
            manager.cancel(2002)
            presentedCall = null
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(
                "phone_calls", "Llamadas del teléfono", NotificationManager.IMPORTANCE_HIGH
            ))
        }
        val pending = PendingIntent.getActivity(this, 2002, presentationIntent(call, state),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, "phone_calls")
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(if (state == "ringing") "Llamada entrante" else "Llamada en curso")
            .setContentText(call.details.handle?.schemeSpecificPart.orEmpty().ifBlank { "Número privado" })
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setOngoing(true)
            .setContentIntent(pending)
            .setFullScreenIntent(pending, state == "ringing")
            .build()
        try { manager.notify(2002, notification) } catch (e: SecurityException) {
            Log.w(TAG, "Call notification unavailable", e)
        }
        if (presentedCall !== call) {
            presentedCall = call
            try { startActivity(presentationIntent(call, state)) } catch (e: Exception) {
                Log.w(TAG, "Call screen unavailable", e)
            }
        }
    }

    private fun callDirection(call: Call?, mapped: String): String {
        if (call == null) return "unknown"
        val observed = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> when (call.details.callDirection) {
                Call.Details.DIRECTION_INCOMING -> "incoming"
                Call.Details.DIRECTION_OUTGOING -> "outgoing"
                else -> "unknown"
            }
            mapped == "ringing" -> "incoming"
            else -> "unknown"
        }
        if (observed != "unknown") callDirections[call] = observed
        return callDirections[call] ?: observed
    }

    private fun broadcastCallState(primaryCall: Call?, mapped: String) {
        val number = primaryCall?.details?.handle?.schemeSpecificPart.orEmpty()
        val callerName = primaryCall?.details?.callerDisplayName?.toString()?.trim().orEmpty()
        val contactName = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            primaryCall?.details?.contactDisplayName?.toString()?.trim().orEmpty()
        } else ""
        val bestName = contactName.ifBlank { callerName }
        val direction = callDirection(primaryCall, mapped)
        val speakerOn = callAudioState?.route == android.telecom.CallAudioState.ROUTE_SPEAKER
        val signature = listOf(mapped, number, bestName, direction, speakerOn.toString()).joinToString("|")
        if (signature == lastBroadcastSignature) return
        lastBroadcastSignature = signature

        sendBroadcast(
            Intent(BridgeService.ACTION_TELECOM_CALL_STATE)
                .setPackage(packageName)
                .putExtra(BridgeService.EXTRA_CALL_STATE, mapped)
                .putExtra(BridgeService.EXTRA_PHONE_NUMBER, number)
                .putExtra(BridgeService.EXTRA_CONTACT_NAME, bestName)
                .putExtra(BridgeService.EXTRA_CALL_DIRECTION, direction)
                .putExtra(BridgeService.EXTRA_SPEAKER_ON, speakerOn)
        )
    }
}
