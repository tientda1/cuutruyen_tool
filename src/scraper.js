'use strict';

const chalk = require('chalk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { navigate } = require('./browser');
const { getCachedMangaList, saveMangaList, getCachedChapters, saveChapters } = require('./cache');

const BASE_URL = 'https://cuutruyen.net';
const BASE_HOST = 'cuutruyen.net';
const COOKIES_FILE = path.join(__dirname, '..', 'cuutruyen-cookies.json');
const AUTH_FILE = path.join(__dirname, '..', 'cuutruyen-auth.json');

function getAuthHeaders() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return {};
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (auth && auth.m4u_uid && auth.m4u_token) {
      return {
        'cuutruyen-client': 'OfficialWebApp-20250805',
        'm4u_uid': auth.m4u_uid,
        'm4u_token': auth.m4u_token
      };
    }
  } catch (err) {
    // ignore
  }
  return {};
}

dns.setServers(['1.1.1.1', '8.8.8.8']);
let _resolvedBaseIp = null;

function absoluteUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  return BASE_URL + (href.startsWith('/') ? href : '/' + href);
}

async function ensureConnected(page) {
  if (!page) {
    throw new Error('Browser fallback is unavailable after the Node API failed.');
  }
  const currentUrl = page.url();
  if (!currentUrl.startsWith(BASE_URL)) {
    await navigate(page, BASE_URL + '/');
  }
}

function collectImageUrls(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    if (/^https?:\/\/.+\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectImageUrls(item, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (
        typeof nested === 'string' &&
        (normalizedKey.includes('image') ||
          normalizedKey.includes('url') ||
          normalizedKey.includes('src') ||
          normalizedKey.includes('path'))
      ) {
        collectImageUrls(nested, out);
      } else if (Array.isArray(nested) || (nested && typeof nested === 'object')) {
        collectImageUrls(nested, out);
      }
    }
  }
  return out;
}

function collectChapterImageUrls(value, out = [], keyPath = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    const pathText = keyPath.join('.').toLowerCase();
    const excluded = ['cover', 'avatar', 'icon', 'favicon', 'banner', 'logo', 'thumb'].some(key => pathText.includes(key));
    const looksLikeImage = /^https?:\/\/.+\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(value) ||
      /^https?:\/\/[^/]*storage-ct[^/]*\//i.test(value);
    if (!excluded && looksLikeImage) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectChapterImageUrls(item, out, keyPath.concat(String(index))));
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      collectChapterImageUrls(nested, out, keyPath.concat(key));
    }
  }
  return out;
}

function uniqueUrls(urls) {
  return Array.from(new Set((urls || []).filter(Boolean)));
}

function getCookieHeader() {
  try {
    if (!fs.existsSync(COOKIES_FILE)) return '';
    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    if (!Array.isArray(cookies)) return '';
    return cookies
      .filter(cookie => cookie.name && cookie.value !== undefined)
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

async function resolveBaseIp() {
  if (_resolvedBaseIp) return _resolvedBaseIp;
  let addresses = [];
  try {
    addresses = await dns.promises.resolve4(BASE_HOST);
  } catch {
    addresses = [];
  }

  if (!addresses.length) {
    addresses = await resolveBaseIpWithDoh();
  }

  const ip = addresses.find(address => address !== '127.0.0.1');
  if (!ip) throw new Error(`Public DNS returned no usable A record for ${BASE_HOST}`);
  _resolvedBaseIp = ip;
  console.log(chalk.gray(`  Public DNS: ${BASE_HOST} -> ${ip}`));
  return ip;
}

async function resolveBaseIpWithDoh() {
  const endpoints = [
    {
      url: 'https://1.1.1.1/dns-query',
      host: 'cloudflare-dns.com',
      params: { name: BASE_HOST, type: 'A' },
      parse: data => (data.Answer || []).filter(item => item.type === 1).map(item => item.data)
    },
    {
      url: 'https://8.8.8.8/resolve',
      host: 'dns.google',
      params: { name: BASE_HOST, type: 'A' },
      parse: data => (data.Answer || []).filter(item => item.type === 1).map(item => item.data)
    }
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await axios.get(endpoint.url, {
        timeout: 10000,
        proxy: false,
        params: endpoint.params,
        httpsAgent: new https.Agent({ servername: endpoint.host }),
        headers: {
          Host: endpoint.host,
          Accept: 'application/dns-json'
        }
      });
      const addresses = endpoint.parse(res.data).filter(Boolean);
      if (addresses.length) return addresses;
    } catch (err) {
      console.log(chalk.gray(`  DoH ${endpoint.host} failed: ${err.message}`));
    }
  }

  return [];
}

async function createHttpsAgent() {
  if (process.env.CUUTRUYEN_DISABLE_HOST_MAP === '1') {
    return new https.Agent({ servername: BASE_HOST });
  }

  const baseIp = await resolveBaseIp();
  return new https.Agent({
    servername: BASE_HOST,
    lookup(hostname, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }

      if (net.isIP(hostname)) {
        if (options.all) {
          callback(null, [{ address: hostname, family: net.isIP(hostname) }]);
        } else {
          callback(null, hostname, net.isIP(hostname));
        }
        return;
      }

      if (hostname === BASE_HOST) {
        if (options.all) {
          callback(null, [{ address: baseIp, family: 4 }]);
        } else {
          callback(null, baseIp, 4);
        }
        return;
      }
      dns.lookup(hostname, options, callback);
    }
  });
}

async function apiGet(pathname) {
  const url = pathname.startsWith('http') ? pathname : `${BASE_URL}${pathname}`;
  const cookieHeader = getCookieHeader();
  const httpsAgent = await createHttpsAgent();
  const delays = [0, 5000, 12000, 25000];
  const authHeaders = getAuthHeaders();

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) {
      console.log(chalk.gray(`  API rate limited; waiting ${Math.round(delays[attempt] / 1000)}s before retry...`));
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }

    try {
      const res = await axios.get(url, {
        timeout: 30000,
        httpsAgent,
        proxy: false,
        headers: {
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...authHeaders,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
          'Referer': `${BASE_URL}/`,
          'Origin': BASE_URL
        }
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status !== 429 || attempt === delays.length - 1) throw err;
    }
  }

  throw new Error('API request failed');
}

function mapMangaItems(data) {
  return (data || []).map(item => ({
    url: `${BASE_URL}/mangas/${item.id}`,
    title: item.name || '',
    cover: item.cover_url || item.cover_mobile_url || '',
    status: item.status || ''
  }));
}

function mapChapters(data) {
  const chapters = (data || []).map(chapter => ({
    url: `/chapters/${chapter.id}`,
    title: chapter.name || `Chapter ${chapter.number}`,
    number: parseFloat(chapter.number),
    date: chapter.created_at || chapter.updated_at || ''
  }));
  chapters.sort((a, b) => (a.number || 0) - (b.number || 0));
  return chapters;
}

