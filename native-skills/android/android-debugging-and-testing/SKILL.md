---
name: android-debugging-and-testing
description: Diagnose, debug, install, and verify Android applications and emulators via ADB. Use when deploying APKs, handling multiple emulators, resolving exit codes, or analyzing app crashes.
---

# Android Debugging and Device Testing

Diagnose runtime issues, stream-install APKs, launch activities, and capture crash forensics on connected Android devices and emulators.

## Workflow

1. Query attached devices and lock the target serial.
   - Run `adb devices -l` before executing device commands.
   - When more than one device or emulator is present (for example `emulator-5554` and `emulator-5556`), always set `export ANDROID_SERIAL=<serial>` or include `-s <serial>` in every `adb` command to prevent `adb: more than one device/emulator` errors.
   - **Done when:** `adb -s <serial> get-state` returns `device`.

2. Perform streamed package installation.
   - Run `adb -s <serial> install -r -d -t <path/to/app-debug.apk>`.
   - Flags: `-r` replaces existing application while preserving data, `-d` allows version code downgrade, `-t` allows test APKs.
   - Check standard output for `Success`. If `INSTALL_FAILED_ALREADY_EXISTS` occurs, use `-r` or uninstall first via `adb -s <serial> uninstall <package>`.
   - **Done when:** `adb install` output explicitly returns `Performing Streamed Install` and `Success`.

3. Launch and verify foreground Activity lifecycle.
   - Run `adb -s <serial> shell am start -n <package>/<activity>`.
   - Do not rely on chaining `sleep && pidof` in compound expressions, as timing differences cause exit code 1. Instead, query the activity manager directly:
     `adb -s <serial> shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"`
   - Confirm the target activity matches the resumed activity record.
   - **Done when:** `dumpsys activity` confirms the target Activity is topResumedActivity in the foreground.

4. Capture logcat crash traces and ANR logs.
   - Run `adb -s <serial> logcat -b crash -d` to inspect recent uncaught exceptions and native aborts.
   - Run `adb -s <serial> logcat -d --pid=$(adb -s <serial> shell pidof <package>)` to inspect logs scoped to the app process.
   - Check `/data/anr/traces.txt` via `adb -s <serial> shell "ls -t /data/anr/ 2>/dev/null"` if the application encounters an Application Not Responding freeze.
   - **Done when:** stack traces and FATAL EXCEPTION logs are extracted with offending file names and line numbers.

5. Configure port forwarding and network proxying when required.
   - Use `adb -s <serial> reverse tcp:<port> tcp:<port>` so the emulator can access local host development servers running on `localhost:<port>`.
   - **Done when:** `adb reverse --list` confirms port mapping between emulator and host.

## Verification

- `adb devices` confirms the target device is online and responsive.
- The APK installs with `Success` without signature or manifest errors.
- `dumpsys activity` confirms the app is running in the foreground.
- `adb logcat -b crash -d` outputs zero unhandled exceptions.
