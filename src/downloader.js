'use strict';
/**
 * downloader.js — Tải ảnh và đóng gói ZIP
 *
 * Output: ./downloads/TenTruyen_chap0001.zip
 */

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const JSZip = require('jszip');
const chalk = require('chalk');

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_RETRIES = 3;

// ─────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────

/**
 * Làm sạch tên file (xóa ký tự đặc biệt)
 */
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim()
    .replace(/^_|_$/g, '')
    .substring(0, 100);
}

/**
 * Tạo tên ZIP theo format: TenTruyen_chap0001.zip
 * @param {string} mangaTitle
 * @param {string|number} chapterNum
 */
function buildZipName(mangaTitle, chapterNum) {
  const safeName = sanitizeFilename(mangaTitle) || 'unknown';
  let chapStr = '';
  if (chapterNum !== null && chapterNum !== undefined && chapterNum !== '') {
    const num = parseFloat(chapterNum);
    if (!isNaN(num)) {
      // Nếu là số nguyên: 0001, nếu có thập phân: 0001.5
      chapStr = Number.isInteger(num)
        ? String(Math.floor(num)).padStart(4, '0')
        : String(Math.floor(num)).padStart(4, '0') + '.' + String(num).split('.')[1];
    } else {
      chapStr = sanitizeFilename(String(chapterNum));
    }
  }
  return chapStr ? `${safeName}_chap${chapStr}.zip` : `${safeName}.zip`;
}

function buildFolderName(mangaTitle, chapterNum) {
  return buildZipName(mangaTitle, chapterNum).replace(/\.zip$/i, '');
}

/**
 * Tạo thư mục output nếu chưa có
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Tải 1 ảnh với retry
 * @param {string} url
 * @param {object} opts
 */
async function fetchImage(url, opts = {}) {
  // Hỗ trợ Data URL từ NutAID
  if (url.startsWith('data:')) {
    const base64Data = url.split(',')[1];
    return Buffer.from(base64Data, 'base64');
  }

  const { referer = '', retries = DEFAULT_RETRIES, cookieHeader = '' } = opts;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: {
          'Referer': referer || 'https://cuutruyen.net/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          'Sec-Fetch-Dest': 'image',
          'Sec-Fetch-Mode': 'no-cors',
          'Sec-Fetch-Site': 'cross-site',
        }
      });
      return Buffer.from(res.data);
    } catch (e) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1000 * attempt)); // exponential backoff
      } else {
        throw e;
      }
    }
  }
}

/**
 * Đoán extension từ Content-Type hoặc URL
 */
function guessExtension(url, contentType = '') {
  if (url.startsWith('data:image/png')) return '.png';
  if (url.startsWith('data:image/jpeg') || url.startsWith('data:image/jpg')) return '.jpg';
  if (url.startsWith('data:image/webp')) return '.webp';
  if (url.startsWith('data:image/gif')) return '.gif';
  if (url.startsWith('data:image/avif')) return '.avif';

  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('avif')) return '.avif';

  const urlLower = url.toLowerCase();
  if (urlLower.includes('.png')) return '.png';
  if (urlLower.includes('.webp')) return '.webp';
  if (urlLower.includes('.gif')) return '.gif';
  if (urlLower.includes('.avif')) return '.avif';

  return '.jpg'; // default
}

// ─────────────────────────────────────────────────────────
//  Main Download Function
// ─────────────────────────────────────────────────────────

/**
 * Tải tất cả ảnh của 1 chapter và đóng gói ZIP
 *
 * @param {string[]} imageUrls - danh sách URL ảnh
 * @param {string} mangaTitle - tên truyện
 * @param {string|number} chapterNum - số chapter
 * @param {object} opts
 * @param {string} opts.outputDir - thư mục lưu (default: ./downloads)
 * @param {number} opts.concurrency - số ảnh tải đồng thời (default: 10)
 * @param {string} opts.referer - referer header
 * @param {function} opts.onProgress - callback(done, total)
 * @returns {{ zipPath: string, successCount: number, failCount: number }}
 */
async function downloadChapterToZip(imageUrls, mangaTitle, chapterNum, opts = {}) {
  const {
    outputDir = './downloads',
    concurrency = DEFAULT_CONCURRENCY,
    referer = 'https://cuutruyen.net/',
    cookieHeader = '',
    onProgress = null,
    format = 'folder'
  } = opts;

  ensureDir(outputDir);

  const zipName = buildZipName(mangaTitle, chapterNum);
  const zipPath = path.resolve(outputDir, zipName);
  const folderName = buildFolderName(mangaTitle, chapterNum);
  const folderPath = path.resolve(outputDir, folderName);
  const outputRoot = path.resolve(outputDir);
  let successCount = 0;
  let failCount = 0;
  let done = 0;
  const total = imageUrls.length;

  // Tải song song với giới hạn concurrency
  async function processQueue(urls) {
    const results = new Array(urls.length).fill(null);
    let idx = 0;

    async function worker() {
      while (idx < urls.length) {
        const i = idx++;
        const url = urls[i];
        try {
          const buf = await fetchImage(url, { referer, cookieHeader });
          results[i] = buf;
          successCount++;
        } catch (e) {
          results[i] = null;
          failCount++;
        }
        done++;
        if (onProgress) onProgress(done, total);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, urls.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  const buffers = await processQueue(imageUrls);

  if (format === 'folder') {
    if (!folderPath.startsWith(outputRoot + path.sep)) {
      throw new Error(`Unsafe output folder: ${folderPath}`);
    }
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
    ensureDir(folderPath);
    for (let i = 0; i < buffers.length; i++) {
      if (!buffers[i]) continue;
      const filename = `${String(i + 1).padStart(4, '0')}${guessExtension(imageUrls[i])}`;
      fs.writeFileSync(path.join(folderPath, filename), buffers[i]);
    }

    return {
      zipPath: folderPath,
      zipName: folderName,
      outputPath: folderPath,
      outputName: folderName,
      outputType: 'folder',
      successCount,
      failCount
    };
  }

  // Thêm vào ZIP
  const zip = new JSZip();
  for (let i = 0; i < buffers.length; i++) {
    if (!buffers[i]) continue;
    const filename = `${String(i + 1).padStart(4, '0')}${guessExtension(imageUrls[i])}`;
    zip.file(filename, buffers[i]);
  }

  // Ghi ZIP
  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'STORE', // không compress để giữ quality ảnh
    streamFiles: true
  });
  fs.writeFileSync(zipPath, zipBuffer);

  return {
    zipPath,
    zipName,
    outputPath: zipPath,
    outputName: zipName,
    outputType: 'zip',
    successCount,
    failCount
  };
}

module.exports = {
  downloadChapterToZip,
  buildZipName,
  buildFolderName,
  sanitizeFilename,
  ensureDir
};