async function getMangaList(page, opts = {}) {
  const { pageNum = 1, search = '', perPage = 20, useCache = true } = opts;

  if (useCache) {
    const cached = await getCachedMangaList(pageNum, search);
    if (cached) {
      console.log(chalk.gray('  (from cache)'));
      return cached;
    }
  }

  try {
    const apiPath = search
      ? `/api/v2/mangas/search?query=${encodeURIComponent(search)}&page=${pageNum}&per_page=${perPage}`
      : `/api/v2/mangas/recently_updated?page=${pageNum}&per_page=${perPage}`;
    const json = await apiGet(apiPath);
    const items = mapMangaItems(json.data || []);
    if (items.length > 0 && useCache) {
      await saveMangaList(items);
    }
    return items;
  } catch (err) {
    console.log(chalk.gray(`  Node API fallback failed: ${err.message}`));
  }

  await ensureConnected(page);

  const result = await page.evaluate(async ({ pageNum, search, perPage, baseUrl }) => {
    try {
      const apiUrl = search
        ? `${baseUrl}/api/v2/mangas/search?query=${encodeURIComponent(search)}&page=${pageNum}&per_page=${perPage}`
        : `${baseUrl}/api/v2/mangas/recently_updated?page=${pageNum}&per_page=${perPage}`;

      let res = null;
      for (const delay of [0, 5000, 12000, 25000]) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        res = await fetch(apiUrl, {
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'vi-VN,vi;q=0.9'
          }
        });
        if (res.status !== 429) break;
      }
      if (!res.ok) throw new Error(`List API Error: ${res.status}`);
      const json = await res.json();
      const data = json.data || [];

      return {
        error: null,
        items: data.map(item => ({
          url: `${baseUrl}/mangas/${item.id}`,
          title: item.name || '',
          cover: item.cover_url || item.cover_mobile_url || '',
          status: item.status || ''
        }))
      };
    } catch (err) {
      return { error: err.toString(), items: [] };
    }
  }, { pageNum, search, perPage, baseUrl: BASE_URL });

  if (result.error) {
    throw new Error(`List API failed (${result.error}). If the site requires login or verification, complete it manually first.`);
  }

  if (result.items.length > 0 && useCache) {
    await saveMangaList(result.items);
  }
  return result.items;
}

async function getMangaListPages(page, opts = {}) {
  const {
    search = '',
    startPage = 1,
    maxPages = 1,
    perPage = 20,
    useCache = true,
    onPage
  } = opts;
  const pages = [];
  const seen = new Set();
  const firstPage = Math.max(1, parseInt(startPage, 10) || 1);
  const pageLimit = maxPages === 0 ? Infinity : Math.max(1, parseInt(maxPages, 10) || 1);

  for (let index = 0; index < pageLimit; index++) {
    const pageNum = firstPage + index;
    const items = await getMangaList(page, {
      pageNum,
      search,
      perPage,
      useCache
    });

    const fresh = [];
    for (const item of items) {
      const key = item.url || item.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh.push(item);
    }

    pages.push(...fresh);
    if (onPage) onPage({ pageNum, items, fresh, total: pages.length });
    if (!items.length || !fresh.length || (search && items.length < perPage)) break;
  }

  return pages;
}

async function getMangaChapters(page, mangaUrl, useCache = true) {
  if (useCache) {
    const cached = await getCachedChapters(mangaUrl);
    if (cached && cached.length > 0) {
      console.log(chalk.gray('  (from cache)'));
      return {
        title: cached[0]?.manga_title || '',
        chapters: cached.map(row => ({
          url: row.chapter_url,
          title: row.title,
          number: row.number,
          date: row.date
        }))
      };
    }
  }

  const mangaIdMatch = mangaUrl.match(/\/mangas\/(\d+)/);
  if (!mangaIdMatch) return { title: '', chapters: [] };
  const mangaId = mangaIdMatch[1];

  try {
    const [mangaJson, chaptersJson] = await Promise.all([
      apiGet(`/api/v2/mangas/${mangaId}`),
      apiGet(`/api/v2/mangas/${mangaId}/chapters?per_page=1000`)
    ]);
    const title = mangaJson.data?.name || '';
    const chapters = mapChapters(chaptersJson.data || []);
    if (chapters.length > 0 && useCache) {
      await saveChapters(mangaUrl, chapters, title);
    }
    return { title, chapters };
  } catch (err) {
    console.log(chalk.gray(`  Node API fallback failed: ${err.message}`));
  }

  await ensureConnected(page);

  const result = await page.evaluate(async (id) => {
    try {
      const mangaRes = await fetch(`/api/v2/mangas/${id}`);
      if (!mangaRes.ok) throw new Error(`Manga API Error: ${mangaRes.status}`);
      const mangaJson = await mangaRes.json();
      const mangaTitle = mangaJson.data?.name || '';

      const chapRes = await fetch(`/api/v2/mangas/${id}/chapters?per_page=1000`);
      if (!chapRes.ok) throw new Error(`Chapters API Error: ${chapRes.status}`);
      const chapJson = await chapRes.json();
      const chaptersData = chapJson.data || [];

      const chapters = chaptersData.map(chapter => ({
        url: `/chapters/${chapter.id}`,
        title: chapter.name || `Chapter ${chapter.number}`,
        number: parseFloat(chapter.number),
        date: chapter.created_at || chapter.updated_at || ''
      }));
      chapters.sort((a, b) => (a.number || 0) - (b.number || 0));

      return { error: null, mangaTitle, chapters };
    } catch (err) {
      return { error: err.toString(), mangaTitle: '', chapters: [] };
    }
  }, mangaIdMatch[1]);

  if (result.error) {
    throw new Error(`Chapters API failed (${result.error}). If the site requires login or verification, complete it manually first.`);
  }

  if (result.chapters.length > 0 && useCache) {
    await saveChapters(mangaUrl, result.chapters, result.mangaTitle);
  }

  return { title: result.mangaTitle, chapters: result.chapters };
}

