#!/usr/bin/env node
// Standalone API call verification script for Causyne Agent.
// Verifies live API connectivity, model validity, wire format, and latency.

import { loadConfig } from '../src/config.js';
import { createProvider } from '../src/providers/factory.js';

const argv = process.argv.slice(2);
const providerArg = argv[0];
const modelArg = argv[1];

async function main() {
  const config = loadConfig();
  const provider = providerArg || config.provider;
  if (!provider) {
    console.error('Error: No provider specified or configured in ~/.causyne/config.json.');
    console.error('Usage: node scripts/verify_api_call.js [provider] [model]');
    process.exit(1);
  }

  const model = modelArg || (provider === config.provider ? config.model : undefined);
  const testConfig = { ...config, provider };
  if (model) {
    testConfig.model = model;
  } else if (provider !== config.provider) {
    delete testConfig.model;
  }
  if (config.providerKeys && config.providerKeys[provider]) {
    testConfig.apiKey = config.providerKeys[provider];
  }

  console.log(`Testing API call for provider: "${provider}" (model: "${model || 'default'}")...`);

  try {
    const providerInstance = createProvider(testConfig);
    const start = performance.now();
    const res = await providerInstance.chat([
      { role: 'user', content: 'Respond with exactly: OK' }
    ], { maxTokens: 16 });
    const elapsed = Math.round(performance.now() - start);

    console.log(`\n✅ API Call Test Succeeded!`);
    console.log(`   Provider : ${provider}`);
    console.log(`   Model    : ${providerInstance.model || model || 'default'}`);
    console.log(`   Latency  : ${elapsed} ms`);
    console.log(`   Response : ${res.content || ''}`);
    if (res.usage) {
      console.log(`   Usage    : ${res.usage.promptTokens} prompt tokens, ${res.usage.completionTokens} completion tokens`);
    }
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ API Call Test Failed:`);
    console.error(`   ${err.message || err}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message || err}`);
  process.exit(1);
});

