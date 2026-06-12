'use strict';

const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const http = require('http');
const dns = require('dns');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

chromium.use(StealthPlugin());

const PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');
const SCRATCH_DIR = path.join(__dirname, '..', 'scratch');
const SESSION_FILE = path.join(__dirname, '..', 'cuutruyen-browser-session.json');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE_URL = 'https://cuutruyen.net';
const BASE_HOST = 'cuutruyen.net';
const FALLBACK_HOST_IPS = ['172.67.182.143', '104.21.40.80'];

dns.setServers(['1.1.1.1', '8.8.8.8']);

let _context = null;
let _browser = null;
let _connectedOverCdp = false;
let _publicHostIp = null;
let _usingToolProfile = true;
const _temporaryProfileDirs = new Set();

function debugPortAvailable(port = 9222) {
  return new Promise(resolve => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/json/version',
      timeout: 1000
    }, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function resolvePublicHostIp() {
  if (_publicHostIp) return _publicHostIp;
  if (process.env.CUUTRUYEN_DISABLE_HOST_MAP === '1') {
    return null;
  }
  if (process.env.CUUTRUYEN_HOST_IP) {
    _publicHostIp = process.env.CUUTRUYEN_HOST_IP;
    return _publicHostIp;
  }

  try {
    const addresses = await dns.promises.resolve4(BASE_HOST);
    _publicHostIp = FALLBACK_HOST_IPS.find(address => addresses.includes(address)) ||
      addresses.find(address => address !== '127.0.0.1') ||
      null;
  } catch {
    _publicHostIp = null;
  }
  if (!_publicHostIp) {
    _publicHostIp = FALLBACK_HOST_IPS[0];
  }
  return _publicHostIp;
}

function findBrowserExecutable() {
  const local = process.env.LOCALAPPDATA || '';
  const requested = (process.env.CUUTRUYEN_BROWSER || 'auto').toLowerCase();
  const candidates = [
    {
      id: 'coccoc',
      defaultUserDataDir: path.join(local, 'CocCoc', 'Browser', 'User Data'),
      paths: [
        'C:\\Program Files\\CocCoc\\Browser\\Application\\browser.exe',
        'C:\\Program Files (x86)\\CocCoc\\Browser\\Application\\browser.exe',
        path.join(local, 'CocCoc', 'Browser', 'Application', 'browser.exe')
      ]
    },
    {
      id: 'chrome',
      defaultUserDataDir: path.join(local, 'Google', 'Chrome', 'User Data'),
      paths: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ]
    },
    {
      id: 'edge',
      defaultUserDataDir: path.join(local, 'Microsoft', 'Edge', 'User Data'),
      paths: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      ]
    }
  ];

  for (const candidate of candidates) {
    if (requested !== 'auto' && requested !== candidate.id) continue;
    const executablePath = candidate.paths.find(item => fs.existsSync(item));
    if (executablePath) return { id: candidate.id, executablePath, defaultUserDataDir: candidate.defaultUserDataDir };
  }
  return null;
}

function readSavedSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (!session || !session.executablePath || !fs.existsSync(session.executablePath)) return null;
    if (!session.userDataDir) return null;
    return session;
  } catch {
    return null;
  }
}

function resolveProfileDir(browserExecutable) {
  const envProfile = (process.env.CUUTRUYEN_PROFILE || '').toLowerCase();
  if (process.env.CUUTRUYEN_USER_DATA_DIR) {
    return path.resolve(process.env.CUUTRUYEN_USER_DATA_DIR);
  }

  if (envProfile === 'default' && browserExecutable?.defaultUserDataDir) {
    return browserExecutable.defaultUserDataDir;
  }

  const savedSession = readSavedSession();
  if (savedSession && (envProfile === 'saved' || envProfile === 'default')) {
    return savedSession.userDataDir;
  }

  return PROFILE_DIR;
}

function getAvailableProfileNames(userDataDir) {
  try {
    if (!userDataDir || !fs.existsSync(userDataDir)) return [];
    return fs.readdirSync(userDataDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => name === 'Default' || /^Profile \d+$/.test(name));
  } catch {
    return [];
  }
}

function resolveProfileName(userDataDir) {
  if (process.env.CUUTRUYEN_PROFILE_NAME) {
    return process.env.CUUTRUYEN_PROFILE_NAME;
  }

  const names = getAvailableProfileNames(userDataDir);
  if (names.includes('Default')) return 'Default';
  return names[0] || '';
}

