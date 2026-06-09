#!/usr/bin/env node
'use strict';
/**
 * cli.js — CuuTruyen Tool CLI
 *
 * Commands:
 *   node cli.js interactive              ← Menu tương tác (khuyên dùng)
 *   node cli.js list [--page N] [--search "từ khóa"]
 *   node cli.js chapters <manga-url>
 *   node cli.js download <chapter-url> [--output ./downloads]
 *   node cli.js download-all <manga-url> [--from N] [--to N]
 *   node cli.js check-ollama            ← Kiểm tra Ollama
 *   node cli.js history                 ← Xem lịch sử tải
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const Table = require('cli-table3');
const path = require('path');
const { Select, Input } = require('enquirer');

const { createCuuTruyenPage, closeBrowser } = require('./src/browser');
const { getMangaList, getMangaListPages, getMangaChapters, getChapterImages, BASE_URL } = require('./src/scraper');
const { downloadChapterToZip, buildZipName } = require('./src/downloader');
const { checkOllamaAvailable, pullModelIfNeeded } = require('./src/captcha');
const { isAlreadyDownloaded, markDownloaded, getDownloadHistory, clearCache } = require('./src/cache');

// ─────────────────────────────────────────────────────────
//  UI Helpers
// ─────────────────────────────────────────────────────────

function printBanner() {
  console.log(chalk.cyan.bold(`
  ╔═══════════════════════════════════════╗
  ║   🌸  CuuTruyen Tool  v1.0.0  🌸     ║
  ║   Playwright + Ollama / Gemma 3       ║
  ╚═══════════════════════════════════════╝`));
  console.log('');
}

function drawProgressBar(done, total, width = 35) {
  const pct = total > 0 ? done / total : 0;
  const filled = Math.round(pct * width);
  const bar = chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(width - filled));
  const pctStr = (pct * 100).toFixed(1).padStart(5);
  process.stdout.write(`\r  [${bar}] ${pctStr}%  ${done}/${total} ảnh  `);
}

function printMangaTable(items) {
  if (!items || !items.length) {
    console.log(chalk.yellow('  Không có kết quả.'));
    return;
  }
  const t = new Table({
    head: [chalk.white('#'), chalk.white('Tên truyện'), chalk.white('Trạng thái')],
    colWidths: [4, 55, 15],
    style: { border: ['gray'] },
    wordWrap: true,
  });
  items.forEach((item, i) => {
    t.push([
      chalk.gray(i + 1),
      chalk.cyan(item.title || '?'),
      chalk.gray(item.status || '—')
    ]);
  });
  console.log(t.toString());
  console.log(chalk.gray(`  Tổng: ${items.length} truyện\n`));
}

function printChapterTable(chapters) {
  if (!chapters || !chapters.length) {
    console.log(chalk.yellow('  Chưa có chapter.'));
    return;
  }
  const t = new Table({
    head: [chalk.white('#'), chalk.white('Chapter'), chalk.white('Ngày'), chalk.white('URL')],
    colWidths: [4, 45, 12, 42],
    style: { border: ['gray'] },
    wordWrap: true,
  });
  chapters.forEach((ch, i) => {
    // Đánh dấu chapter đã tải
    const dl = isAlreadyDownloaded(ch.url);
    const mark = dl ? chalk.green('✓') : '';
    t.push([
      chalk.gray(i + 1),
      chalk.cyan(ch.title || `Ch.${ch.number || i + 1}`) + (mark ? ' ' + mark : ''),
      chalk.gray(ch.date || '—'),
      chalk.gray((ch.url || '').replace(BASE_URL, ''))
    ]);
  });
  console.log(t.toString());
  console.log(chalk.gray(`  Tổng: ${chapters.length} chapter  (✓ = đã tải)\n`));
}

// ─────────────────────────────────────────────────────────
//  Core Download Logic
// ─────────────────────────────────────────────────────────

function parseChapterSelection(input, chapters) {
  const indexes = new Set();
  const parts = String(input || '').split(',').map(part => part.trim()).filter(Boolean);

  for (const part of parts) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Math.max(1, parseInt(range[1], 10));
      const end = Math.min(chapters.length, parseInt(range[2], 10));
      const step = start <= end ? 1 : -1;
      for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
        indexes.add(n - 1);
      }
      continue;
    }

    const number = parseInt(part, 10);
    if (!Number.isNaN(number) && number >= 1 && number <= chapters.length) {
      indexes.add(number - 1);
    }
  }

  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map(index => chapters[index])
    .filter(Boolean);
}

async function filterDownloadSelection(selectedChapters) {
  const selected = (selectedChapters || []).filter(Boolean);
  const alreadyDownloaded = selected.filter(ch => isAlreadyDownloaded(ch.url));
  const pending = selected.filter(ch => !isAlreadyDownloaded(ch.url));

  if (!alreadyDownloaded.length) {
    return pending;
  }

  console.log(chalk.yellow(`  ${alreadyDownloaded.length}/${selected.length} chapter đã có dấu ✓ trong lịch sử tải.`));

  if (!pending.length) {
    const choice = await new Select({
      name: 'redownload',
      message: 'Các chapter đã chọn đều đã tải rồi. Tải lại không?',
      choices: [
        { name: 'yes', message: 'Có, tải lại' },
        { name: 'no', message: 'Không, quay lại' }
      ]
    }).run();
    return choice === 'yes' ? selected : [];
  }

  const choice = await new Select({
    name: 'includeDownloaded',
    message: `Có ${pending.length} chapter chưa tải và ${alreadyDownloaded.length} chapter đã tải. Tải lại cả chapter đã tải không?`,
    choices: [
      { name: 'no', message: 'Không, chỉ tải chapter chưa tải' },
      { name: 'yes', message: 'Có, tải lại tất cả đã chọn' }
    ]
  }).run();

  return choice === 'yes' ? selected : pending;
}

function titleFromMangaUrl(mangaUrl) {
  const value = String(mangaUrl || '');
  const match = value.match(/\/mangas\/(?:\d+\/?)?([^/?#]+)?/i);
  if (!match) return '';
  return decodeURIComponent(match[1] || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chapterNumberFromTitle(title) {
  const value = String(title || '');
  const match = value.match(/(?:chapter|chap|ch\.?|c\.?|chương|chuong)\s*(\d+(?:\.\d+)?)/i);
  return match ? match[1] : '';
}

async function downloadChapter(page, chapterUrl, outputDir, concurrency = 10, opts = {}) {
  const spinner = ora('Đang lấy danh sách ảnh...').start();

  try {
    const { imageUrls, chapterInfo } = await getChapterImages(page, chapterUrl, {
      mangaUrl: opts.mangaUrl || '',
      chapterTitle: opts.chapterTitle || '',
      chapterNumber: opts.chapterNumber || ''
    });
    if (!imageUrls || !imageUrls.length) {
      spinner.fail('Không tìm thấy ảnh nào trong chapter này.');
      return null;
    }

    let isPartial = false;
    if (chapterInfo?.expectedImageCount && imageUrls.length < chapterInfo.expectedImageCount) {
      const minRequired = Math.max(1, Math.floor(chapterInfo.expectedImageCount * 0.80));
      if (imageUrls.length >= minRequired) {
        isPartial = true;
      } else {
        spinner.fail(`Chưa capture đủ ảnh: ${imageUrls.length}/${chapterInfo.expectedImageCount} ảnh (dưới 80%). Không tải chapter này.`);
        return null;
      }
    }

    const mangaTitle =
      (chapterInfo?.mangaTitle && chapterInfo.mangaTitle !== 'unknown' ? chapterInfo.mangaTitle : '') ||
      opts.mangaTitle ||
      titleFromMangaUrl(opts.mangaUrl) ||
      'cuutruyen';
    const chapterNum = chapterInfo?.chapterNum || opts.chapterNumber || chapterNumberFromTitle(opts.chapterTitle) || '';

    if (isPartial) {
      spinner.warn(chalk.yellow(`Cảnh báo: Chỉ capture được ${imageUrls.length}/${chapterInfo.expectedImageCount} ảnh. Vẫn tiến hành tải...`));
    } else {
      spinner.succeed(`Tìm thấy ${imageUrls.length} ảnh — "${mangaTitle}" Chap ${chapterNum || '?'}`);
    }

    // Bắt đầu tải
    console.log(chalk.gray(`\n  Đang tải ${imageUrls.length} ảnh...\n`));
    process.stdout.write('  ');

    const cookies = await page.context().cookies(BASE_URL).catch(() => []);
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const result = await downloadChapterToZip(imageUrls, mangaTitle, chapterNum, {
      outputDir,
      concurrency,
      referer: BASE_URL + '/',
      cookieHeader,
      format: opts.format || 'folder',
      onProgress: drawProgressBar
    });

    process.stdout.write('\n');
    console.log(chalk.green(`\n  ✓ Đã lưu: ${result.outputPath || result.zipPath}`));
    if (result.failCount > 0) {
      console.log(chalk.yellow(`  ⚠ ${result.failCount} ảnh thất bại`));
    }

    // Lưu cache
    await markDownloaded(chapterUrl, result.outputPath || result.zipPath, result.successCount);

    return result;
  } catch (e) {
    spinner.fail(`Lỗi: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
//  Interactive Mode
// ─────────────────────────────────────────────────────────

async function runInteractive(outputDir, outputFormat = 'folder', concurrency = 10) {
  printBanner();

  let page;
  try {
    const spinner = ora('Khởi động browser...').start();
    page = await createCuuTruyenPage(true);
    spinner.succeed('Browser sẵn sàng');

    // ── Vòng lặp chính ─────────────────────────────────
    while (true) {
      console.log('');
      const action = await new Select({
        name: 'action',
        message: '🌸 CuuTruyen — Chọn hành động:',
        choices: [
          { name: 'browse', message: '📚 Duyệt danh sách truyện' },
          { name: 'search', message: '🔍 Tìm kiếm truyện' },
          { name: 'url', message: '🔗 Nhập URL truyện / chapter trực tiếp' },
          { name: 'history', message: '📋 Lịch sử tải' },
          { name: 'cookies', message: '🍪 Lấy cookies phiên đăng nhập từ browser' },
          { name: 'ollama', message: '🤖 Kiểm tra Ollama / Gemma 3' },
          { name: 'cache', message: '🗑️  Xóa cache' },
          { name: 'exit', message: '🚪 Thoát' }
        ]
      }).run();

      if (action === 'exit') break;

      // ── Browse ─────────────────────────────────────
      if (action === 'browse') {
        let pageNum = 1;
        while (true) {
          const spinner = ora(`Đang tải trang ${pageNum}...`).start();
          let loadFailed = false;
          const items = await getMangaList(page, { pageNum }).catch(e => {
            loadFailed = true;
            spinner.fail(e.message); return [];
          });
          if (!loadFailed) spinner.succeed(`Trang ${pageNum}: ${items.length} truyện`);
          printMangaTable(items);

          if (!items.length) {
            if (pageNum > 1) {
              console.log(chalk.yellow('  Không tải được trang này. Gõ retry để thử lại, prev để quay lại trang trước, hoặc back để thoát.'));
              const emptyChoice = await new Select({
                name: 'empty',
                message: 'Điều hướng:',
                choices: [
                  { name: 'retry', message: 'Thử lại trang này' },
                  { name: 'prev', message: '← Trang trước' },
                  { name: 'back', message: '↩ Quay lại' }
                ]
              }).run();
              if (emptyChoice === 'retry') continue;
              if (emptyChoice === 'prev') { pageNum = Math.max(1, pageNum - 1); continue; }
              break;
            }
            break;
          }
          const navChoice = await new Select({
            name: 'nav',
            message: 'Chọn truyện hoặc điều hướng:',
            choices: [
              ...items.map((item, i) => ({ name: String(i), message: `${i + 1}. ${item.title}` })),
              { name: 'download_page', message: '📥 Tải tất cả truyện ở trang này' },
              { name: 'download_auto', message: '🔄 Tải tự động (Từ trang này trở đi)' },
              { name: 'next', message: '→ Trang tiếp' },
              ...(pageNum > 1 ? [{ name: 'prev', message: '← Trang trước' }] : []),
              { name: 'back', message: '↩ Quay lại' }
            ]
          }).run();

          if (navChoice === 'next') { pageNum++; continue; }
          if (navChoice === 'prev') { pageNum = Math.max(1, pageNum - 1); continue; }
          if (navChoice === 'back') break;

          if (navChoice === 'download_page') {
            console.log(chalk.cyan(`\n  Bắt đầu tải tất cả ${items.length} truyện của trang ${pageNum}...`));
            for (let i = 0; i < items.length; i++) {
              const manga = items[i];
              if (page.isClosed && page.isClosed()) {
                page = await createCuuTruyenPage(true);
              }
              console.log(chalk.bold(`\n  ===== [${i + 1}/${items.length}] ${manga.title} =====`));
              await downloadMangaFromApiList(page, manga, {
                outputDir,
                outputFormat,
                concurrency,
                chapterDelay: 1500,
                from: 1,
                to: 0,
                redownload: false
              });
              if (i < items.length - 1) {
                await new Promise(r => setTimeout(r, 3000));
              }
            }
            console.log(chalk.green(`\n  ✓ Đã hoàn thành tải tất cả truyện trên trang ${pageNum}!\n`));
            continue;
          }

          if (navChoice === 'download_auto') {
            let autoPageNum = pageNum;
            console.log(chalk.cyan(`\n  Bắt đầu tải tự động từ trang ${autoPageNum} trở đi...`));
            while (true) {
              const spinner = ora(`Đang tải danh sách trang ${autoPageNum}...`).start();
              let loadFailed = false;
              const autoItems = await getMangaList(page, { pageNum: autoPageNum }).catch(e => {
                loadFailed = true;
                spinner.fail(e.message); return [];
              });
              if (loadFailed || !autoItems.length) {
                if (!loadFailed) {
                  spinner.succeed(`Hết truyện (không tìm thấy truyện ở trang ${autoPageNum})`);
                }
                break;
              }
              spinner.succeed(`Trang ${autoPageNum}: Tìm thấy ${autoItems.length} truyện`);
              printMangaTable(autoItems);

              for (let i = 0; i < autoItems.length; i++) {
                const manga = autoItems[i];
                if (page.isClosed && page.isClosed()) {
                  page = await createCuuTruyenPage(true);
                }
                console.log(chalk.bold(`\n  ===== [Trang ${autoPageNum}] [${i + 1}/${autoItems.length}] ${manga.title} =====`));
                await downloadMangaFromApiList(page, manga, {
                  outputDir,
                  outputFormat,
                  concurrency,
                  chapterDelay: 1500,
                  from: 1,
                  to: 0,
                  redownload: false
                });
                if (i < autoItems.length - 1) {
                  await new Promise(r => setTimeout(r, 3000));
                }
              }

              console.log(chalk.green(`\n  ✓ Hoàn thành trang ${autoPageNum}`));
              console.log(chalk.gray(`  Chờ 3 giây trước khi chuyển sang trang tiếp theo...`));
              await new Promise(r => setTimeout(r, 3000));
              autoPageNum++;
            }
            console.log(chalk.green(`\n  ✓ Đã hoàn thành tải tự động tất cả các trang!\n`));
            pageNum = autoPageNum;
            continue;
          }

          // Chọn truyện
          const index = parseInt(navChoice, 10);
          if (!Number.isNaN(index) && index >= 0 && index < items.length) {
            const selectedManga = items[index];
            await handleMangaSelection(page, selectedManga.url, selectedManga.title, outputDir, outputFormat, concurrency);
            continue;
          }
          break;
        }
      }

      // ── Search ─────────────────────────────────────
      if (action === 'search') {
        const keyword = await new Input({
          name: 'keyword',
          message: '🔍 Nhập tên truyện:'
        }).run();

        if (!keyword.trim()) continue;

        const spinner = ora(`Đang tìm "${keyword}"...`).start();
        const items = await getMangaList(page, { search: keyword.trim() }).catch(e => {
          spinner.fail(e.message); return [];
        });
        spinner.succeed(`${items.length} kết quả cho "${keyword}"`);
        printMangaTable(items);

        if (!items.length) continue;

        const choices = [
          ...items.map((item, i) => ({ name: String(i), message: `${i + 1}. ${item.title}` })),
          { name: 'back', message: '↩ Quay lại' }
        ];
        const sel = await new Select({ name: 's', message: 'Chọn truyện:', choices }).run();
        if (sel !== 'back') {
          const selectedManga = items[parseInt(sel)];
          if (selectedManga) await handleMangaSelection(page, selectedManga.url, selectedManga.title, outputDir, outputFormat, concurrency);
        }
      }

      // ── Direct URL ─────────────────────────────────
      if (action === 'url') {
        const rawUrl = await new Input({
          name: 'url',
          message: '🔗 Nhập URL (manga hoặc chapter):',
          initial: 'https://cuutruyen.net/'
        }).run();

        const cleanUrl = rawUrl.trim();
        if (!cleanUrl) continue;

        if (cleanUrl.includes('/chapters/')) {
          // Là chapter URL
          await downloadChapter(page, cleanUrl, outputDir, 5, {
            mangaTitle: titleFromMangaUrl(cleanUrl),
            format: outputFormat
          });
        } else if (cleanUrl.includes('/mangas/')) {
          // Là manga URL
          const titleGuess = cleanUrl.split('/mangas/')[1]?.replace(/-/g, ' ') || 'truyện';
          await handleMangaSelection(page, cleanUrl, titleGuess, outputDir, outputFormat, concurrency);
        } else {
          console.log(chalk.yellow('  URL không nhận ra. Dùng URL dạng cuutruyen.net/mangas/... hoặc /chapters/...'));
        }
      }

      // ── History ─────────────────────────────────────
      if (action === 'history') {
        const history = getDownloadHistory();
        if (!history.length) {
          console.log(chalk.gray('  Chưa có lịch sử tải.'));
        } else {
          const t = new Table({
            head: [chalk.white('#'), chalk.white('File'), chalk.white('Ảnh'), chalk.white('Thời gian')],
            colWidths: [4, 52, 6, 20],
            style: { border: ['gray'] },
            wordWrap: true,
          });
          history.forEach((h, i) => {
            t.push([
              chalk.gray(i + 1),
              chalk.cyan(path.basename(h.zip_path)),
              chalk.gray(h.image_count),
              chalk.gray(new Date(h.downloaded_at).toLocaleString('vi-VN'))
            ]);
          });
          console.log(t.toString());
        }
      }

      // ── Get Cookies ──────────────────────────────────
      if (action === 'cookies') {
        try {
          // Tạm đóng browser của Playwright để tránh xung đột
          await closeBrowser();
          require('child_process').execSync('node src/get-real-cookies.js', { stdio: 'inherit' });
        } catch (e) {
          console.log(chalk.red(`\n  Lỗi: ${e.message}`));
        }
        // Khởi động lại browser
        const spinner = ora('Khởi động lại browser...').start();
        page = await createCuuTruyenPage(true);
        spinner.succeed('Browser sẵn sàng');
      }

      // ── Ollama Check ─────────────────────────────────
      if (action === 'ollama') {
        const spinner = ora('Kiểm tra Ollama...').start();
        const status = await checkOllamaAvailable();
        if (status.available) {
          spinner.succeed(status.message);
          if (!status.hasGemma) {
            const pull = await new Select({
              name: 'pull',
              message: 'Pull gemma3:4b về không?',
              choices: [
                { name: 'yes', message: 'Có (sẽ mất vài phút)' },
                { name: 'no', message: 'Không' }
              ]
            }).run();
            if (pull === 'yes') await pullModelIfNeeded('gemma3:4b');
          }
        } else {
          spinner.fail(status.message);
          console.log(chalk.yellow('\n  💡 Xem README.md để hướng dẫn cài Ollama.\n'));
        }
      }

      // ── Clear cache ───────────────────────────────────
      if (action === 'cache') {
        await clearCache();
        console.log(chalk.green('  ✓ Đã xóa cache'));
      }
    }

  } finally {
    await closeBrowser();
  }
}

/**
 * Hiển thị chapter list và cho user chọn để tải
 */
