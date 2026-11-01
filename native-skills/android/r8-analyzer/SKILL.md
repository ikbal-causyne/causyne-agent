---
name: r8-analyzer
description: Analyze, configure, and troubleshoot R8 minification and ProGuard keep rules. Use when a release build crashes with ClassNotFoundException, NoSuchMethodError, or reflection failures.
---

# Android R8 and ProGuard Minification Rules

Configure R8 shrinking, obfuscation, and resource optimization while preserving reflection-based libraries, serialization schemas, and native JNI bindings.

## Workflow

1. Enable shrinking and configure rule files.
   - In `app/build.gradle.kts`, enable `isMinifyEnabled = true` and `isShrinkResources = true` in the `release` build type.
   - Reference standard Android default rules and project rules:
     `proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")`.
   - **Done when:** release build compiles with R8 shrinking active.

2. Preserve data classes and serialization schemas.
   - Add keep rules for classes serialized via Gson, Moshi, or Kotlinx Serialization:
     `-keepclassmembers class * { @com.google.gson.annotations.SerializedName <fields>; }`
     `-keep,allowobfuscation,allowshrinking class com.example.models.** { *; }`.
   - Keep enum values and Serializable classes from being stripped or renamed improperly.
   - **Done when:** JSON serialization and deserialization function identically between debug and release variants.

3. Preserve native JNI bindings and reflection entrypoints.
   - Keep classes and methods called via JNI from C/C++ code:
     `-keepclasseswithmembernames class * { native <methods>; }`.
   - Keep custom View constructors invoked by XML layout inflation:
     `-keep public class * extends android.view.View { public <init>(android.content.Context); public <init>(android.content.Context, android.util.AttributeSet); }`.
   - **Done when:** custom views inflate properly and JNI native calls link without UnsatisfiedLinkError.

4. Inspect R8 mapping and usage artifacts.
   - Inspect `app/build/outputs/mapping/release/usage.txt` to verify which classes and methods were removed.
   - Inspect `app/build/outputs/mapping/release/mapping.txt` to deobfuscate crash traces reported in production.
   - Use `./gradlew checkReleaseDuplicateClasses` to detect dependency clashes.
   - **Done when:** `usage.txt` confirms expected removals and `mapping.txt` is retained for crash deobfuscation.

## Verification

- The release APK builds successfully and is significantly smaller than the unminified debug APK.
- Launching the release APK on a device triggers no `ClassNotFoundException` or `NoSuchMethodError`.
- Crash traces can be remapped to original line numbers using `retrace` and `mapping.txt`.