async function getChapterImages(page, chapterUrl, opts = {}) {
  let chapterInfo = { mangaTitle: 'unknown', chapterNum: '', chapterTitle: '', expectedImageCount: 0 };
  const mangaUrl = opts.mangaUrl || '';
  const chapterTitleHint = opts.chapterTitle || '';
  const chapterNumberHint = opts.chapterNumber || '';

  let fullChapterUrl = chapterUrl;
  if (fullChapterUrl.startsWith('/')) {
    fullChapterUrl = BASE_URL + fullChapterUrl;
  }
  const chapterPath = new URL(fullChapterUrl, BASE_URL).pathname;
  const chapterId = (chapterPath.match(/\/chapters\/(\d+)/) || [])[1] || '';
  const mangaPath = mangaUrl ? new URL(mangaUrl.startsWith('/') ? BASE_URL + mangaUrl : mangaUrl, BASE_URL).pathname : '';
  const chapterUrlCandidates = makeChapterUrlCandidates(fullChapterUrl, mangaPath, chapterId);

  if (chapterId && process.env.CUUTRUYEN_DISABLE_CHAPTER_API !== '1') {
    try {
      const json = await apiGet(`/api/v2/chapters/${chapterId}`);
      const data = json.data || json;
      const directImageUrls = uniqueUrls(collectChapterImageUrls(data));
      chapterInfo = {
        mangaTitle: data.manga?.name || data.manga_name || data.manga?.title || 'unknown',
        chapterNum: data.number || chapterNumberHint || '',
        chapterTitle: data.name || chapterTitleHint || `Chapter ${data.number || chapterNumberHint || ''}`,
        expectedImageCount: directImageUrls.length
      };
      if (directImageUrls.length > 0) {
        console.log(chalk.gray(`  Chapter API found ${directImageUrls.length} source image(s); using rendered canvas instead.`));
      }
    } catch (err) {
      console.log(chalk.gray(`  Chapter API fallback failed: ${err.message}`));
    }
  }

  let sawTargetChapterApi = false;
  const wrongChapterApiIds = new Set();
  const responseHandler = async (response) => {
    if (response.url().includes('/api/v2/chapters/')) {
      try {
        const responseChapterId = (new URL(response.url()).pathname.match(/\/chapters\/(\d+)/) || [])[1] || '';
        if (chapterId && responseChapterId && responseChapterId !== chapterId) {
          wrongChapterApiIds.add(responseChapterId);
          return;
        }
        const json = await response.json();
        const data = json.data || {};
        const dataChapterId = String(data.id || data.chapter_id || '');
        if (chapterId && dataChapterId && dataChapterId !== chapterId) {
          wrongChapterApiIds.add(dataChapterId);
          return;
        }
        if (chapterId && (responseChapterId === chapterId || dataChapterId === chapterId)) {
          sawTargetChapterApi = true;
        }
        const apiImageUrls = uniqueUrls(collectChapterImageUrls(data));
        chapterInfo = {
          mangaTitle: data.manga?.name || data.manga_name || 'unknown',
          chapterNum: data.number || '',
          chapterTitle: data.name || `Chapter ${data.number || ''}`,
          expectedImageCount: apiImageUrls.length || collectImageUrls(data).length
        };
      } catch {
        // Ignore parse failures.
      }
    }
  };

  page.on('response', responseHandler);
  try {
    if (mangaUrl) {
      await loadChapterFromMangaPage(page, mangaUrl, fullChapterUrl, chapterTitleHint);
    } else {
      console.log(chalk.cyan(`  Loading page: ${fullChapterUrl}`));
      await navigate(page, fullChapterUrl);
    }

    if (chapterId && wrongChapterApiIds.size > 0 && !sawTargetChapterApi) {
      console.log(chalk.yellow(`  Browser loaded chapter API ${Array.from(wrongChapterApiIds).join(', ')} instead of ${chapterId}; reopening target chapter.`));
      await openDirectChapterWithReloads(page, chapterUrlCandidates, chapterPath, mangaPath);
    }

    if (chapterId && (!chapterInfo.expectedImageCount || !sawTargetChapterApi)) {
      const browserInfo = await fetchChapterInfoInBrowser(page, chapterId, {
        chapterTitle: chapterTitleHint,
        chapterNumber: chapterNumberHint
      });
      if (browserInfo) {
        chapterInfo = {
          ...chapterInfo,
          ...browserInfo,
          mangaTitle: browserInfo.mangaTitle || chapterInfo.mangaTitle,
          chapterNum: browserInfo.chapterNum || chapterInfo.chapterNum,
          chapterTitle: browserInfo.chapterTitle || chapterInfo.chapterTitle,
          expectedImageCount: browserInfo.expectedImageCount || chapterInfo.expectedImageCount
        };
      }
    }
  } finally {
    page.off('response', responseHandler);
  }

  console.log(chalk.cyan('  Rendering chapter canvases...'));
  let imageUrls = await captureRenderedCanvases(page, {
    expectedCount: chapterInfo.expectedImageCount || 0
  });
  const minRetryThreshold = Math.max(1, Math.floor((chapterInfo.expectedImageCount || 0) * 0.95));
  if (chapterInfo.expectedImageCount && imageUrls.length < chapterInfo.expectedImageCount && imageUrls.length < minRetryThreshold) {
    console.log(chalk.yellow(`  Missing ${chapterInfo.expectedImageCount - imageUrls.length} canvas image(s); reloading chapter and retrying canvas capture...`));
    const reopened = await openDirectChapterWithReloads(page, chapterUrlCandidates, chapterPath, mangaPath);
    if (reopened) {
      const retryImages = await captureRenderedCanvases(page, {
        expectedCount: chapterInfo.expectedImageCount || 0,
        forceFullScan: true
      });
      if (retryImages.length > imageUrls.length) {
        imageUrls = retryImages;
      }
    }
  }
  if (imageUrls.length > 0) {
    console.log(chalk.cyan(`  Captured ${imageUrls.length} rendered canvas images.`));
  }

  if (!chapterInfo.chapterNum && chapterNumberHint !== '') {
    chapterInfo.chapterNum = chapterNumberHint;
  }
  if (!chapterInfo.chapterTitle && chapterTitleHint) {
    chapterInfo.chapterTitle = chapterTitleHint;
  }

  return { imageUrls, chapterInfo };
}

async function loadChapterFromMangaPage(page, mangaUrl, chapterUrl, chapterTitle = '') {
  const fullMangaUrl = mangaUrl.startsWith('/') ? BASE_URL + mangaUrl : mangaUrl;
  const fullChapterUrl = chapterUrl.startsWith('/') ? BASE_URL + chapterUrl : chapterUrl;
  const chapterPath = new URL(chapterUrl, BASE_URL).pathname;
  const mangaPath = new URL(fullMangaUrl, BASE_URL).pathname;
  const chapterId = (chapterPath.match(/\/chapters\/(\d+)/) || [])[1] || '';
  const chapterUrlCandidates = makeChapterUrlCandidates(fullChapterUrl, mangaPath, chapterId);

  let ready = await openDirectChapterWithReloads(page, chapterUrlCandidates, chapterPath, mangaPath);
  if (ready) return;

  console.log(chalk.cyan(`  Loading manga page first: ${fullMangaUrl}`));
  await navigate(page, fullMangaUrl);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const clicked = await clickChapterLinkFromManga(page, chapterPath, chapterTitle, mangaPath);
  if (!clicked) {
    console.log(chalk.gray(`  Cannot find an exact chapter link for ${chapterPath}; reopening the direct chapter URL.`));
    ready = await openDirectChapterWithReloads(page, chapterUrlCandidates, chapterPath, mangaPath);
    if (ready) return;
  }

  ready = await waitForChapterReader(page, chapterPath, mangaPath, clicked ? 30000 : 12000);
  if (!ready && (await isBlankChapterRoute(page, chapterPath) || await hasCloudflareErrorPage(page))) {
    ready = await recoverBlankChapterRoute(page, fullMangaUrl, chapterPath, chapterTitle, mangaPath);
  }
  if (!ready) {
    ready = await waitForManualChapterOpen(page, chapterPath, mangaPath);
  }
  if (!ready) {
    throw new Error('Reader did not open. Keep the Coc Coc window open and click the requested chapter when the tool asks.');
  }
}

function makeChapterUrlCandidates(fullChapterUrl, mangaPath = '', chapterId = '') {
  const urls = [];
  if (mangaPath && chapterId) {
    urls.push(`${BASE_URL}${mangaPath}/chapters/${chapterId}`);
  }
  urls.push(fullChapterUrl);
  return Array.from(new Set(urls.filter(Boolean)));
}

