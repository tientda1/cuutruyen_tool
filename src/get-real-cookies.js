'use strict';

const { execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const chalk = require('chalk');

const COOKIES_FILE = path.join(__dirname, '..', 'cuutruyen-cookies.json');
const SESSION_FILE = path.join(__dirname, '..', 'cuutruyen-browser-session.json');
const DEFAULT_PORT = 9222;
const DOMAIN = 'cuutruyen.net';
const TARGET_URL = `https://${DOMAIN}/`;

function parseArgs(argv) {
  const opts = {
    browser: 'auto',
    port: DEFAULT_PORT,
    profile: 'temp',
    userDataDir: '',
    manual: false,
    url: TARGET_URL
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--manual') opts.manual = true;
    else if (arg === '--browser') opts.browser = argv[++i] || opts.browser;
    else if (arg === '--port') opts.port = parseInt(argv[++i], 10) || opts.port;
    else if (arg === '--profile') opts.profile = argv[++i] || opts.profile;
    else if (arg === '--user-data-dir') opts.userDataDir = argv[++i] || '';
    else if (arg === '--url') opts.url = argv[++i] || opts.url;
  }
  return opts;
}

function browserCandidates() {
  const local = process.env.LOCALAPPDATA || '';
  return [
    {
      id: 'coccoc',
      name: 'Coc Coc',
      exe: [
        'C:\\Program Files\\CocCoc\\Browser\\Application\\browser.exe',
        'C:\\Program Files (x86)\\CocCoc\\Browser\\Application\\browser.exe',
        path.join(local, 'CocCoc', 'Browser', 'Application', 'browser.exe')
      ],
      defaultUserDataDir: path.join(local, 'CocCoc', 'Browser', 'User Data')
    },
    {
      id: 'chrome',
      name: 'Google Chrome',
      exe: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ],
      defaultUserDataDir: path.join(local, 'Google', 'Chrome', 'User Data')
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      exe: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ],
      defaultUserDataDir: path.join(local, 'Microsoft', 'Edge', 'User Data')
    }
  ];
}

function findBrowser(requested) {
  const candidates = browserCandidates();
  const filtered = requested && requested !== 'auto'
    ? candidates.filter(browser => browser.id === requested.toLowerCase())
    : candidates;

  for (const browser of filtered) {
    const exePath = browser.exe.find(candidate => fs.existsSync(candidate));
    if (exePath) return { ...browser, exePath };
  }
  return null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.get({
      host: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      timeout: 3000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Response is not JSON: ' + data.substring(0, 80)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function cdpCommand(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 100000);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP timeout'));
    }, 8000);

    ws.on('open', () => ws.send(JSON.stringify({ id, method, params })));
    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.close();
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch {
        // Ignore unrelated websocket messages.
      }
    });
    ws.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function getCookiesFromDebugPort(port) {
  const tabs = await httpGet(`http://127.0.0.1:${port}/json`);
  if (!Array.isArray(tabs) || tabs.length === 0) return [];

  const tab = tabs.find(item => item.url && item.url.includes(DOMAIN)) || tabs[0];
  if (!tab.webSocketDebuggerUrl) return [];

  const result = await cdpCommand(tab.webSocketDebuggerUrl, 'Network.getAllCookies');
  return (result.cookies || []).filter(cookie => (cookie.domain || '').includes(DOMAIN));
}

function normalizeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain?.startsWith('.') ? cookie.domain : `.${cookie.domain || DOMAIN}`,
    path: cookie.path || '/',
    expires: cookie.expires && cookie.expires > 0 ? Math.floor(cookie.expires) : -1,
    httpOnly: !!cookie.httpOnly,
    secure: cookie.secure !== false,
    sameSite: cookie.sameSite || 'Lax'
  };
}

async function saveCookies(cookies) {
  const normalized = cookies
    .filter(cookie => cookie.name && cookie.value !== undefined)
    .map(normalizeCookie);
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(normalized, null, 2));
  return normalized;
}

function saveBrowserSession(browser, opts) {
  const userDataDir = resolveUserDataDir(browser, opts);
  const session = {
    browser: browser.id,
    executablePath: browser.exePath,
    profile: opts.profile,
    userDataDir,
    savedAt: Date.now()
  };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

function parseCookieHeader(cookieHeader) {
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      if (eq < 0) return null;
      return {
        name: part.slice(0, eq).trim(),
        value: part.slice(eq + 1).trim(),
        domain: DOMAIN,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax'
      };
    })
    .filter(Boolean);
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

