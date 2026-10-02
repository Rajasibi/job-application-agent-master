const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { launch, MODES } = require('../browser_modes');

const ENV_KEYS = [
  'BROWSERLESS_ENABLED', 'BROWSERLESS_ENDPOINT', 'BROWSERLESS_TOKEN',
  'BROWSERLESS_BYPASS'
];

async function withBrowserConfig(values, run) {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (Object.hasOwn(values, key)) process.env[key] = values[key];
    else delete process.env[key];
  }
  try { return await run(); }
  finally {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function withLocalBrowser(run) {
  const originalLaunch = chromium.launch;
  const originalConnect = chromium.connectOverCDP;
  const calls = { launch: 0, connect: 0 };
  const context = {};
  chromium.launch = async () => {
    calls.launch++;
    return { newContext: async () => context };
  };
  chromium.connectOverCDP = async () => {
    calls.connect++;
    throw new Error('unexpected Browserless connection');
  };
  try { return await run({ calls, context }); }
  finally {
    chromium.launch = originalLaunch;
    chromium.connectOverCDP = originalConnect;
  }
}

test('NORMAL connects to the sanitized standard Chromium endpoint', async () => {
  await withBrowserConfig({
    BROWSERLESS_ENABLED: 'true',
    BROWSERLESS_ENDPOINT: 'https://production-sfo.browserless.io/?other=value&solveCaptchas=true',
    BROWSERLESS_TOKEN: 'test token',
    BROWSERLESS_BYPASS: 'false'
  }, async () => {
    const originalConnect = chromium.connectOverCDP;
    let endpoint;
    let contextOptions;
    const context = {};
    const browser = { newContext: async options => { contextOptions = options; return context; } };
    chromium.connectOverCDP = async (url, options) => {
      endpoint = new URL(url);
      assert.deepEqual(options, { timeout: 10000 });
      return browser;
    };
    try {
      const opened = await launch(MODES.NORMAL, { locale: 'en-IN' });
      assert.equal(opened.remote, true);
      assert.equal(opened.browser, browser);
      assert.equal(opened.context, context);
      assert.equal(endpoint.protocol, 'wss:');
      assert.equal(endpoint.pathname, '/chromium');
      assert.deepEqual([...endpoint.searchParams.keys()], ['token']);
      assert.equal(endpoint.searchParams.get('token'), 'test token');
      assert.deepEqual(contextOptions, { viewport: { width: 1366, height: 900 }, locale: 'en-IN' });
    } finally { chromium.connectOverCDP = originalConnect; }
  });
});

test('disabled Browserless falls back to local Chromium', async () => {
  await withBrowserConfig({ BROWSERLESS_ENABLED: 'false' }, async () => {
    await withLocalBrowser(async ({ calls, context }) => {
      const opened = await launch(MODES.NORMAL);
      assert.equal(opened.context, context);
      assert.deepEqual(calls, { launch: 1, connect: 0 });
    });
  });
});

test('visible and authenticated launches remain local', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserless-auth-'));
  const storageState = path.join(storageDir, 'state.json');
  fs.writeFileSync(storageState, '{}');
  try {
    await withBrowserConfig({
      BROWSERLESS_ENABLED: 'true',
      BROWSERLESS_ENDPOINT: 'https://production-sfo.browserless.io',
      BROWSERLESS_TOKEN: 'test-token',
      BROWSERLESS_BYPASS: 'false'
    }, async () => {
      await withLocalBrowser(async ({ calls }) => {
        await launch(MODES.VISIBLE_REVIEW);
        await launch(MODES.NORMAL, { storageState });
        assert.deepEqual(calls, { launch: 2, connect: 0 });
      });
    });
  } finally { fs.rmSync(storageDir, { recursive: true, force: true }); }
});

test('stealth routes and enabled challenge-solving options are rejected', async () => {
  await withBrowserConfig({
    BROWSERLESS_ENABLED: 'true',
    BROWSERLESS_ENDPOINT: 'https://production-sfo.browserless.io/stealth',
    BROWSERLESS_TOKEN: 'test-token',
    BROWSERLESS_BYPASS: 'false'
  }, async () => {
    await assert.rejects(launch(MODES.NORMAL), /standard \/chromium endpoint/);
  });
  await withBrowserConfig({
    BROWSERLESS_ENABLED: 'true',
    BROWSERLESS_ENDPOINT: 'https://production-sfo.browserless.io',
    BROWSERLESS_TOKEN: 'test-token',
    BROWSERLESS_BYPASS: 'true'
  }, async () => {
    await assert.rejects(launch(MODES.NORMAL), /BROWSERLESS_BYPASS must remain false/);
  });
});

test('remote setup failures close the session and do not expose the token', async () => {
  await withBrowserConfig({
    BROWSERLESS_ENABLED: 'true',
    BROWSERLESS_ENDPOINT: 'https://production-sfo.browserless.io',
    BROWSERLESS_TOKEN: 'private-test-token',
    BROWSERLESS_BYPASS: 'false'
  }, async () => {
    const originalConnect = chromium.connectOverCDP;
    let closed = false;
    chromium.connectOverCDP = async () => ({
      newContext: async () => { throw new Error('context creation failed'); },
      close: async () => { closed = true; }
    });
    try {
      await assert.rejects(launch(MODES.NORMAL), error => {
        assert.match(error.message, /Browserless connection or session setup failed/);
        assert.equal(error.message.includes('private-test-token'), false);
        return true;
      });
      assert.equal(closed, true);
    } finally { chromium.connectOverCDP = originalConnect; }
  });
});