async function fetchChapterInfoInBrowser(page, chapterId, hints = {}) {
  const result = await page.evaluate(async ({ id, chapterTitle, chapterNumber }) => {
    function collectImageUrls(value, out = [], keyPath = []) {
      if (!value) return out;
      if (typeof value === 'string') {
        const pathText = keyPath.join('.').toLowerCase();
        const excluded = ['cover', 'avatar', 'icon', 'favicon', 'banner', 'logo', 'thumb'].some(key => pathText.includes(key));
        const looksLikeImage = /^https?:\/\/.+\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(value) ||
          /^https?:\/\/[^/]*storage-ct[^/]*\//i.test(value);
        if (!excluded && looksLikeImage) out.push(value);
        return out;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => collectImageUrls(item, out, keyPath.concat(String(index))));
        return out;
      }
      if (typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          collectImageUrls(nested, out, keyPath.concat(key));
        }
      }
      return out;
    }

    try {
      const res = await fetch(`/api/v2/chapters/${id}`, {
        headers: { Accept: 'application/json, text/plain, */*' }
      });
      if (!res.ok) return null;
      const json = await res.json();
      const data = json.data || json;
      const dataId = String(data.id || data.chapter_id || '');
      if (dataId && dataId !== String(id)) return null;
      const imageUrls = Array.from(new Set(collectImageUrls(data)));
      return {
        mangaTitle: data.manga?.name || data.manga_name || data.manga?.title || '',
        chapterNum: data.number || chapterNumber || '',
        chapterTitle: data.name || chapterTitle || `Chapter ${data.number || chapterNumber || ''}`,
        expectedImageCount: imageUrls.length
      };
    } catch {
      return null;
    }
  }, {
    id: chapterId,
    chapterTitle: hints.chapterTitle || '',
    chapterNumber: hints.chapterNumber || ''
  }).catch(() => null);

  if (result?.expectedImageCount) {
    console.log(chalk.gray(`  Browser API metadata says ${result.expectedImageCount} source image(s); using this as canvas target.`));
  }
  return result;
}

async function openDirectChapterWithReloads(page, chapterUrls, chapterPath, mangaPath) {
  const urls = Array.isArray(chapterUrls) ? chapterUrls : [chapterUrls];
  for (let urlIndex = 0; urlIndex < urls.length; urlIndex++) {
    const fullChapterUrl = urls[urlIndex];
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt === 0) {
        console.log(chalk.cyan(`  Loading chapter directly: ${fullChapterUrl}`));
        await navigate(page, fullChapterUrl).catch(() => {});
      } else if (attempt === 1) {
        console.log(chalk.gray('  Chapter page looks blank; reloading the same chapter URL...'));
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      } else {
        console.log(chalk.gray(`  Reopening chapter URL (${attempt}/3): ${fullChapterUrl}`));
        await navigate(page, 'about:blank').catch(() => {});
        await page.waitForTimeout(400);
        await navigate(page, fullChapterUrl).catch(() => {});
      }

      // Check immediately if the reader is already loaded
      if (await waitForChapterReader(page, chapterPath, mangaPath, 4500)) {
        return true;
      }

      // Fallback: wait for networkidle and check again
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(400 + attempt * 400);

      if (await waitForChapterReader(page, chapterPath, mangaPath, 4500)) {
        return true;
      }
      if (await hasCloudflareErrorPage(page)) {
        await page.waitForTimeout(4000 + attempt * 2000);
        continue;
      }
    }
  }

  return false;
}

async function clickChapterLinkFromManga(page, chapterPath, chapterTitle = '', mangaPath = '') {
  for (let attempt = 0; attempt < 16; attempt++) {
    await expandChapterList(page);

    const target = await page.evaluate(({ targetPath }) => {
      const targetId = (targetPath.match(/\/chapters\/(\d+)/) || [])[1] || '';

      function normalize(text) {
        return String(text || '')
          .normalize('NFKC')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
      }

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 10 &&
          rect.height > 10 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0;
      }

      function isBlockedUi(element) {
        let current = element;
        for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
          const tag = current.tagName;
          const rect = current.getBoundingClientRect();
          const style = window.getComputedStyle(current);
          const attrs = normalize([
            tag,
            current.getAttribute('role') || '',
            current.getAttribute('aria-label') || '',
            current.getAttribute('placeholder') || '',
            current.getAttribute('title') || '',
            current.id || '',
            current.className?.toString?.() || ''
          ].join(' '));
          const text = normalize(current.innerText || current.textContent || '');
          const isSearchUi = attrs.includes('search') ||
            attrs.includes('tìm') ||
            attrs.includes('tim') ||
            text.includes('tìm kiếm') ||
            text.includes('tim kiem') ||
            text.includes('search');
          const isTopChrome = (tag === 'HEADER' || tag === 'NAV' || style.position === 'fixed' || style.position === 'sticky') &&
            rect.top <= 180;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'FORM' || isSearchUi || isTopChrome) {
            return true;
          }
        }
        return false;
      }

      function pathMatchesChapter(pathname) {
        return pathname === targetPath || Boolean(targetId && pathname.endsWith(`/chapters/${targetId}`));
      }

      function linkForPath(element, targetPath) {
        const candidates = [];
        if (element.matches?.('a[href]')) candidates.push(element);
        candidates.push(...Array.from(element.querySelectorAll?.('a[href]') || []));
        for (let current = element.parentElement, depth = 0; current && depth < 5; depth++, current = current.parentElement) {
          if (current.matches?.('a[href]')) candidates.push(current);
        }
        return candidates.find(anchor => {
          try {
            return !isBlockedUi(anchor) && pathMatchesChapter(new URL(anchor.getAttribute('href'), location.href).pathname);
          } catch {
            return false;
          }
        }) || null;
      }

      function targetInfo(element, text, href = '') {
        const clickable = linkForPath(element, targetPath);
        if (!clickable) return null;
        clickable.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = clickable.getBoundingClientRect();
        return {
          x: rect.left + Math.min(Math.max(45, rect.width * 0.12), rect.width / 2),
          y: rect.top + rect.height / 2,
          text: text.slice(0, 120),
          href: href || clickable.getAttribute?.('href') || '',
          tag: clickable.tagName || ''
        };
      }

      const elements = Array.from(document.querySelectorAll('a[href]'))
        .filter(element => isVisible(element) && !isBlockedUi(element));

      for (const element of elements) {
        const href = element.getAttribute?.('href') || '';
        let hrefMatches = false;
        try {
          hrefMatches = href && pathMatchesChapter(new URL(href, location.href).pathname);
        } catch {
          hrefMatches = false;
        }

        const text = normalize(element.innerText || element.textContent || '');

        if (hrefMatches && isVisible(element) && !isBlockedUi(element)) {
          return targetInfo(element, text, href);
        }
      }

      if (targetId) {
        const anchors = Array.from(document.querySelectorAll('a[href]'))
          .filter(anchor => {
            try {
              return isVisible(anchor) && !isBlockedUi(anchor) && pathMatchesChapter(new URL(anchor.getAttribute('href'), location.href).pathname);
            } catch {
              return false;
            }
          });
        if (anchors.length) {
          const anchor = anchors.sort((a, b) => {
            const ar = a.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            return (ar.width * ar.height) - (br.width * br.height);
          })[0];
          return targetInfo(anchor, normalize(anchor.innerText || anchor.textContent || ''), anchor.getAttribute('href') || '');
        }
      }

      return null;
    }, { targetPath: chapterPath }).catch(() => null);

    if (target) {
      console.log(chalk.gray(`  Clicking chapter control (${target.tag || '?'}): ${target.text || target.href || chapterPath}`));
      await page.mouse.move(target.x, target.y).catch(() => {});
      await page.mouse.down().catch(() => {});
      await page.waitForTimeout(50);
      await page.mouse.up().catch(() => {});
      await page.waitForTimeout(800);
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) active.blur();
      }).catch(() => {});
      if (new URL(page.url()).pathname === chapterPath) return true;
      if (await hasChapterReader(page, chapterPath, new URL(page.url()).pathname, mangaPath)) return true;
      if (mangaPath && isWrongMangaChapterUrl(page.url(), mangaPath, chapterPath)) {
        console.log(chalk.yellow('  Clicked a chapter from another manga; returning to the selected manga page.'));
        await navigate(page, BASE_URL + mangaPath).catch(() => {});
        continue;
      }
      await page.evaluate(({ targetPath, href }) => {
        if (href) {
          const link = Array.from(document.querySelectorAll('a[href]')).find(anchor => {
            try {
              return new URL(anchor.getAttribute('href'), location.href).pathname === targetPath;
            } catch {
              return false;
            }
          });
          if (link) link.click();
        }
      }, { targetPath: chapterPath, href: target.href }).catch(() => {});
      await page.waitForTimeout(800);
      if (new URL(page.url()).pathname === chapterPath) return true;
      if (await hasChapterReader(page, chapterPath, new URL(page.url()).pathname, mangaPath)) return true;
      if (mangaPath && isWrongMangaChapterUrl(page.url(), mangaPath, chapterPath)) {
        console.log(chalk.yellow('  Clicked a chapter from another manga; returning to the selected manga page.'));
        await navigate(page, BASE_URL + mangaPath).catch(() => {});
        continue;
      }
    }

    await scrollMangaPage(page);
    await page.waitForTimeout(150);
  }

  return false;
}

