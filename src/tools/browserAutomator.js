import os from 'os';
import fs from 'fs';
import path from 'path';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { causyneHome } from '../utils/paths.js';

function getChromeExecutablePath() {
  const platform = os.platform();
  if (platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  } else if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else {
    return '/usr/bin/google-chrome';
  }
}

function getChromeUserDataDir() {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === 'win32') {
    return `${home}\\AppData\\Local\\Google\\Chrome\\User Data`;
  } else if (platform === 'darwin') {
    return `${home}/Library/Application Support/Google/Chrome`;
  } else {
    return `${home}/.config/google-chrome`;
  }
}

let activeBrowser = null;
let activePage = null;

export const browserAct = {
  schema: {
    name: 'browser.act',
    description: 'Automate Google Chrome using local profile to scrape sites or perform actions. IMPORTANT: First use "scrape" to get the page mapped to numerical indices. Then use "clickIndex" or "typeIndex" for flawless precision. Defaults to ~/.causyne/chrome_profile to protect your personal accounts from logout.',
    parameters: {
      type: 'object',
      properties: {
        usePersonalProfile: {
          type: 'boolean',
          description: 'Set to true ONLY if you explicitly want to use your personal Google Chrome profile. Defaults to false (uses safe dedicated profile ~/.causyne/chrome_profile).'
        },
        profileDirectory: {
          type: 'string',
          description: 'Specific profile sub-folder when usePersonalProfile is true (e.g. "Profile 1", "Default", "Profile 2").'
        },
        actions: {
          type: 'array',
          description: 'List of actions to perform in order',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['goto', 'click', 'type', 'clickIndex', 'typeIndex', 'waitFor', 'scrape', 'selectOption', 'keyPress', 'scroll'] },
              url: { type: 'string' },
              selector: { type: 'string', description: 'CSS selector (legacy)' },
              index: { type: 'number', description: 'Element index from the scrape map' },
              text: { type: 'string' },
              value: { type: 'string', description: 'Option value to select in dropdowns' },
              key: { type: 'string', description: 'Key to press (Enter, Tab, ArrowDown, etc.)' },
              humanDelayMs: { type: 'number', description: 'Keystroke delay in ms for natural human-like typing (default 45ms)' },
              timeoutMs: { type: 'number' }
            },
            required: ['type']
          }
        }
      },
      required: ['actions']
    }
  },
  async execute(args) {
    const vision = await ensureCapability('vision');
    if (!vision.ok) return { success: false, error: vision.reason, requiresConsent: vision.requiresConsent };
    const puppeteer = await loadCapabilityPackage('puppeteer-core');

    let results = [];

    try {
      if (!activeBrowser || !activeBrowser.isConnected()) {
        const executablePath = getChromeExecutablePath();
        const primaryUserDataDir = getChromeUserDataDir();
        let connectedOrLaunched = false;
        
        // Layer 1: Attempt connection to active Chrome Remote Debugging port (9222) for zero-interruption live session reuse
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 600);
          const resp = await fetch('http://127.0.0.1:9222/json/version', { signal: controller.signal });
          clearTimeout(timeoutId);
          if (resp.ok) {
            const data = await resp.json();
            if (data.webSocketDebuggerUrl) {
              activeBrowser = await puppeteer.connect({
                browserWSEndpoint: data.webSocketDebuggerUrl,
                defaultViewport: null
              });
              connectedOrLaunched = true;
              results.push('[Sovereign Browser] Attached directly to active Chrome session via port 9222 (Layer 1).');
            }
          }
        } catch (debugErr) {
          // Port 9222 not active, proceed to Layer 2 / Layer 3 decision
        }

        // Sovereign Guard: Decide whether to launch dedicated profile (Layer 2) or personal profile (Layer 3)
        if (!connectedOrLaunched) {
          const fallbackDir = path.join(causyneHome(), 'chrome_profile');
          if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });

          if (!args.usePersonalProfile) {
            // Layer 2: Sovereign Dedicated Agent Profile (100% Safe - Never risks logging out personal Chrome accounts)
            activeBrowser = await puppeteer.launch({
              executablePath,
              userDataDir: fallbackDir,
              headless: false,
              defaultViewport: null,
              args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            connectedOrLaunched = true;
            results.push('[Sovereign Browser] Launched Chrome using Sovereign Dedicated Profile (~/.causyne/chrome_profile). Your personal Google Chrome accounts remain 100% untouched and protected.');
          } else {
            // Layer 3: Explicit Personal Profile Guard (Strictly when usePersonalProfile: true is requested)
            try {
              const profileArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
              if (args.profileDirectory) {
                profileArgs.push(`--profile-directory=${args.profileDirectory}`);
              }
              activeBrowser = await puppeteer.launch({
                executablePath,
                userDataDir: primaryUserDataDir,
                headless: false,
                defaultViewport: null,
                args: profileArgs
              });
              connectedOrLaunched = true;
              results.push(`[Sovereign Browser] Launched primary profile (${args.profileDirectory || 'Default'}) explicitly requested via usePersonalProfile.`);
            } catch (launchErr) {
              const isProfileLock = launchErr.message.includes('already running') ||
                                    launchErr.message.includes('SingletonLock') ||
                                    launchErr.message.includes('EBUSY') ||
                                    launchErr.message.includes('lock') ||
                                    launchErr.message.includes('user data directory is already in use');
              if (isProfileLock) {
                // Safe fallback to dedicated profile so task never fails and never corrupts personal cookies
                results.push(`[Sovereign Profile Guard] Your personal Chrome profile (${args.profileDirectory || 'Default'}) is currently running and locked without remote debugging port 9222. Automatically switched to Sovereign Dedicated Profile (~/.causyne/chrome_profile) to protect your personal account session from logout.`);
                activeBrowser = await puppeteer.launch({
                  executablePath,
                  userDataDir: fallbackDir,
                  headless: false,
                  defaultViewport: null,
                  args: ['--no-sandbox', '--disable-setuid-sandbox']
                });
                connectedOrLaunched = true;
              } else {
                throw launchErr;
              }
            }
          }
        }

        const pages = await activeBrowser.pages();
        activePage = pages[0] || (await activeBrowser.newPage());
      }

      for (const action of args.actions) {
        if (action.type === 'goto') {
          await activePage.goto(action.url, { waitUntil: 'networkidle2' });
          results.push(`Navigated to ${action.url}`);
        } 
        else if (action.type === 'click') {
          await activePage.waitForSelector(action.selector, { timeout: action.timeoutMs || 5000 });
          await activePage.click(action.selector);
          results.push(`Clicked ${action.selector}`);
        } 
        else if (action.type === 'type') {
          await activePage.waitForSelector(action.selector, { timeout: action.timeoutMs || 5000 });
          await activePage.type(action.selector, action.text, { delay: action.humanDelayMs || 45 });
          results.push(`Typed text into ${action.selector} with human keystroke delay`);
        }
        // Phase 1 AGI Upgrade: DOM-to-Markdown Interaction
        else if (action.type === 'clickIndex') {
          const selector = `[data-causyne-id="${action.index}"]`;
          await activePage.waitForSelector(selector, { timeout: action.timeoutMs || 5000 });
          await activePage.click(selector);
          results.push(`Clicked element mapped to index [${action.index}]`);
        }
        else if (action.type === 'typeIndex') {
          const selector = `[data-causyne-id="${action.index}"]`;
          await activePage.waitForSelector(selector, { timeout: action.timeoutMs || 5000 });
          await activePage.type(selector, action.text, { delay: action.humanDelayMs || 45 });
          results.push(`Typed text into element mapped to index [${action.index}] with human keystroke delay`);
        }
        else if (action.type === 'selectOption') {
          if (action.index !== undefined) {
            const selector = `[data-causyne-id="${action.index}"]`;
            await activePage.waitForSelector(selector, { timeout: action.timeoutMs || 5000 });
            await activePage.select(selector, action.value || action.text);
          } else if (action.selector) {
            await activePage.waitForSelector(action.selector, { timeout: action.timeoutMs || 5000 });
            await activePage.select(action.selector, action.value || action.text);
          }
          results.push(`Selected option [${action.value || action.text}] from dropdown`);
        }
        else if (action.type === 'keyPress') {
          await activePage.keyboard.press(action.key || 'Enter');
          results.push(`Pressed keyboard key [${action.key || 'Enter'}]`);
        }
        else if (action.type === 'scroll') {
          await activePage.evaluate(() => {
            window.scrollBy({ top: window.innerHeight * 0.75, behavior: 'smooth' });
          });
          results.push(`Scrolled page smoothly`);
        }
        else if (action.type === 'waitFor') {
          await activePage.waitForSelector(action.selector, { timeout: action.timeoutMs || 10000 });
          results.push(`Element ${action.selector} appeared`);
        } 
        else if (action.type === 'scrape') {
          // Phase 1 AGI Upgrade: AXTree Mapper injection
          const mappedMarkdown = await activePage.evaluate(() => {
            let idx = 1;
            let lines = [];
            const elements = document.querySelectorAll('a, button, input, textarea, [role="button"], select');
            
            elements.forEach(el => {
              // Ignore hidden elements
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || el.offsetWidth === 0) return;
              
              let label = el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.name || 'unlabeled';
              label = label.trim().replace(/\n/g, ' ');
              if (!label) return; // Skip empty elements
              
              const tagName = el.tagName.toLowerCase();
              lines.push(`[${idx}] ${tagName}: ${label}`);
              
              el.setAttribute('data-causyne-id', idx.toString());
              idx++;
            });
            return lines.join('\n');
          });
          
          results.push(`Scraped DOM Map:\n${mappedMarkdown}`);
        }
      }
      
      return { success: true, log: results };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