async function handleMangaSelection(page, mangaUrl, titleHint, outputDir, outputFormat = 'folder', concurrency = 10) {
  const spinner = ora('Đang lấy danh sách chapter...').start();
  const { title, chapters } = await getMangaChapters(page, mangaUrl).catch(e => {
    spinner.fail(e.message);
    return { title: '', chapters: [] };
  });
  const mangaTitle = title || titleHint || titleFromMangaUrl(mangaUrl) || 'cuutruyen';
  spinner.succeed(`"${mangaTitle}" — ${chapters.length} chapter`);
  printChapterTable(chapters);

  if (!chapters.length) return;

  const dlChoice = await new Select({
    name: 'dl',
    message: 'Tải:',
    choices: [
      { name: 'all', message: '📦 Tải tất cả chapter' },
      { name: 'range', message: '📋 Chọn khoảng chapter (từ N đến M)' },
      { name: 'pick', message: '🔢 Chọn từng chapter' },
      { name: 'back', message: '↩ Quay lại' }
    ]
  }).run();

  if (dlChoice === 'back') return;

  let toDownload = [];

  if (dlChoice === 'all') {
    toDownload = await filterDownloadSelection(chapters);
  }

  if (dlChoice === 'range') {
    const fromStr = await new Input({ name: 'from', message: `Từ chapter (1-${chapters.length}):`, initial: '1' }).run();
    const toStr = await new Input({ name: 'to', message: `Đến chapter (1-${chapters.length}):`, initial: String(chapters.length) }).run();
    const from = Math.max(0, parseInt(fromStr) - 1);
    const to = Math.min(chapters.length - 1, parseInt(toStr) - 1);
    const selected = chapters.slice(from, to + 1);
    toDownload = await filterDownloadSelection(selected);
  }

  if (dlChoice === 'pick') {
    const pickedText = await new Input({
      name: 'chapters',
      message: 'Nhap so chapter can tai (vd: 48 hoac 39-48 hoac 1,5,10-12):'
    }).run();

    const selected = parseChapterSelection(pickedText, chapters);
    toDownload = await filterDownloadSelection(selected);
  }

  if (false && dlChoice === 'pick') {
    const termWidth = process.stdout.columns || 80;
    const choices = chapters.map((ch, i) => {
      let msg = `${(i + 1).toString().padStart(3)}. ${ch.title}`;
      const maxLen = termWidth - 10;
      if (msg.length > maxLen) {
        msg = msg.substring(0, maxLen - 3) + '...';
      }
      const downloaded = isAlreadyDownloaded(ch.url);
      
      return {
        name: String(i),
        message: msg + (downloaded ? chalk.green(' ✓') : '')
      };
    });

    // Enquirer MultiSelect
    const { MultiSelect } = require('enquirer');
    const picked = await new MultiSelect({
      name: 'chapters',
      message: 'Chọn chapter (Space để chọn, Enter để xác nhận):',
      choices,
      limit: 10
    }).run().catch(() => []);

    toDownload = picked.map(i => chapters[parseInt(i)]).filter(Boolean);
  }

  if (!toDownload.length) {
    console.log(chalk.gray('  Không có chapter nào để tải.\n'));
    return;
  }

  console.log(chalk.cyan(`\n  Sẽ tải ${toDownload.length} chapter...\n`));

  // Tải tuần tự từng chapter
  let ok = 0, fail = 0;
  for (let i = 0; i < toDownload.length; i++) {
    const ch = toDownload[i];
    if (page.isClosed && page.isClosed()) {
      page = await createCuuTruyenPage(true);
    }
    console.log(chalk.white(`\n  [${i + 1}/${toDownload.length}] ${ch.title}`));
    const result = await downloadChapter(page, ch.url, outputDir, concurrency, {
      mangaUrl,
      mangaTitle,
      chapterTitle: ch.title || '',
      chapterNumber: ch.number || '',
      format: outputFormat
    });
    if (result) ok++; else fail++;

    // Delay nhẹ giữa các chapter
    if (i < toDownload.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(chalk.bold(`\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
  console.log(chalk.green(`  ✓ Thành công: ${ok} chapter`));
  if (fail) console.log(chalk.red(`  ✗ Thất bại: ${fail} chapter`));
  console.log(chalk.gray(`  Output: ${path.resolve(outputDir)}\n`));
}

async function downloadMangaFromApiList(page, manga, opts = {}) {
  const {
    outputDir,
    outputFormat = 'folder',
    concurrency = 10,
    chapterDelay = 1500,
    from = 1,
    to = 0,
    redownload = false
  } = opts;

  const spinner = ora(`Lấy chapter: ${manga.title || manga.url}`).start();
  const { title, chapters } = await getMangaChapters(page, manga.url, true).catch(e => {
    spinner.fail(e.message);
    return { title: '', chapters: [] };
  });
  const mangaTitle = title || manga.title || titleFromMangaUrl(manga.url) || 'cuutruyen';
  spinner.succeed(`"${mangaTitle}" — ${chapters.length} chapter`);

  const start = Math.max(0, parseInt(from || '1', 10) - 1);
  const end = to ? Math.min(chapters.length - 1, parseInt(to, 10) - 1) : chapters.length - 1;
  const selected = chapters.slice(start, end + 1);

  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (let i = 0; i < selected.length; i++) {
    const ch = selected[i];
    const already = isAlreadyDownloaded(ch.url);
    if (already && !redownload) {
      skipped++;
      console.log(chalk.gray(`  [${i + 1}/${selected.length}] Bỏ qua (đã tải): ${ch.title}`));
      continue;
    }
    if (already && redownload) {
      console.log(chalk.yellow(`  [${i + 1}/${selected.length}] Tải lại: ${ch.title}`));
    }

    console.log(chalk.white(`\n  [${i + 1}/${selected.length}] ${ch.title}`));
    const result = await downloadChapter(page, ch.url, outputDir, concurrency, {
      mangaUrl: manga.url,
      mangaTitle,
      chapterTitle: ch.title || '',
      chapterNumber: ch.number || '',
      format: outputFormat
    });
    if (result) ok++; else fail++;

    if (i < selected.length - 1) {
      await new Promise(r => setTimeout(r, chapterDelay));
    }
  }

  return { title: mangaTitle, total: selected.length, ok, fail, skipped };
}

// ─────────────────────────────────────────────────────────
//  CLI Commands
// ─────────────────────────────────────────────────────────

const program = new Command();

program
  .name('cuutruyen')
  .description('Tool tải truyện từ cuutruyen.net cho nội dung có quyền truy cập')
  .version('1.0.0')
  .option('--output <dir>', 'Thư mục lưu output', './downloads')
  .option('--format <type>', 'Định dạng lưu: folder hoặc zip', 'folder')
  .option('--concurrency <n>', 'Số ảnh tải song song', '10')
  .option('--no-cache', 'Bỏ qua cache, scrape mới hoàn toàn');

// ─── INTERACTIVE (mặc định) ──────────────────────────────
program
  .command('interactive', { isDefault: true })
  .alias('i')
  .description('Chế độ menu tương tác (mặc định)')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.parent.opts();
    await runInteractive(globalOpts.output, globalOpts.format, parseInt(globalOpts.concurrency) || 10);
  });

// ─── LIST ────────────────────────────────────────────────
program
  .command('list')
  .alias('ls')
  .description('Xem danh sách truyện')
  .option('--page <n>', 'Số trang', '1')
  .option('--search <keyword>', 'Từ khóa tìm kiếm')
  .action(async (opts, cmd) => {
    printBanner();
    const globalOpts = cmd.parent.opts();
    const spinner = ora('Đang tải danh sách...').start();
    const query = {
      pageNum: parseInt(opts.page) || 1,
      search: opts.search || '',
      useCache: globalOpts.cache !== false
    };
    let page = null;
    try {
      let items;
      try {
        items = await getMangaList(null, query);
      } catch (err) {
        spinner.text = `API lỗi (${err.message}); mở browser để thử fallback...`;
        page = await createCuuTruyenPage(true);
        items = await getMangaList(page, query);
      }
      spinner.succeed(`${items.length} kết quả`);
      printMangaTable(items);
    } finally {
      if (page) await closeBrowser();
    }
  });

// ─── CHAPTERS ────────────────────────────────────────────
program
  .command('chapters <manga-url>')
  .alias('ch')
  .description('Lấy danh sách chapter của truyện')
  .action(async (mangaUrl, opts, cmd) => {
    printBanner();
    const globalOpts = cmd.parent.opts();
    const spinner = ora('Đang lấy danh sách chapter...').start();
    let page = null;
    try {
      let result;
      try {
        result = await getMangaChapters(null, mangaUrl, globalOpts.cache !== false);
      } catch (err) {
        spinner.text = `API lỗi (${err.message}); mở browser để thử fallback...`;
        page = await createCuuTruyenPage(true);
        result = await getMangaChapters(page, mangaUrl, globalOpts.cache !== false);
      }
      spinner.succeed(`"${result.title}" — ${result.chapters.length} chapter`);
      printChapterTable(result.chapters);
    } finally {
      if (page) await closeBrowser();
    }
  });

// ─── DOWNLOAD ────────────────────────────────────────────
program
  .command('download <chapter-url>')
  .alias('dl')
  .option('--manga <manga-url>', 'Manga URL de mo trang truyen truoc khi vao chapter')
  .description('Tải 1 chapter')
  .action(async (chapterUrl, opts, cmd) => {
    printBanner();
    const globalOpts = cmd.parent.opts();
    const page = await createCuuTruyenPage(true);
    try {
      await downloadChapter(page, chapterUrl, globalOpts.output, parseInt(globalOpts.concurrency) || 10, {
        mangaUrl: opts.manga || '',
        mangaTitle: titleFromMangaUrl(opts.manga || ''),
        format: globalOpts.format
      });
    } finally {
      await closeBrowser();
    }
  });

// ─── DOWNLOAD ALL ────────────────────────────────────────
program
  .command('download-all <manga-url>')
  .alias('da')
  .description('Tải tất cả chapter của bộ truyện')
  .option('--from <n>', 'Từ chapter thứ n', '1')
  .option('--to <n>', 'Đến chapter thứ n')
  .option('--delay <ms>', 'Delay giữa chapter (ms)', '1500')
  .action(async (mangaUrl, opts, cmd) => {
    printBanner();
    const globalOpts = cmd.parent.opts();
    const page = await createCuuTruyenPage(true);
    try {
      const spinner = ora('Lấy danh sách chapter...').start();
      const { title, chapters } = await getMangaChapters(page, mangaUrl, true);
      const mangaTitle = title || titleFromMangaUrl(mangaUrl) || 'cuutruyen';
      spinner.succeed(`"${mangaTitle}" — ${chapters.length} chapter`);

      const from = Math.max(0, parseInt(opts.from || '1') - 1);
      const to = opts.to ? Math.min(chapters.length - 1, parseInt(opts.to) - 1) : chapters.length - 1;
      const selected = chapters.slice(from, to + 1);

      console.log(chalk.cyan(`\n  Tải ${selected.length} chapter (chap ${from + 1} → ${to + 1})...\n`));

      let ok = 0, fail = 0;
      for (let i = 0; i < selected.length; i++) {
        const ch = selected[i];
        if (page.isClosed && page.isClosed()) {
          page = await createCuuTruyenPage(true);
        }
        // Skip đã tải
        const already = isAlreadyDownloaded(ch.url);
        if (already) {
          console.log(chalk.gray(`  [${i + 1}/${selected.length}] Bỏ qua (đã tải): ${ch.title}`));
          ok++;
          continue;
        }
        console.log(chalk.white(`\n  [${i + 1}/${selected.length}] ${ch.title}`));
        const result = await downloadChapter(page, ch.url, globalOpts.output, parseInt(globalOpts.concurrency) || 10, {
        mangaUrl,
        mangaTitle,
        chapterTitle: ch.title || '',
        chapterNumber: ch.number || '',
        format: globalOpts.format
      });
        if (result) ok++; else fail++;

        if (i < selected.length - 1) {
          await new Promise(r => setTimeout(r, parseInt(opts.delay) || 1500));
        }
      }

      console.log(chalk.bold(`\n  ━━━━━━━━━━━━━━━━━━━━━━━━`));
      console.log(chalk.green(`  ✓ Thành công: ${ok}`));
      if (fail) console.log(chalk.red(`  ✗ Thất bại: ${fail}`));
      console.log(chalk.gray(`  Output: ${path.resolve(globalOpts.output)}\n`));

    } finally {
      await closeBrowser();
    }
  });

// ─── DOWNLOAD SITE / API LIST ─────────────────────────────
program
  .command('download-site')
  .alias('ds')
  .description('Quét danh sách truyện bằng API rồi tải lần lượt từng bộ')
  .option('--search <keyword>', 'Dùng API tìm kiếm theo từ khóa thay vì recently_updated')
  .option('--start-page <n>', 'Trang bắt đầu quét', '1')
  .option('--max-pages <n>', 'Số trang API cần quét; dùng 0 để quét tới khi hết', '1')
  .option('--per-page <n>', 'Số truyện mỗi trang API', '50')
  .option('--manga-limit <n>', 'Giới hạn số truyện tải sau khi quét')
  .option('--from <n>', 'Tải chapter từ vị trí n trong mỗi truyện', '1')
  .option('--to <n>', 'Tải chapter tới vị trí n trong mỗi truyện')
  .option('--chapter-delay <ms>', 'Delay giữa chapter (ms)', '1500')
  .option('--manga-delay <ms>', 'Delay giữa truyện (ms)', '3000')
  .option('--redownload', 'Tải lại cả chapter đã có trong lịch sử')
  .option('--dry-run', 'Chỉ quét/in danh sách truyện, không tải')
  .action(async (opts, cmd) => {
    printBanner();
    const globalOpts = cmd.parent.opts();
    const maxPages = parseInt(opts.maxPages, 10);
    const perPage = Math.max(1, parseInt(opts.perPage, 10) || 50);
    let page = null;

    try {
      const spinner = ora('Đang quét danh sách truyện bằng API...').start();
      let mangas;
      const listOpts = {
        search: opts.search || '',
        startPage: parseInt(opts.startPage, 10) || 1,
        maxPages: Number.isNaN(maxPages) ? 1 : maxPages,
        perPage,
        useCache: globalOpts.cache !== false,
        onPage: ({ pageNum, fresh, total }) => {
          spinner.text = `API trang ${pageNum}: +${fresh.length} truyện mới, tổng ${total}`;
        }
      };

      try {
        mangas = await getMangaListPages(null, listOpts);
      } catch (err) {
        spinner.text = `API lỗi (${err.message}); mở browser để thử fallback...`;
        page = await createCuuTruyenPage(true);
        mangas = await getMangaListPages(page, listOpts);
      }

      if (opts.mangaLimit) {
        mangas = mangas.slice(0, Math.max(0, parseInt(opts.mangaLimit, 10) || 0));
      }

      spinner.succeed(`Quét được ${mangas.length} truyện${opts.search ? ` cho "${opts.search}"` : ''}`);
      printMangaTable(mangas);

      if (opts.dryRun || !mangas.length) return;

      if (!page) {
        page = await createCuuTruyenPage(true);
      }

      console.log(chalk.cyan(`\n  Bắt đầu tải ${mangas.length} truyện. Chapter đã tải sẽ được bỏ qua.\n`));
      let mangaOk = 0;
      let mangaFail = 0;
      let chapterOk = 0;
      let chapterFail = 0;
      let chapterSkipped = 0;

      for (let i = 0; i < mangas.length; i++) {
        const manga = mangas[i];
        if (page.isClosed && page.isClosed()) {
          page = await createCuuTruyenPage(true);
        }

        console.log(chalk.bold(`\n  ===== [${i + 1}/${mangas.length}] ${manga.title || manga.url} =====`));
        const summary = await downloadMangaFromApiList(page, manga, {
          outputDir: globalOpts.output,
          outputFormat: globalOpts.format,
          concurrency: parseInt(globalOpts.concurrency, 10) || 10,
          chapterDelay: parseInt(opts.chapterDelay, 10) || 1500,
          from: opts.from,
          to: opts.to,
          redownload: Boolean(opts.redownload)
        });

        chapterOk += summary.ok;
        chapterFail += summary.fail;
        chapterSkipped += summary.skipped;
        if (summary.fail) mangaFail++; else mangaOk++;

        if (i < mangas.length - 1) {
          await new Promise(r => setTimeout(r, parseInt(opts.mangaDelay, 10) || 3000));
        }
      }

      console.log(chalk.bold(`\n  ━━━━━━━━━━━━━━━━━━━━━━━━`));
      console.log(chalk.green(`  ✓ Truyện xong: ${mangaOk}`));
      if (mangaFail) console.log(chalk.red(`  ✗ Truyện có lỗi: ${mangaFail}`));
      console.log(chalk.green(`  ✓ Chapter tải mới: ${chapterOk}`));
      console.log(chalk.gray(`  Bỏ qua đã tải: ${chapterSkipped}`));
      if (chapterFail) console.log(chalk.red(`  ✗ Chapter lỗi: ${chapterFail}`));
      console.log(chalk.gray(`  Output: ${path.resolve(globalOpts.output)}\n`));
    } finally {
      if (page) await closeBrowser();
    }
  });

// ─── CHECK OLLAMA ────────────────────────────────────────
program
  .command('check-ollama')
  .description('Kiểm tra Ollama và Gemma 3')
  .action(async () => {
    printBanner();
    const spinner = ora('Kiểm tra Ollama tại localhost:11434...').start();
    const status = await checkOllamaAvailable();
    if (status.available) {
      spinner.succeed(status.message);
      console.log(chalk.gray(`  Models có sẵn: ${status.models.join(', ') || 'rỗng'}`));
      if (!status.hasGemma) {
        console.log(chalk.yellow(`\n  Chạy: node cli.js pull-model\n  hoặc: ollama pull gemma3:4b\n`));
      }
    } else {
      spinner.fail(status.message);
      console.log(chalk.yellow('\n  📖 Xem README.md để hướng dẫn cài Ollama\n'));
    }
  });

// ─── PULL MODEL ──────────────────────────────────────────
program
  .command('pull-model')
  .description('Pull gemma3:4b từ Ollama (cần Ollama đang chạy)')
  .action(async () => {
    printBanner();
    await pullModelIfNeeded('gemma3:4b');
  });

// ─── HISTORY ─────────────────────────────────────────────
program
  .command('history')
  .description('Xem lịch sử tải')
  .action(() => {
    printBanner();
    const history = getDownloadHistory();
    if (!history.length) {
      console.log(chalk.gray('  Chưa có lịch sử tải.\n'));
      return;
    }
    const t = new Table({
      head: [chalk.white('#'), chalk.white('File'), chalk.white('Ảnh'), chalk.white('Thời gian')],
      colWidths: [4, 50, 6, 22],
      style: { border: ['gray'] },
      wordWrap: true,
    });
    history.forEach((h, i) => {
      const fpath = require('path').basename(h.zip_path);
      t.push([i + 1, chalk.cyan(fpath), h.image_count, new Date(h.downloaded_at).toLocaleString('vi-VN')]);
    });
    console.log(t.toString());
    console.log('');
  });

// ─── GET COOKIES ─────────────────────────────────────────
program
  .command('get-cookies')
  .option('--browser <name>', 'Browser: auto, coccoc, chrome, edge', 'auto')
  .option('--profile <mode>', 'Profile: temp hoac default', 'temp')
  .option('--user-data-dir <dir>', 'Duong dan user data dir tuy chinh')
  .option('--port <n>', 'Remote debugging port', '9222')
  .option('--manual', 'Paste Cookie header thu cong')
  .description('Lấy cookies phiên đăng nhập từ Chrome thật')
  .action((opts) => {
    printBanner();
    try {
      const args = ['src/get-real-cookies.js'];
      if (opts.browser) args.push('--browser', opts.browser);
      if (opts.profile) args.push('--profile', opts.profile);
      if (opts.userDataDir) args.push('--user-data-dir', opts.userDataDir);
      if (opts.port) args.push('--port', opts.port);
      if (opts.manual) args.push('--manual');
      require('child_process').spawnSync(process.execPath, args, { stdio: 'inherit' });
    } catch (e) {
      console.log(chalk.red(`\n  Lỗi: ${e.message}`));
    }
  });

// ─────────────────────────────────────────────────────────
//  Entry Point
// ─────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch(err => {
  console.error(chalk.red('\n  ✗ Lỗi:', err.message));
  process.exit(1);
});