async function openChapterRouteInApp(page, chapterPath) {
  await page.evaluate((targetPath) => {
    const fullUrl = `${location.origin}${targetPath}`;
    const link = document.createElement('a');
    link.href = fullUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.history.pushState({}, '', targetPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, chapterPath).catch(() => {});
  await page.waitForTimeout(1000);
}

function isWrongMangaChapterUrl(url, mangaPath, chapterPath = '') {
  try {
    const pathName = new URL(url).pathname;
    return pathName.includes('/chapters/') &&
      pathName !== chapterPath &&
      !pathName.startsWith(mangaPath + '/');
  } catch {
    return false;
  }
}

async function waitForChapterReader(page, chapterPath, mangaPath = '', timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.isClosed && page.isClosed()) return false;
    const currentPath = new URL(page.url()).pathname;
    if (mangaPath && isWrongMangaChapterUrl(page.url(), mangaPath, chapterPath)) return false;
    if (await hasCloudflareErrorPage(page)) return false;
    if (await hasChapterReader(page, chapterPath, currentPath, mangaPath)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function hasCloudflareErrorPage(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || '').toLowerCase();
    const title = String(document.title || '').toLowerCase();
    return text.includes('error code 522') ||
      text.includes('connection timed out') ||
      text.includes('cloudflare') && text.includes('host error') ||
      title.includes('522') ||
      title.includes('connection timed out');
  }).catch(() => false);
}

async function isBlankChapterRoute(page, chapterPath) {
  return page.evaluate((expectedPath) => {
    if (location.pathname !== expectedPath) return false;
    const hasReaderMedia = Array.from(document.querySelectorAll('canvas,img')).some(element => {
      const rect = element.getBoundingClientRect();
      const width = element.tagName === 'IMG' ? element.naturalWidth : element.width;
      const height = element.tagName === 'IMG' ? element.naturalHeight : element.height;
      return width >= 240 && height >= 240 && rect.width >= 120 && rect.height >= 120;
    });
    if (hasReaderMedia) return false;
    const text = String(document.body?.innerText || '').trim();
    return text.length < 200;
  }, chapterPath).catch(() => false);
}

async function recoverBlankChapterRoute(page, mangaUrl, chapterPath, chapterTitle, mangaPath) {
  console.log(chalk.yellow('  Chapter route is blank; trying automatic back/reopen recovery...'));

  for (let attempt = 0; attempt < 4; attempt++) {
    if (await hasCloudflareErrorPage(page)) {
      const waitMs = 8000 + attempt * 5000;
      console.log(chalk.yellow(`  Cloudflare/host timeout detected; waiting ${Math.round(waitMs / 1000)}s before retry...`));
      await page.waitForTimeout(waitMs);
    }

    if (attempt === 0) {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    const currentPath = new URL(page.url()).pathname;
    if (!currentPath.startsWith(mangaPath)) {
      await navigate(page, mangaUrl).catch(() => {});
    }

    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(700);
    await expandChapterList(page);
    const clicked = await clickChapterLinkFromManga(page, chapterPath, chapterTitle, mangaPath);
    if (clicked && await waitForChapterReader(page, chapterPath, mangaPath, 12000)) {
      return true;
    }

    await openChapterRouteInApp(page, chapterPath);
    if (await waitForChapterReader(page, chapterPath, mangaPath, 8000)) {
      return true;
    }
    if (await isBlankChapterRoute(page, chapterPath)) {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    }

    await navigate(page, mangaUrl).catch(() => {});
  }

  console.log(chalk.gray('  Automatic recovery did not open the reader.'));
  return false;
}

async function waitForManualChapterOpen(page, chapterPath, mangaPath = '') {
  console.log(chalk.yellow('  Tool chua tu mo duoc reader. Hay click chapter trong cua so Coc Coc; tool se doi 90 giay...'));
  return waitForChapterReader(page, chapterPath, mangaPath, 90000);
}

async function hasChapterReader(page, chapterPath = '', currentPath = '', mangaPath = '') {
  return page.evaluate(({ expectedPath, pathNow, expectedMangaPath }) => {
    const onExpectedChapter = !expectedPath ||
      pathNow === expectedPath ||
      location.pathname === expectedPath ||
      (expectedMangaPath && location.pathname.startsWith(expectedMangaPath + '/chapters/'));
    if (!onExpectedChapter) return false;

    const canvases = Array.from(document.querySelectorAll('canvas'))
      .filter(canvas => {
        const rect = canvas.getBoundingClientRect();
        return canvas.width >= 240 &&
          canvas.height >= 240 &&
          rect.width >= 240 &&
          rect.height >= 240;
      });
    if (canvases.length > 0) return true;

    const images = Array.from(document.querySelectorAll('img'))
      .filter(img => {
        const rect = img.getBoundingClientRect();
        const ratio = Math.max(rect.height, img.naturalHeight || 0) / Math.max(1, Math.max(rect.width, img.naturalWidth || 0));
        return img.complete &&
          img.naturalWidth >= 240 &&
          img.naturalHeight >= 240 &&
          rect.width >= 240 &&
          rect.height >= 240 &&
          ratio >= 1.15;
      });
    return images.length > 0;
  }, { expectedPath: chapterPath, pathNow: currentPath, expectedMangaPath: mangaPath }).catch(() => false);
}

async function scrollMangaPage(page) {
  await page.evaluate(() => {
    const scrollables = Array.from(document.querySelectorAll('*'))
      .filter(element => element.scrollHeight > element.clientHeight + 80)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

    window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 1.2)));
    for (const element of scrollables.slice(0, 5)) {
      element.scrollTop += Math.max(700, Math.floor(element.clientHeight * 1.2));
    }
  }).catch(() => {});
}

