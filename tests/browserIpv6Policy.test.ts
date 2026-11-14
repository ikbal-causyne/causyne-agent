import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicWebUrl, assertBrowserNavigableUrl, isPrivateAddress } from '../src/browser/urlPolicy.js';

test('public IPv6 URL literals bypass DNS lookup and remain navigable', async () => {
  const address = 'https://[2606:4700:4700::1111]/';
  const result = await assertPublicWebUrl(address);
  assert.equal(result.hostname, '[2606:4700:4700::1111]');
  const browser = await assertBrowserNavigableUrl(address);
  assert.equal(browser.hostname, result.hostname);
});

test('IPv6 literals are still subject to private and loopback restrictions', async () => {
  await assert.rejects(assertPublicWebUrl('http://[::1]/'), /private|reserved|local/i);
  await assert.rejects(assertPublicWebUrl('http://[fc00::1]/'), /private|reserved|local/i);
  await assert.rejects(assertBrowserNavigableUrl('http://[fc00::1]/'), /private|reserved|local/i);
  assert.equal((await assertBrowserNavigableUrl('http://[::1]:3000/')).hostname, '[::1]');
});

test('uncompacted IPv6 loopback, unspecified, and documentation addresses are classified as private', () => {
  assert.equal(isPrivateAddress('0:0:0:0:0:0:0:1'), true);
  assert.equal(isPrivateAddress('0:0:0:0:0:0:0:0'), true);
  assert.equal(isPrivateAddress('2001:0db8:0000:0000:0000:0000:0000:0001'), true);
  assert.equal(isPrivateAddress('2606:4700:4700:0000:0000:0000:0000:1111'), false);
});