async function waitForDebugPort(port) {
  let lastErr = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    process.stdout.write('.');
    try {
      await httpGet(`http://127.0.0.1:${port}/json/version`);
      console.log(chalk.green('\n  Browser debug port is ready.\n'));
      return true;
    } catch (err) {
      lastErr = err.message;
    }
  }
  throw new Error(`Browser did not expose debug port ${port}. Last error: ${lastErr}`);
}

function resolveUserDataDir(browser, opts) {
  if (opts.userDataDir) return path.resolve(opts.userDataDir);
  if (opts.profile === 'default') return browser.defaultUserDataDir;
  return path.join(__dirname, '..', `.${browser.id}-temp-profile`);
}

async function runManualMode() {
  console.log(chalk.cyan('\nManual cookie mode'));
  console.log(chalk.gray('  Open DevTools in the browser that can access cuutruyen.net, copy the Cookie request header, then paste it here.'));
  const cookieHeader = await prompt(chalk.cyan('  Cookie header: '));
  const cookies = parseCookieHeader(cookieHeader.trim());
  if (!cookies.length) {
    throw new Error('No cookies were parsed from the pasted header.');
  }
  const saved = await saveCookies(cookies);
  saveBrowserSession(browser, opts);
  console.log(chalk.green(`\n  Saved ${saved.length} cookies to ${COOKIES_FILE}`));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.manual) {
    await runManualMode();
    return;
  }

  const browser = findBrowser(opts.browser);
  if (!browser) {
    throw new Error(`Could not find browser "${opts.browser}". Try --browser coccoc, --browser chrome, or --manual.`);
  }

  console.log(chalk.cyan('\nGet cookies from a real browser session'));
  console.log(chalk.gray(`  Browser: ${browser.name}`));
  console.log(chalk.gray(`  Exe: ${browser.exePath}`));
  console.log(chalk.gray(`  URL: ${opts.url}`));
  console.log(chalk.gray(`  Debug port: ${opts.port}`));

  let debugAlreadyOpen = false;
  try {
    await httpGet(`http://127.0.0.1:${opts.port}/json/version`);
    debugAlreadyOpen = true;
    console.log(chalk.green(`  Debug port ${opts.port} is already open.`));
  } catch {
    // Launch below.
  }

  if (!debugAlreadyOpen) {
    const userDataDir = resolveUserDataDir(browser, opts);
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    if (opts.profile === 'default') {
      console.log(chalk.yellow('\n  Using the default browser profile.'));
      console.log(chalk.yellow('  Close all windows of this browser first, otherwise Chromium may refuse to reuse the profile.'));
    }

    const args = [
      `--remote-debugging-port=${opts.port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      opts.url
    ];

    execFile(browser.exePath, args, { detached: true, stdio: 'ignore' }).unref();
    console.log(chalk.gray('\n  Waiting for browser debug port...'));
    await waitForDebugPort(opts.port);
  }

  console.log(chalk.yellow('  In the opened browser, make sure cuutruyen.net loads successfully.'));
  console.log(chalk.yellow('  If you used --profile default, your existing Coc Coc/Chrome login cookies should already be there.'));
  await prompt(chalk.cyan('  Press Enter here after the page has loaded...'));

  const cookies = await getCookiesFromDebugPort(opts.port);
  if (!cookies.length) {
    console.log(chalk.yellow(`\n  No cookies found for ${DOMAIN}.`));
    console.log(chalk.yellow('  Try: node cli.js get-cookies --browser coccoc --profile default'));
    console.log(chalk.yellow('  Or:  node cli.js get-cookies --manual'));
    return;
  }

  const saved = await saveCookies(cookies);
  console.log(chalk.green(`\n  Saved ${saved.length} cookies to ${COOKIES_FILE}`));
  saved.forEach(cookie => {
    const exp = cookie.expires > 0 ? new Date(cookie.expires * 1000).toLocaleString() : 'Session';
    console.log(chalk.gray(`    ${cookie.name.padEnd(24)} ${exp}`));
  });
  console.log(chalk.green(`  Saved browser session to ${SESSION_FILE}`));
  console.log(chalk.cyan('\n  Done. You can now run: node cli.js list'));
}

main().catch(err => {
  console.error(chalk.red('\nFatal error:'), err.message);
  process.exit(1);
});
