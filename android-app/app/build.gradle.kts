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
        buildConfigField("String", "DEFAULT_BASE_URL", "\"https://llamada.viacomunicativa.com\"")

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
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            manifestPlaceholders["cleartextTraffic"] = "false"
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
    val modelUrl = "https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip"
    inputs.property("modelUrl", modelUrl)
    outputs.file(spanishModelArchive)
    doLast {
        val archive = spanishModelArchive.get().asFile
        archive.parentFile.mkdirs()
        val temporary = File(archive.parentFile, archive.name + ".tmp")
        try {
            val connection = URI(modelUrl).toURL().openConnection() as javax.net.ssl.HttpsURLConnection
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