async function expandChapterList(page) {
  for (let i = 0; i < 8; i++) {
    const clicked = await page.evaluate(() => {
      function normalize(text) {
        return String(text || '')
          .normalize('NFKC')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
      }

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 10 &&
          rect.height > 10 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity || 1) > 0;
      }

      function isBlockedUi(element) {
        let current = element;
        for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
          const tag = current.tagName;
          const rect = current.getBoundingClientRect();
          const style = window.getComputedStyle(current);
          const attrs = normalize([
            tag,
            current.getAttribute('role') || '',
            current.getAttribute('aria-label') || '',
            current.getAttribute('placeholder') || '',
            current.getAttribute('title') || '',
            current.id || '',
            current.className?.toString?.() || ''
          ].join(' '));
          const text = normalize(current.innerText || current.textContent || '');
          const isSearchUi = attrs.includes('search') ||
            attrs.includes('tim') ||
            text.includes('tim kiem') ||
            text.includes('search');
          const isTopChrome = (tag === 'HEADER' || tag === 'NAV' || style.position === 'fixed' || style.position === 'sticky') &&
            rect.top <= 180;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'FORM' || isSearchUi || isTopChrome) {
            return true;
          }
        }
        return false;
      }

      const controls = Array.from(document.querySelectorAll('button, a, [role="button"], .cursor-pointer'));
      const button = controls.find(element => {
        const text = normalize(element.innerText || element.textContent || '');
        return isVisible(element) &&
          !isBlockedUi(element) &&
          (text.includes('xem them') || text.includes('load more'));
      });

      if (!button) return false;
      button.scrollIntoView({ block: 'center', inline: 'center' });
      button.click();
      return true;
    }).catch(() => false);

    if (!clicked) break;
    console.log(chalk.gray('  Clicked "Xem thêm" to expand chapter list.'));
    await page.waitForTimeout(600);
  }
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function makeChapterTitleCandidates(normalizedTitle) {
  const candidates = new Set();
  if (normalizedTitle) candidates.add(normalizedTitle);

  const chapterMatch = normalizedTitle.match(/(?:chapter|chap|ch\.?|c\.?)\s*(\d+(?:\.\d+)?)/i);
  if (chapterMatch) {
    const n = chapterMatch[1];
    candidates.add(`chapter ${n}`);
    candidates.add(`chap ${n}`);
    candidates.add(`ch ${n}`);
    candidates.add(`chương ${n}`);
    candidates.add(`chuong ${n}`);
  }

  const chuongMatch = normalizedTitle.match(/(?:chương|chuong)\s*(\d+(?:\.\d+)?)/i);
  if (chuongMatch) {
    const n = chuongMatch[1];
    candidates.add(`chapter ${n}`);
    candidates.add(`chap ${n}`);
    candidates.add(`chương ${n}`);
    candidates.add(`chuong ${n}`);
  }

  return Array.from(candidates).filter(Boolean);
}

async function captureRenderedCanvases(page, opts = {}) {
  const expectedCount = Number(opts.expectedCount || 0);
  await page.waitForTimeout(250);
  await prepareReaderForCleanCapture(page);

  const images = await captureRenderedElementsWhileScrolling(page, 'canvas', {
    expectedCount,
    forceFullScan: Boolean(opts.forceFullScan)
  });
  if (expectedCount && images.length > 0 && images.length < expectedCount) {
    console.log(chalk.yellow(`  Canvas capture got ${images.length}/${expectedCount}; not using source <img> fallback.`));
  }
  if (!images.length) {
    console.log(chalk.yellow('  No canvas captured; source <img> fallback is disabled to avoid cut/tiled images.'));
  }
  return images;
}

