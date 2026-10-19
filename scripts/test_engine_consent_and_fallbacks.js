import { manageLocalDependencies } from '../src/tools/manageLocalAiDependencies.js';
import { godotAutomator } from '../src/tools/godotAutomator.js';
import { blenderAct } from '../src/tools/blenderAutomator.js';

async function runTests() {
  console.log('🧪 Starting Phase 9.3 Engine Size Consent & Fallback Cascade Verification...\n');
  let passed = 0;
  let failed = 0;

  // Test 1: Godot Size Check (<= 200 MB threshold, simulateMissing=true)
  console.log('TEST 1: Godot Auto-Discovery Check (simulateMissing=true against 200 MB Consent Gate)...');
  const godotRes = await manageLocalDependencies.execute({
    action: 'check_and_install_engine',
    engine: 'godot',
    simulateMissing: true
  });
  if (godotRes.success && godotRes.status === 'installed') {
    console.log('✅ TEST 1 PASSED: Godot (~135 MB <= 200 MB threshold) auto-approved cleanly.');
    passed++;
  } else {
    console.error('❌ TEST 1 FAILED:', godotRes);
    failed++;
  }

  // Test 2: Blender Size Gate (> 200 MB threshold without consent)
  console.log('\nTEST 2: Blender Enterprise Consent Gate Check (~312 MB without userConsent)...');
  const blenderNoConsent = await manageLocalDependencies.execute({
    action: 'check_and_install_engine',
    engine: 'blender',
    simulateMissing: true
  });
  if (!blenderNoConsent.success && blenderNoConsent.status === 'approval_required' && blenderNoConsent.sizeMB === 312) {
    console.log('✅ TEST 2 PASSED: Blender blocked accurately with [APPROVAL_REQUIRED] (312 MB > 200 MB threshold).');
    passed++;
  } else {
    console.error('❌ TEST 2 FAILED:', blenderNoConsent);
    failed++;
  }

  // Test 3: Blender Size Gate (> 200 MB threshold WITH explicit userConsent: true)
  console.log('\nTEST 3: Blender Enterprise Consent Gate Check (~312 MB WITH userConsent: true)...');
  const blenderWithConsent = await manageLocalDependencies.execute({
    action: 'check_and_install_engine',
    engine: 'blender',
    simulateMissing: true,
    userConsent: true
  });
  if (blenderWithConsent.success && blenderWithConsent.status === 'installed') {
    console.log('✅ TEST 3 PASSED: Blender installation allowed when userConsent: true is passed.');
    passed++;
  } else {
    console.error('❌ TEST 3 FAILED:', blenderWithConsent);
    failed++;
  }

  // Test 4: Godot Automator Sovereign Fallback Cascade (simulateMissing: true)
  console.log('\nTEST 4: Godot Automator Sovereign Fallback Cascade (simulateMissing: true on headless_run)...');
  const godotFallback = await godotAutomator.execute({
    action: 'headless_run',
    scriptPath: 'print("hello")',
    simulateMissing: true
  });
  if (!godotFallback.success && godotFallback.status === 'fallback_required' && godotFallback.fallback_guidance) {
    console.log('✅ TEST 4 PASSED: Godot Automator returned structured fallback guidance routing to system.dependencies_manage or game.build_html5.');
    passed++;
  } else {
    console.error('❌ TEST 4 FAILED:', godotFallback);
    failed++;
  }

  // Test 5: Blender Automator Sovereign Fallback Cascade (simulateMissing: true on actions)
  console.log('\nTEST 5: Blender Automator Sovereign Fallback Cascade (simulateMissing: true on execute)...');
  const blenderFallback = await blenderAct.execute({
    simulateMissing: true,
    actions: [{ type: 'autoFrameCamera' }]
  });
  if (!blenderFallback.success && blenderFallback.status === 'fallback_required' && blenderFallback.fallback_guidance) {
    console.log('✅ TEST 5 PASSED: Blender Automator returned structured fallback guidance routing to system.dependencies_manage or game.asset_fetch.');
    passed++;
  } else {
    console.error('❌ TEST 5 FAILED:', blenderFallback);
    failed++;
  }

  console.log(`\n======================================================`);
  console.log(`Results: ${passed} PASSED | ${failed} FAILED`);
  if (failed > 0) process.exit(1);
}

runTests().catch(e => {
  console.error(e);
  process.exit(1);
});