function isProfileLockError(err) {
  const message = String(err?.message || '');
  return message.includes('ProcessSingleton') ||
    message.includes('profile directory') ||
    message.includes('Lock file can not be created');
}

function makeBrowserLaunchOptions({ headless, browserExecutable, profileDir, browserProfileName, publicHostIp }) {
  return {
    headless,
    ...(browserExecutable ? { executablePath: browserExecutable.executablePath } : { channel: 'chrome' }),
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    serviceWorkers: profileDir === PROFILE_DIR ? 'block' : 'allow',
    extraHTTPHeaders: {
      'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8'
    },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...(browserProfileName ? [`--profile-directory=${browserProfileName}`] : []),
      ...(publicHostIp ? [`--host-resolver-rules=MAP ${BASE_HOST} ${publicHostIp},EXCLUDE localhost`] : [])
    ]
  };
}

async function launchPersistentContextWithFallback(profileDir, launchOptions) {
  try {
    return await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch (err) {
    if (profileDir !== PROFILE_DIR) {
      throw err;
    }

    const tempProfileDir = path.join(SCRATCH_DIR, `browser-profile-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tempProfileDir, { recursive: true });
    _temporaryProfileDirs.add(tempProfileDir);
    const reason = isProfileLockError(err) ? 'Tool profile is locked' : 'Tool profile launch failed';
    console.log(chalk.yellow(`  ${reason}; using temporary profile: ${tempProfileDir}`));
    _usingToolProfile = true;

    const tempOptions = { ...launchOptions, serviceWorkers: 'block' };
    try {
      return await chromium.launchPersistentContext(tempProfileDir, tempOptions);
    } catch (secondErr) {
      if (!tempOptions.executablePath) {
        throw secondErr;
      }

      const bundledProfileDir = path.join(SCRATCH_DIR, `browser-profile-bundled-${process.pid}-${Date.now()}`);
      fs.mkdirSync(bundledProfileDir, { recursive: true });
      _temporaryProfileDirs.add(bundledProfileDir);
      const { executablePath, channel, ...bundledOptions } = tempOptions;
      void executablePath;
      void channel;
      console.log(chalk.yellow('  Installed browser launch failed; trying bundled Playwright Chromium.'));
      return chromium.launchPersistentContext(bundledProfileDir, bundledOptions);
    }
  }
}

async function initBrowser(opts = {}) {
  if (_browser && _context) {
    try {
      _context.pages();
      return { browser: _browser, context: _context };
    } catch {
      _context = null;
      _browser = null;
      _connectedOverCdp = false;
      _usingToolProfile = true;
    }
  }

  const savedSession = readSavedSession();
  let headless = process.env.CUUTRUYEN_HEADLESS === '1' ? opts.headless !== false : false;
  const publicHostIp = await resolvePublicHostIp();

  const cdpPort = parseInt(process.env.CUUTRUYEN_CDP_PORT || '9222', 10);
  if (await debugPortAvailable(cdpPort)) {
    console.log(chalk.gray(`  Browser: attaching to existing debug port ${cdpPort}`));
    _browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    _context = _browser.contexts()[0] || await _browser.newContext();
    _connectedOverCdp = true;
    await loadCookiesIntoContext(_context);
    return { browser: _browser, context: _context };
  }

  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
  }

  const browserExecutable = savedSession
    ? { id: savedSession.browser || 'saved', executablePath: savedSession.executablePath, defaultUserDataDir: savedSession.userDataDir }
    : findBrowserExecutable();
  const profileDir = resolveProfileDir(browserExecutable);
  _usingToolProfile = profileDir === PROFILE_DIR;
  if (!_usingToolProfile && process.env.CUUTRUYEN_HEADLESS !== '1') {
    headless = false;
  }
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  if (browserExecutable) {
    console.log(chalk.gray(`  Browser: ${browserExecutable.id} (${browserExecutable.executablePath})`));
  }
  if (publicHostIp) {
    console.log(chalk.gray(`  Browser DNS: ${BASE_HOST} -> ${publicHostIp}`));
  }
  if (profileDir !== PROFILE_DIR) {
    console.log(chalk.gray(`  Profile: ${profileDir}`));
    const profileNames = getAvailableProfileNames(profileDir);
    const profileName = resolveProfileName(profileDir);
    if (profileNames.length) {
      console.log(chalk.gray(`  Profile dirs: ${profileNames.join(', ')}`));
    }
    if (profileName) {
      console.log(chalk.gray(`  Using profile directory: ${profileName}`));
    }
    console.log(chalk.yellow('  Close other windows of this browser before running the tool with the default profile.'));
  }

  const browserProfileName = profileDir !== PROFILE_DIR ? resolveProfileName(profileDir) : '';

  _context = await launchPersistentContextWithFallback(profileDir, makeBrowserLaunchOptions({
    headless,
    browserExecutable,
    profileDir,
    browserProfileName,
    publicHostIp
  }));

  await loadCookiesIntoContext(_context);

  _browser = _context.browser();
  return { browser: _browser, context: _context };
}

async function loadCookiesIntoContext(context) {
  try {
    const cookiesPath = path.join(__dirname, '..', 'cuutruyen-cookies.json');
    if (fs.existsSync(cookiesPath)) {
      const cookiesData = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      if (Array.isArray(cookiesData) && cookiesData.length > 0) {
        await context.addCookies(cookiesData.map(cookie => ({
          ...cookie,
          domain: cookie.domain?.startsWith('.') ? cookie.domain : `.${cookie.domain}`
        })));
      }
    }
  } catch (err) {
    console.log(chalk.gray(`  [cookie load error] ${err.message}`));
  }
}

async function clearSiteState(page) {
  try {
    await page.goto('https://cuutruyen.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.all(registrations.map(registration => registration.unregister()));
      const cacheKeys = await caches?.keys?.() || [];
      await Promise.all(cacheKeys.map(key => caches.delete(key)));
    });
  } catch {
    // Best-effort cleanup only.
  }
}

async function getPage(opts = {}) {
  const { context } = await initBrowser(opts);
  let pages;
  try {
    pages = context.pages();
  } catch {
    _context = null;
    _browser = null;
    _connectedOverCdp = false;
    _usingToolProfile = true;
    const fresh = await initBrowser(opts);
    pages = fresh.context.pages();
    const page = await getOrCreateToolPage(fresh.context, pages);
    await page.bringToFront().catch(() => {});
    return page;
  }
  const page = await getOrCreateToolPage(context, pages);
  await page.bringToFront().catch(() => {});
  if (_usingToolProfile && !context.__cuutruyenSiteStateCleared) {
    await clearSiteState(page);
    context.__cuutruyenSiteStateCleared = true;
  }
  return page;
}

async function getOrCreateToolPage(context, pages = []) {
  const openPages = pages.filter(page => !(page.isClosed && page.isClosed()));
  const cuutruyenPage = openPages.find(page => {
    try {
      return page.url().startsWith(BASE_URL);
    } catch {
      return false;
    }
  });
  if (cuutruyenPage) return cuutruyenPage;

  const blankPage = openPages.find(page => {
    try {
      return page.url() === 'about:blank';
    } catch {
      return false;
    }
  });
  return blankPage || await context.newPage();
}

const AUTH_FILE = path.join(__dirname, '..', 'cuutruyen-auth.json');

async function extractAndSaveAuth(page) {
  try {
    const authData = await page.evaluate(async () => {
      return new Promise((resolve) => {
        if (!window.indexedDB) return resolve(null);
        const openRequest = window.indexedDB.open('manga4u');
        openRequest.onerror = () => resolve(null);
        openRequest.onsuccess = () => {
          const db = openRequest.result;
          if (!db.objectStoreNames.contains('auth')) {
            db.close();
            return resolve(null);
          }
          try {
            const tx = db.transaction('auth', 'readonly');
            const store = tx.objectStore('auth');
            const getAllRequest = store.getAll();
            tx.oncomplete = () => {
              db.close();
              resolve(getAllRequest.result);
            };
            tx.onerror = () => {
              db.close();
              resolve(null);
            };
          } catch (e) {
            db.close();
            resolve(null);
          }
        };
      });
    }).catch(() => null);

    if (authData && authData.length > 0 && authData[0].authToken && authData[0].user?.id) {
      const auth = {
        m4u_uid: String(authData[0].user.id),
        m4u_token: String(authData[0].authToken),
        username: authData[0].user.username,
        email: authData[0].user.email,
        updatedAt: Date.now()
      };
      fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
    }
  } catch (err) {
    // Best-effort only
  }
}

async function navigate(page, url, opts = {}) {
  const retries = opts.retries || 3;
  const timeout = opts.timeout || 60000;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForTimeout(1000);

      // Phát hiện xem có phải trang lỗi mất kết nối (Cốc Cốc chặn mạng)
      const isErrorPage = await page.evaluate(() => {
        const title = String(document.title || '').toLowerCase();
        const text = String(document.body?.innerText || '').toLowerCase();
        return title.includes('site can’t be reached') || 
               text.includes('err_connection_closed') ||
               text.includes('err_connection_reset') ||
               text.includes('unexpectedly closed the connection');
      }).catch(() => false);

      if (isErrorPage) {
        throw new Error('ERR_CONNECTION_CLOSED error page detected');
      }

      const challenge = await detectCaptcha(page);
      if (challenge) {
        if (opts.headless === false) {
          console.log(chalk.yellow(`  ${challenge} challenge detected. Complete it in the browser, then press Enter here.`));
          await new Promise(resolve => process.stdin.once('data', resolve));
        } else {
          throw new Error(`Page requires ${challenge} verification. Run a headed session, complete it manually, then retry.`);
        }
      }

      await extractAndSaveAuth(page);
      return true;
    } catch (err) {
      if (attempt >= retries) {
        throw new Error(`Navigate failed after ${retries} attempts: ${err.message}`);
      }
      const isConnError = err.message.includes('ERR_CONNECTION_CLOSED') || 
                           err.message.includes('ERR_CONNECTION_RESET') || 
                           err.message.includes('connection closed') ||
                           err.message.includes('error page detected');
      if (isConnError) {
        console.log(chalk.yellow(`  Lỗi kết nối (${err.message.substring(0, 60)}). Tự động tải lại trang để kích hoạt proxy Cốc Cốc (${attempt}/${retries})...`));
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: 'domcontentloaded', timeout }).catch(() => {});
      } else {
        console.log(chalk.gray(`  Retry ${attempt}/${retries}: ${err.message.substring(0, 80)}`));
        await page.waitForTimeout(2000);
      }
    }
  }
  return false;
}

async function detectCaptcha(page) {
  try {
    const content = await page.content();
    const title = await page.title().catch(() => '');

    if (
      content.includes('cf-browser-verification') ||
      content.includes('challenge-form') ||
      content.includes('cf_challenge') ||
      title.includes('Just a moment')
    ) {
      return 'cloudflare';
    }

    const hasImageCaptcha = await page.$('img[src*="captcha"], img[alt*="captcha"], #captcha, .captcha');
    if (hasImageCaptcha) return 'captcha';

    const hasRecaptcha = await page.$('.g-recaptcha, iframe[src*="recaptcha"]');
    if (hasRecaptcha) return 'recaptcha';

    return null;
  } catch {
    return null;
  }
}

async function handleCaptcha(page, captchaType) {
  void page;
  void captchaType;
  return false;
}

async function closeBrowser() {
  if (_context && !_connectedOverCdp) {
    await _context.close();
  } else if (_browser && _connectedOverCdp) {
    await _browser.close().catch(() => {});
  }
  for (const dir of Array.from(_temporaryProfileDirs)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      _temporaryProfileDirs.delete(dir);
    } catch {
      // Best-effort cleanup; a browser process may still be releasing files.
    }
  }
  _context = null;
  _browser = null;
  _connectedOverCdp = false;
  _usingToolProfile = true;
}

async function createCuuTruyenPage(headless = true) {
  const visibleBrowser = process.env.CUUTRUYEN_HEADLESS === '1' ? headless : false;
  const page = await getPage({ headless: visibleBrowser });
  await page.bringToFront().catch(() => {});
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9',
    'Cache-Control': 'no-cache'
  });

  if (!visibleBrowser) {
    console.log(chalk.gray(`  Opening ${BASE_URL}/ in browser...`));
    try {
      await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (err) {
      console.log(chalk.gray(`  Startup navigation failed: ${err.message.substring(0, 100)}`));
      if (err.message.includes('ERR_CONNECTION_CLOSED') || err.message.includes('ERR_CONNECTION_RESET')) {
        console.log(chalk.yellow('  ERR_CONNECTION_CLOSED/RESET phát hiện lúc khởi động; Tự động reload trang để kích hoạt proxy Cốc Cốc...'));
        await page.waitForTimeout(1500);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    }
    await page.bringToFront().catch(() => {});
  }

  await extractAndSaveAuth(page);
  return page;
}

module.exports = {
  initBrowser,
  getPage,
  navigate,
  detectCaptcha,
  handleCaptcha,
  closeBrowser,
  createCuuTruyenPage
};

