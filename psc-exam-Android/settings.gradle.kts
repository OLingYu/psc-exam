pluginManagement {
    repositories {
        // 国内网络下 dl.google.com 稳定可达；plugins.gradle.org 用于 Kotlin 插件标记
        maven { url = uri("https://dl.google.com/dl/android/maven2/") }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        maven { url = uri("https://dl.google.com/dl/android/maven2/") }
        mavenCentral()
    }
}

rootProject.name = "psc-exam-android"
include(":app")