async function captureRenderedElementsWhileScrolling(page, selector, opts = {}) {
  const expectedCount = Number(opts.expectedCount || 0);
  const forceFullScan = Boolean(opts.forceFullScan);
  const captured = [];
  const seen = new Set();
  const seenElementKeys = new Set();
  let order = 0;
  let noNewSteps = 0;
  let noScrollProgressSteps = 0;
  const startedAt = Date.now();
  const maxCaptureMs = Number(process.env.CUUTRUYEN_CAPTURE_TIMEOUT_MS || (forceFullScan ? 300000 : 180000));

  await prepareReaderForCleanCapture(page);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const scrollables = Array.from(document.querySelectorAll('*'))
      .filter(element => {
        const style = window.getComputedStyle(element);
        const canScroll = /(auto|scroll)/i.test(`${style.overflowY} ${style.overflow}`);
        return canScroll && element.scrollHeight > element.clientHeight + 120 && element.clientHeight > 250;
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    for (const element of scrollables.slice(0, 8)) {
      element.scrollTop = 0;
    }
  });
  await page.waitForTimeout(450);

  const pageInfo = await page.evaluate(() => ({
    scrollHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
    innerHeight: window.innerHeight
  })).catch(() => ({ scrollHeight: 0, innerHeight: 800 }));
  const estimatedSteps = Math.ceil((pageInfo.scrollHeight || 0) / Math.max(700, (pageInfo.innerHeight || 800) * 0.85)) + 12;
  const expectedSteps = expectedCount > 0 ? expectedCount * (forceFullScan ? 7 : 5) : 0;
  const maxSteps = Math.max(forceFullScan ? 60 : 36, Math.min(forceFullScan ? 240 : 180, expectedSteps || estimatedSteps || 64));

  for (let step = 0; step < maxSteps; step++) {
    if (Date.now() - startedAt > maxCaptureMs && captured.length > 0) {
      console.log(chalk.yellow(`  Capture timeout reached after ${captured.length} ${selector} image(s); saving what was captured.`));
      break;
    }
    const beforeCount = captured.length;
    await prepareReaderForCleanCapture(page);
    const handles = await page.$$(selector);

    for (const handle of handles) {
      const meta = await handle.evaluate(element => {
        if (!element.dataset.cuutruyenCaptureKey) {
          element.dataset.cuutruyenCaptureKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);

        // Compute stable coordinates that remain constant under parent scrolling
        let stableY = rect.top + window.scrollY;
        let stableX = rect.left + window.scrollX;
        let current = element.parentElement;
        while (current) {
          stableY += current.scrollTop;
          stableX += current.scrollLeft;
          current = current.parentElement;
        }

        return {
          key: element.dataset.cuutruyenCaptureKey,
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          viewportHeight: window.innerHeight,
          y: stableY,
          x: stableX,
          src: element.tagName === 'IMG' ? element.currentSrc || element.src || '' : '',
          display: style.display,
          visibility: style.visibility,
          opacity: Number(style.opacity || 1),
          complete: element.tagName === 'IMG' ? element.complete : true,
          naturalWidth: element.tagName === 'IMG' ? element.naturalWidth : element.width,
          naturalHeight: element.tagName === 'IMG' ? element.naturalHeight : element.height
        };
      }).catch(() => null);

      if (!meta) continue;
      if (meta.display === 'none' || meta.visibility === 'hidden' || meta.opacity === 0) continue;
      if (!meta.complete) continue;
      if (meta.width < 240 || meta.height < 240) continue;
      if (meta.naturalWidth < 240 || meta.naturalHeight < 240) continue;

      const elementKey = `${selector}:${meta.key || meta.src}:${Math.round(meta.y)}:${Math.round(meta.width)}x${Math.round(meta.height)}`;
      if (seenElementKeys.has(elementKey)) continue;

      await handle.evaluate(element => {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        let current = element.parentElement;
        for (let depth = 0; current && depth < 8; depth++, current = current.parentElement) {
          if (current.scrollHeight > current.clientHeight + 80) {
            const rect = element.getBoundingClientRect();
            const parentRect = current.getBoundingClientRect();
            current.scrollTop += rect.top - parentRect.top - Math.max(0, (current.clientHeight - rect.height) / 2);
          }
        }
      }).catch(() => {});
      if (selector === 'canvas') {
        let blankQuality = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          blankQuality = await getCanvasContentQuality(handle);
          if (!blankQuality?.blankDark) break;
          await page.waitForTimeout(100);
        }
        if (blankQuality?.blankDark) {
          continue;
        }
      } else {
        await page.waitForTimeout(50);
      }
      await prepareReaderForCleanCapture(page);

      let dataUrl = '';
      let buffer = null;
      if (selector === 'canvas') {
        dataUrl = await handle.evaluate(element => {
          try {
            return element.toDataURL('image/png');
          } catch {
            return '';
          }
        }).catch(() => '');
        if (dataUrl && dataUrl.startsWith('data:image/')) {
          const base64 = dataUrl.split(',')[1] || '';
          buffer = Buffer.from(base64, 'base64');
        }
      }

      if (!buffer || buffer.length < 1024) {
        buffer = await handle.screenshot({ type: 'png', omitBackground: false }).catch(() => null);
        if (buffer && buffer.length >= 1024) {
          dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
        }
      }
      if (!buffer || buffer.length < 1024 || !dataUrl) continue;

      const outputQuality = await getDataUrlContentQuality(page, dataUrl);
      if (outputQuality?.blankDark) {
        continue;
      }

      const hash = crypto.createHash('sha1').update(buffer).digest('hex');
      if (seen.has(hash)) continue;
      seen.add(hash);
      seenElementKeys.add(elementKey);

      captured.push({
        order: order++,
        y: meta.y,
        x: meta.x || 0,
        dataUrl
      });

      if (expectedCount > 0 && captured.length >= expectedCount) break;
    }

    if (expectedCount > 0 && captured.length >= expectedCount) {
      console.log(chalk.gray(`  Captured expected ${expectedCount} ${selector} image(s).`));
      break;
    }

    if (captured.length === beforeCount) {
      noNewSteps++;
    } else {
      noNewSteps = 0;
      console.log(chalk.gray(`  Captured ${captured.length} ${selector} image(s)...`));
    }

    const info = await page.evaluate(() => {
      const scrollHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const before = window.scrollY;
      const distance = Math.max(650, Math.floor(window.innerHeight * 0.82));
      window.scrollBy(0, distance);
      const moved = Math.abs(window.scrollY - before);

      const scrollables = Array.from(document.querySelectorAll('*'))
        .filter(element => {
          const style = window.getComputedStyle(element);
          const canScroll = /(auto|scroll)/i.test(`${style.overflowY} ${style.overflow}`);
          return canScroll && element.scrollHeight > element.clientHeight + 120 && element.clientHeight > 250;
        })
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
        .slice(0, 8);

      let containerMoved = 0;
      for (const element of scrollables) {
        const beforeTop = element.scrollTop;
        const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = Math.min(element.scrollTop + distance, maxScrollTop);
        containerMoved += Math.abs(element.scrollTop - beforeTop);
      }

      return {
        before,
        after: window.scrollY,
        scrollHeight,
        innerHeight: window.innerHeight,
        moved,
        containerMoved,
        scrollableCount: scrollables.length,
        maxContainerRemaining: scrollables.reduce((max, element) => {
          const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
          return Math.max(max, remaining);
        }, 0)
      };
    });

    await page.waitForTimeout(220);

    const atBottom = info.after + info.innerHeight >= info.scrollHeight - 10;
    const cannotScroll = info.moved < 2 && info.containerMoved < 2;
    if (cannotScroll) noScrollProgressSteps++; else noScrollProgressSteps = 0;
    const likelyReaderBottom = atBottom && (!info.scrollableCount || info.maxContainerRemaining < 40);
    if (
      (!expectedCount && noNewSteps >= (forceFullScan ? 8 : 5)) ||
      (expectedCount > 0 && captured.length >= expectedCount && noNewSteps >= 1) ||
      (expectedCount > 0 && captured.length < expectedCount && noNewSteps >= (forceFullScan ? 18 : 12) && noScrollProgressSteps >= (forceFullScan ? 7 : 5))
    ) break;
    if (likelyReaderBottom || cannotScroll) {
      await page.waitForTimeout(650);
      const extraCount = await page.$$eval(selector, elements => elements.length).catch(() => 0);
      if (!extraCount || ((likelyReaderBottom || cannotScroll) && (!expectedCount || captured.length >= expectedCount || noNewSteps >= 4))) break;
    }
  }

  captured.sort((a, b) => {
    // Sắp xếp theo trục Y (từ trên xuống dưới)
    if (Math.abs(a.y - b.y) > 15) {
      return a.y - b.y;
    }
    // Nếu cùng hàng Y, sắp xếp theo trục X (từ trái qua phải)
    return a.x - b.x;
  });
  const images = captured.map(item => item.dataUrl);
  return expectedCount > 0 ? images.slice(0, expectedCount) : images;
}

async function getCanvasContentQuality(handle) {
  return handle.evaluate(element => {
    if (element.tagName !== 'CANVAS') return { blankDark: false };
    const width = element.width || 0;
    const height = element.height || 0;
    if (width < 16 || height < 16) return { blankDark: true };

    try {
      const sampleSize = 64;
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = sampleSize;
      sampleCanvas.height = sampleSize;
      const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
      sampleCtx.drawImage(element, 0, 0, sampleSize, sampleSize);
      const pixels = sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data;
      let dark = 0;
      let transparent = 0;
      let minLuma = 255;
      let maxLuma = 0;
      let opaquePixels = 0;
      const total = sampleSize * sampleSize;

      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];
        if (a < 8) {
          transparent++;
          continue;
        }
        opaquePixels++;
        const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        if (luma <= 18) dark++;
        if (luma < minLuma) minLuma = luma;
        if (luma > maxLuma) maxLuma = luma;
      }

      const opaqueTotal = Math.max(1, total - transparent);
      const darkRatio = dark / opaqueTotal;
      const transparentRatio = transparent / total;
      const lumaSpread = opaquePixels > 0 ? maxLuma - minLuma : 0;
      const mostlyTransparent = transparentRatio > 0.985;
      const nearlyFlat = opaquePixels > 0 && lumaSpread <= 10;
      return {
        blankDark: mostlyTransparent || nearlyFlat || (darkRatio > 0.985 && lumaSpread < 28),
        darkRatio,
        transparentRatio,
        lumaSpread
      };
    } catch {
      return { blankDark: false, unreadable: true };
    }
  }).catch(() => ({ blankDark: false, unreadable: true }));
}

