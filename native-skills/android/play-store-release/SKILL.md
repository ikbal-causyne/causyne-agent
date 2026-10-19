---
name: play-store-release
description: Prepare an Android release for the Play Store. Use when building a release bundle, when a submission is rejected, or when setting up signing.
---

# Play Store Release

## Workflow

1. Build an app bundle, not an APK.
   - The store requires it and it produces per-device downloads that are substantially smaller. Test the bundle with the bundle tool so you exercise what users will actually install, not a universal APK.
   - **Done when:** a device-specific APK generated from the bundle installs and runs.

2. Get signing right and keep it recoverable.
   - Enrol in Play App Signing so the upload key can be rotated if lost. Losing the signing key without it means the app can never be updated — a new listing is the only path.
   - The keystore and its passwords never enter version control.
   - **Done when:** signing config reads credentials from outside the repository and the release build is verified signed.

3. Match the version codes to the release.
   - Version code strictly increasing, version name meaningful to a human. A duplicate code is rejected at upload.
   - **Done when:** the code is higher than every previously uploaded build.

4. Test the minified build, not the debug one.
   - Minification removes code reached only by reflection. Serialisation, dependency injection and any reflective library need keep rules, and the crash appears only in release.
   - **Done when:** the release build has been exercised through every major flow on a real device.

5. Complete the declarations honestly.
   - Data safety, permissions, target API level, and the declaration for any sensitive permission. These are the most common rejection causes, and an inaccurate data safety form is a policy violation rather than a formatting error.
   - **Done when:** every declared item matches what the code actually does.

6. Stage the rollout.
   - Internal testing, then a small percentage. Watch the crash rate before widening. A full rollout of a broken build reaches everyone before the first report arrives.
   - **Done when:** the release starts below full rollout with a stated widening criterion.

7. Upload the mapping file.
   - Without it every release crash report is unreadable.
   - **Done when:** deobfuscation is confirmed on a test crash.

## Verification

- The bundle uploads and passes pre-launch checks.
- A minified build passes a full manual pass on a physical device.
- A test crash appears deobfuscated in the console.
