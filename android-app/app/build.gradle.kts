import java.util.Properties
import java.io.File
import java.net.URI
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val localSigningProperties = Properties()
val localSigningPropertiesFile = rootProject.file("keystore/signing.properties")
if (localSigningPropertiesFile.isFile) {
    localSigningPropertiesFile.inputStream().use(localSigningProperties::load)
}

val releaseKeystorePath = providers.environmentVariable("VOIP_VC_KEYSTORE_PATH")
    .orElse(localSigningProperties.getProperty(
        "storeFile",
        "${rootProject.projectDir}/keystore/voip-vc-release.jks"
    ))
val releaseStorePassword = providers.environmentVariable("VOIP_VC_KEYSTORE_PASSWORD")
    .orElse(localSigningProperties.getProperty("storePassword", ""))
val releaseKeyAlias = providers.environmentVariable("VOIP_VC_KEY_ALIAS")
    .orElse(localSigningProperties.getProperty("keyAlias", "voip-vc"))
val releaseKeyPassword = providers.environmentVariable("VOIP_VC_KEY_PASSWORD")
    .orElse(localSigningProperties.getProperty("keyPassword", ""))
val generatedVersionCode = providers.environmentVariable("ANDROID_VERSION_CODE")
    .orElse((System.currentTimeMillis() / 1000L).toString())
val generatedVersionName = providers.environmentVariable("ANDROID_VERSION_NAME")
    .orElse("1.1")

val androidEnv = rootProject.file(".env").takeIf { it.isFile }?.readLines()
    ?.mapNotNull { line ->
        val entry = line.trim()
        if (entry.isEmpty() || entry.startsWith("#")) return@mapNotNull null
        val separator = entry.indexOf('=')
        if (separator <= 0) return@mapNotNull null
        val key = entry.substring(0, separator).trim()
        var value = entry.substring(separator + 1).trim()
        if (value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith('\'') && value.endsWith('\'')))) {
            value = value.substring(1, value.length - 1)
        }
        key to value
    }?.toMap().orEmpty()

fun androidBaseUrl(name: String): String {
    val value = providers.environmentVariable(name).orNull?.takeIf { it.isNotBlank() }
        ?: androidEnv[name]?.takeIf { it.isNotBlank() }
        ?: error("Falta $name. Configúralo en android-app/.env o como variable de entorno.")
    val uri = runCatching { URI(value) }.getOrElse {
        error("$name no contiene una URL válida.")
    }
    require(uri.isAbsolute && uri.host != null && uri.userInfo == null &&
        uri.scheme in setOf("http", "https")) {
        "$name debe ser una URL HTTP(S) absoluta sin credenciales."
    }
    return value.trimEnd('/')
}

fun buildConfigString(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val developmentBaseUrl = androidBaseUrl("ANDROID_DEV_BASE_URL")
val productionBaseUrl = androidBaseUrl("ANDROID_PROD_BASE_URL")
val spanishModelUrl = androidBaseUrl("ANDROID_VOSK_MODEL_URL")
require(URI(productionBaseUrl).scheme == "https") {
    "ANDROID_PROD_BASE_URL debe usar HTTPS."
}
require(URI(spanishModelUrl).scheme == "https") {
    "ANDROID_VOSK_MODEL_URL debe usar HTTPS."
}

android {
    namespace = "com.voipvc.bridge"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.voipvc.bridge"
        minSdk = 24
        targetSdk = 35
        // Un valor creciente permite que Android instale cada APK como actualización.
        versionCode = generatedVersionCode.get().toInt()
        versionName = generatedVersionName.get()
        manifestPlaceholders["cleartextTraffic"] = "false"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("release") {
            storeFile = file(releaseKeystorePath.get())
            storePassword = releaseStorePassword.orNull
            keyAlias = releaseKeyAlias.get()
            keyPassword = releaseKeyPassword.orNull
        }
    }

    buildTypes {
        debug {
            manifestPlaceholders["cleartextTraffic"] = "true"
            buildConfigField("String", "DEFAULT_BASE_URL", buildConfigString(developmentBaseUrl))
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            manifestPlaceholders["cleartextTraffic"] = "false"
            buildConfigField("String", "DEFAULT_BASE_URL", buildConfigString(productionBaseUrl))
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    kotlinOptions { 
        jvmTarget = "17"
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
    implementation("com.alphacephei:vosk-android:0.3.75@aar")
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.2.0")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")

    implementation("io.socket:socket.io-client:2.1.1") {
        exclude(group = "org.json", module = "json")
    }
}

base {
    archivesName.set("VOIP-VC")
}

// The build fetches the official archive once. Every APK carries the model,
// including release builds; the phone only extracts it and needs no download.
val spanishModelAssets = layout.buildDirectory.dir("generated/spanish-model-assets")
val spanishModelArchive = spanishModelAssets.map { it.file("models/vosk-model-small-es-0.42.zip") }
android.sourceSets.getByName("main").assets.srcDir(spanishModelAssets)
val prepareSpanishModel = tasks.register("prepareSpanishModel") {
    inputs.property("modelUrl", spanishModelUrl)
    outputs.file(spanishModelArchive)
    doLast {
        val archive = spanishModelArchive.get().asFile
        archive.parentFile.mkdirs()
        val temporary = File(archive.parentFile, archive.name + ".tmp")
        try {
            val connection = URI(spanishModelUrl).toURL().openConnection() as javax.net.ssl.HttpsURLConnection
            connection.connectTimeout = 30000
            connection.readTimeout = 60000
            connection.instanceFollowRedirects = false
            try {
                check(connection.responseCode == 200) { "No se pudo obtener el modelo oficial: HTTP ${connection.responseCode}" }
                var total = 0L
                connection.inputStream.use { source ->
                    temporary.outputStream().use { destination ->
                        val buffer = ByteArray(32768)
                        while (true) {
                            val count = source.read(buffer)
                            if (count < 0) break
                            total += count
                            check(total <= 100L * 1024 * 1024) { "El modelo excede el tamaño esperado." }
                            destination.write(buffer, 0, count)
                        }
                    }
                }
            } finally { connection.disconnect() }
            ZipFile(temporary).use { zip ->
                listOf("am/final.mdl", "conf/model.conf").forEach { required ->
                    check(zip.getEntry("vosk-model-small-es-0.42/" + required) != null) { "Modelo español incompleto." }
                }
            }
            Files.move(temporary.toPath(), archive.toPath(), StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
    }
}
tasks.named("preBuild").configure { dependsOn(prepareSpanishModel) }

tasks.matching { it.name == "assembleRelease" || it.name == "bundleRelease" }.configureEach {
    doFirst {
        require(file(releaseKeystorePath.get()).isFile) {
            "Falta el keystore estable: ${releaseKeystorePath.get()}"
        }
        require(releaseStorePassword.orNull?.isNotBlank() == true) {
            "Falta VOIP_VC_KEYSTORE_PASSWORD"
        }
        require(releaseKeyPassword.orNull?.isNotBlank() == true) {
            "Falta VOIP_VC_KEY_PASSWORD"
        }
    }
}