async function getDataUrlContentQuality(page, dataUrl) {
  return page.evaluate(async (src) => {
    function sampleCanvas(canvas) {
      const sampleSize = 64;
      const sampleCanvas = document.createElement('canvas');
      sampleCanvas.width = sampleSize;
      sampleCanvas.height = sampleSize;
      const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
      sampleCtx.drawImage(canvas, 0, 0, sampleSize, sampleSize);
      const pixels = sampleCtx.getImageData(0, 0, sampleSize, sampleSize).data;
      let dark = 0;
      let transparent = 0;
      let minLuma = 255;
      let maxLuma = 0;
      let opaquePixels = 0;
      const total = sampleSize * sampleSize;

      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];
        if (a < 8) {
          transparent++;
          continue;
        }
        opaquePixels++;
        const luma = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        if (luma <= 22) dark++;
        if (luma < minLuma) minLuma = luma;
        if (luma > maxLuma) maxLuma = luma;
      }

      const opaqueTotal = Math.max(1, total - transparent);
      const darkRatio = dark / opaqueTotal;
      const transparentRatio = transparent / total;
      const lumaSpread = opaquePixels > 0 ? maxLuma - minLuma : 0;
      const mostlyTransparent = transparentRatio > 0.985;
      const nearlyFlat = opaquePixels > 0 && lumaSpread <= 12;
      return {
        blankDark: mostlyTransparent || nearlyFlat || (darkRatio > 0.975 && lumaSpread < 36),
        darkRatio,
        transparentRatio,
        lumaSpread
      };
    }

    try {
      const img = new Image();
      img.decoding = 'sync';
      const loaded = new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      img.src = src;
      await loaded;
      if (img.naturalWidth < 16 || img.naturalHeight < 16) return { blankDark: true };
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return sampleCanvas(canvas);
    } catch {
      return { blankDark: false, unreadable: true };
    }
  }, dataUrl).catch(() => ({ blankDark: false, unreadable: true }));
}

async function prepareReaderForCleanCapture(page) {
  await page.evaluate(() => {
    const STYLE_ID = 'cuutruyen-tool-clean-capture-style';
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = `
        html, body {
          background: #fff !important;
          scroll-behavior: auto !important;
        }
        *, *::before, *::after {
          animation: none !important;
          transition: none !important;
        }
        header,
        nav,
        aside,
        form,
        input,
        textarea,
        select,
        button,
        [role="button"],
        [role="search"],
        [aria-label*="search" i],
        [aria-label*="tìm" i],
        [class*="header" i],
        [class*="navbar" i],
        [class*="navigation" i],
        [class*="search" i],
        [class*="chapter" i][class*="nav" i],
        [class*="reader" i][class*="nav" i],
        [class*="pagination" i],
        [class*="messenger" i],
        [class*="floating" i],
        [class*="fab" i],
        iframe {
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `;
      document.documentElement.appendChild(style);
    }

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const candidates = Array.from(document.body.querySelectorAll('*'));
    for (const element of candidates) {
      if (element.id === STYLE_ID) continue;
      if (element.tagName === 'CANVAS' || element.tagName === 'IMG') continue;

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const text = String(element.innerText || element.textContent || '').toLowerCase();
      const isOverlayPosition = style.position === 'fixed' || style.position === 'sticky';
      const isTopBar = rect.top <= 90 && rect.height <= 180 && rect.width >= viewportW * 0.45;
      const isBottomBar = rect.bottom >= viewportH - 110 && rect.height <= 160 && rect.width >= viewportW * 0.25;
      const isSearch = text.includes('tìm kiếm') || text.includes('tim kiem') || text.includes('search');
      const isChapterControl = text.includes('chương') || text.includes('chuong') || text.includes('tiếp') || text.includes('tiep');
      const isTinyFloating = rect.width <= 260 && rect.height <= 180 && (rect.right >= viewportW - 120 || rect.bottom >= viewportH - 120);

      if (isOverlayPosition || isSearch || (isTopBar && !isChapterControl) || isBottomBar || isTinyFloating) {
        element.setAttribute('data-cuutruyen-tool-hidden', '1');
        element.style.setProperty('visibility', 'hidden', 'important');
        element.style.setProperty('opacity', '0', 'important');
        element.style.setProperty('pointer-events', 'none', 'important');
      }
    }
  }).catch(() => {});
}

async function getFollowedMangaList(page, opts = {}) {
  const { pageNum = 1, perPage = 20 } = opts;

  // Try to use direct Node API with cached auth token
  try {
    const apiPath = `/api/v2/mangas/following?page=${pageNum}&per_page=${perPage}`;
    const json = await apiGet(apiPath);
    const items = mapMangaItems(json.data || []);
    return { 
      items, 
      totalPages: json._metadata?.total_pages || 1, 
      totalCount: json._metadata?.total_count || items.length 
    };
  } catch (err) {
    console.log(chalk.gray(`  Node API followed list failed: ${err.message}`));
  }

  // Fallback to browser evaluation
  if (!page) {
    throw new Error('Đăng nhập phiên API đã hết hạn. Hãy chạy browser để đồng bộ lại thông tin đăng nhập.');
  }
  await ensureConnected(page);

  const result = await page.evaluate(async ({ pageNum, perPage, baseUrl }) => {
    try {
      // Get auth from IndexedDB inside browser context
      const authData = await new Promise((resolve) => {
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

      if (!authData || authData.length === 0) {
        throw new Error('Không tìm thấy phiên đăng nhập trong trình duyệt. Vui lòng đăng nhập Cứu Truyện trước.');
      }

      const uid = String(authData[0].user.id);
      const token = authData[0].authToken;

      const apiUrl = `${baseUrl}/api/v2/mangas/following?page=${pageNum}&per_page=${perPage}`;
      let res = null;
      for (const delay of [0, 5000, 12000, 25000]) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        res = await fetch(apiUrl, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'cuutruyen-client': 'OfficialWebApp-20250805',
            'm4u_uid': uid,
            'm4u_token': token
          }
        });
        if (res.status !== 429) break;
      }
      if (!res.ok) throw new Error(`Followed list API Error: ${res.status}`);
      const json = await res.json();
      const data = json.data || [];

      return {
        error: null,
        items: data.map(item => ({
          url: `${baseUrl}/mangas/${item.id}`,
          title: item.name || '',
          cover: item.cover_url || item.cover_mobile_url || '',
          status: item.status || ''
        })),
        totalPages: json._metadata?.total_pages || 1,
        totalCount: json._metadata?.total_count || data.length
      };
    } catch (err) {
      return { error: err.toString(), items: [], totalPages: 1, totalCount: 0 };
    }
  }, { pageNum, perPage, baseUrl: BASE_URL });

  if (result.error) {
    throw new Error(`Lấy danh sách theo dõi từ API thất bại (${result.error}). Hãy đảm bảo bạn đã đăng nhập.`);
  }

  return { items: result.items, totalPages: result.totalPages, totalCount: result.totalCount };
}

async function getAllFollowedMangaList(page) {
  let pageNum = 1;
  const allItems = [];
  while (true) {
    const { items, totalPages } = await getFollowedMangaList(page, { pageNum, perPage: 50 });
    if (!items || items.length === 0) break;
    allItems.push(...items);
    if (pageNum >= totalPages) break;
    pageNum++;
  }
  return allItems;
}

module.exports = {
  getMangaList,
  getMangaListPages,
  getMangaChapters,
  getChapterImages,
  collectImageUrls,
  absoluteUrl,
  getFollowedMangaList,
  getAllFollowedMangaList,
  BASE_URL
};
