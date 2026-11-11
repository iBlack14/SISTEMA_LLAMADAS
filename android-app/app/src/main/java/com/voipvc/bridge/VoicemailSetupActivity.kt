package com.voipvc.bridge

import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telecom.TelecomManager
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.google.android.material.button.MaterialButton

class VoicemailSetupActivity : AppCompatActivity() {
    companion object { const val EXTRA_REQUEST_AUTHORIZATION = "request_voicemail_authorization" }
    private lateinit var statusText: TextView
    private lateinit var installButton: MaterialButton
    private val handler = Handler(Looper.getMainLooper())
    private var pendingEnable = false
    private var initialRequestHandled = false
    private var guidanceMessage = ""
    private val refresh = object : Runnable {
        override fun run() {
            if (pendingEnable && Build.VERSION.SDK_INT >= 31 && isDialer() &&
                VoicemailDetector.authorizationIssue() == null) {
                pendingEnable = false
                guidanceMessage = ""
                VoicemailDetector.enable()
            }
            val missingModel = VoicemailModelInstaller.findModel(this@VoicemailSetupActivity) == null
            installButton.visibility = if (missingModel || VoicemailModelInstaller.installing) View.VISIBLE else View.GONE
            installButton.isEnabled = !VoicemailModelInstaller.installing
            installButton.text = if (VoicemailModelInstaller.installing) "Instalando español…" else "Descargar modelo de español (39 MB)"
            statusText.text = guidanceMessage.ifBlank {
                VoicemailModelInstaller.message.ifBlank {
                    if (missingModel) "Falta el modelo de español. Descárgalo con el botón de abajo; después funcionará sin internet."
                    else VoicemailDetector.authorizationIssue() ?: VoicemailDetector.status
                }
            } + if (VoicemailDetector.lastMatch.isNotBlank())
                "\n\nÚltima locución detectada:\n" + VoicemailDetector.lastMatch else ""
            handler.postDelayed(this, 1000)
        }
    }
    private val roleResult = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (isDialer()) authorizeWithShizuku()
        else {
            pendingEnable = false
            guidanceMessage = "Selecciona VOIP VC como aplicación de teléfono para poder cortar la llamada."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initialRequestHandled = savedInstanceState?.getBoolean("initial_request_handled") == true
        pendingEnable = savedInstanceState?.getBoolean("pending_enable") == true
        VoicemailDetector.initialize(this)
        val padding = dp(20)
        val root = ScrollView(this).apply {
            setBackgroundColor(color(R.color.vc_bg))
            isFillViewport = true
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
        }
        root.addView(column)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        fun text(value: String, size: Float, primary: Boolean = false) = TextView(this).apply {
            this.text = value
            textSize = size
            setTextColor(color(if (primary) R.color.vc_text_primary else R.color.vc_text_secondary))
            setLineSpacing(dp(3).toFloat(), 1f)
        }
        column.addView(text("Detección automática de buzón", 24f, true).apply {
            setTypeface(typeface, Typeface.BOLD)
        })
        column.addView(text("Reconoce las locuciones configuradas y solicita colgar para pasar al siguiente número. Solo analiza llamadas salientes.", 16f).apply {
            setPadding(0, dp(14), 0, dp(20))
        })
        statusText = text("", 17f, true).apply {
            setPadding(dp(16), dp(16), dp(16), dp(16))
            background = GradientDrawable().apply {
                setColor(color(R.color.vc_surface))
                cornerRadius = dp(12).toFloat()
                setStroke(dp(1), color(R.color.vc_border))
            }
        }
        column.addView(statusText)
        column.addView(text("Para autorizar: inicia Shizuku y permite el acceso a VOIP VC. Si ya rechazaste el permiso, abre Shizuku y entra en Aplicaciones autorizadas.", 14f).apply {
            setPadding(0, dp(16), 0, dp(8))
        })
        fun button(label: String, primary: Boolean = false, action: () -> Unit): MaterialButton {
            val control = MaterialButton(this).apply {
                this.text = label
                isAllCaps = false
                textSize = 16f
                minHeight = dp(52)
                setTextColor(color(if (primary) R.color.vc_text_inverse else R.color.vc_text_primary))
                backgroundTintList = ColorStateList.valueOf(color(if (primary) R.color.vc_accent else R.color.vc_surface))
                strokeWidth = if (primary) 0 else dp(1)
                strokeColor = ColorStateList.valueOf(color(R.color.vc_border))
                setOnClickListener { action() }
            }
            column.addView(control, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(8)
            })
            return control
        }
        installButton = button("Descargar modelo de español (39 MB)", true) {
            guidanceMessage = ""
            VoicemailModelInstaller.install(this)
        }
        button("Autorizar y activar detección", true) { requestActivation() }
        button("Abrir Shizuku") { pendingEnable = true; openShizuku() }
        button("Desactivar detección") {
            pendingEnable = false
            guidanceMessage = ""
            VoicemailDetector.disable()
        }
        button("Volver") { finish() }
        column.addView(text("El modo rápido puede confundir saludos de centrales. Puedes desactivarlo cuando lo necesites.", 13f).apply {
            setPadding(0, dp(16), 0, 0)
        })
        setContentView(root)
        ViewCompat.requestApplyInsets(root)
    }

    override fun onPostResume() {
        super.onPostResume()
        if (!initialRequestHandled && intent.getBooleanExtra(EXTRA_REQUEST_AUTHORIZATION, false)) {
            initialRequestHandled = true
            requestActivation()
        }
    }

    private fun requestActivation() {
        guidanceMessage = ""
        if (Build.VERSION.SDK_INT < 31) {
            guidanceMessage = "Requiere Android 12 o superior."
            return
        }
        pendingEnable = true
        if (!isDialer()) {
            val roles = getSystemService(RoleManager::class.java)
            if (roles?.isRoleAvailable(RoleManager.ROLE_DIALER) == true)
                roleResult.launch(roles.createRequestRoleIntent(RoleManager.ROLE_DIALER))
            else guidanceMessage = "Este equipo no permite configurar VOIP VC como aplicación de teléfono."
        } else authorizeWithShizuku()
    }

    private fun authorizeWithShizuku() {
        if (VoicemailDetector.authorizationRequiresManager()) {
            guidanceMessage = "El permiso fue rechazado. En Shizuku, abre Aplicaciones autorizadas y permite VOIP VC."
            openShizuku()
        } else VoicemailDetector.enable()
    }

    private fun openShizuku() {
        try {
            startActivity(Intent().setClassName("moe.shizuku.privileged.api", "moe.shizuku.manager.MainActivity"))
        } catch (_: ActivityNotFoundException) {
            guidanceMessage = "Instala Shizuku para autorizar la detección automática."
        } catch (_: SecurityException) {
            guidanceMessage = "Abre Shizuku manualmente y autoriza VOIP VC."
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("initial_request_handled", initialRequestHandled)
        outState.putBoolean("pending_enable", pendingEnable)
        super.onSaveInstanceState(outState)
    }

    override fun onStart() { super.onStart(); handler.post(refresh) }
    override fun onStop() { handler.removeCallbacks(refresh); super.onStop() }
    private fun color(resource: Int) = ContextCompat.getColor(this, resource)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun isDialer(): Boolean =
        getSystemService(TelecomManager::class.java)?.defaultDialerPackage == packageName
}
