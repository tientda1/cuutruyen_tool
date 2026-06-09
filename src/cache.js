'use strict';
/**
 * cache.js — SQLite cache dùng sql.js (pure JavaScript, không cần build native)
 * Lưu danh sách truyện, chapter, và trạng thái download.
 */

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'cuutruyen-cache.db');
const CACHE_TTL = 60 * 60 * 1000; // 1 giờ

let _db = null;
let _SQL = null;

async function getDb() {
  if (_db) return _db;

  try {
    const initSqlJs = require('sql.js');
    _SQL = await initSqlJs();

    // Load existing DB hoặc tạo mới
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      _db = new _SQL.Database(fileBuffer);
    } else {
      _db = new _SQL.Database();
    }

    // Tạo tables
    _db.run(`
      CREATE TABLE IF NOT EXISTS manga_list (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE,
        title TEXT,
        cover TEXT,
        status TEXT,
        scraped_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS chapters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manga_url TEXT,
        manga_title TEXT,
        chapter_url TEXT UNIQUE,
        title TEXT,
        number REAL,
        date TEXT,
        scraped_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS downloaded (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_url TEXT UNIQUE,
        zip_path TEXT,
        image_count INTEGER,
        downloaded_at INTEGER
      );
    `);

    try {
      _db.run('ALTER TABLE chapters ADD COLUMN manga_title TEXT;');
      saveDb(_db);
    } catch {
      // Column already exists in newer caches.
    }
    try {
      _db.run(`
        UPDATE chapters
        SET manga_title = (
          SELECT manga_list.title
          FROM manga_list
          WHERE manga_list.url = chapters.manga_url
          LIMIT 1
        )
        WHERE (manga_title IS NULL OR manga_title = '')
          AND EXISTS (
            SELECT 1 FROM manga_list WHERE manga_list.url = chapters.manga_url
          );
      `);
      saveDb(_db);
    } catch {
      // Best-effort backfill for old caches.
    }

    return _db;
  } catch (e) {
    // sql.js không khả dụng, dùng in-memory fallback
    return null;
  }
}

function saveDb(db) {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch { /* ignore */ }
}

function queryAll(db, sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch {
    return [];
  }
}

function runSql(db, sql, params = []) {
  try {
    db.run(sql, params);
    saveDb(db);
  } catch { /* ignore */ }
}

// ── Manga list cache ──────────────────────────────────────

async function getCachedMangaList(pageNum = 1, search = '') {
  const db = await getDb();
  if (!db) return null;
  const cutoff = Date.now() - CACHE_TTL;
  const offset = (pageNum - 1) * 50;
  let rows;
  if (search) {
    rows = queryAll(db, `SELECT * FROM manga_list WHERE scraped_at > ? AND title LIKE ? ORDER BY id LIMIT 50 OFFSET ?`, [cutoff, `%${search}%`, offset]);
  } else {
    rows = queryAll(db, `SELECT * FROM manga_list WHERE scraped_at > ? ORDER BY id LIMIT 50 OFFSET ?`, [cutoff, offset]);
  }
  return rows.length > 0 ? rows : null;
}

async function saveMangaList(items) {
  const db = await getDb();
  if (!db) return;
  const now = Date.now();
  for (const item of items) {
    runSql(db, `INSERT OR REPLACE INTO manga_list (url, title, cover, status, scraped_at) VALUES (?, ?, ?, ?, ?)`,
      [item.url || '', item.title || '', item.cover || '', item.status || '', now]);
  }
}

// ── Chapter list cache ────────────────────────────────────

async function getCachedChapters(mangaUrl) {
  const db = await getDb();
  if (!db) return null;
  const cutoff = Date.now() - CACHE_TTL;
  const rows = queryAll(db, `SELECT * FROM chapters WHERE manga_url = ? AND scraped_at > ? ORDER BY number ASC`, [mangaUrl, cutoff]);
  return rows.length > 0 ? rows : null;
}

async function saveChapters(mangaUrl, chapters, mangaTitle = '') {
  const db = await getDb();
  if (!db) return;
  const now = Date.now();
  for (const ch of chapters) {
    runSql(db, `INSERT OR REPLACE INTO chapters (manga_url, manga_title, chapter_url, title, number, date, scraped_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [mangaUrl, mangaTitle || ch.mangaTitle || '', ch.url || '', ch.title || '', ch.number || 0, ch.date || '', now]);
  }
}

// ── Download state ────────────────────────────────────────

function isAlreadyDownloaded(chapterUrl) {
  // sync fallback — sql.js có thể dùng synchronously sau khi init
  if (!_db) return false;
  const rows = queryAll(_db, 'SELECT zip_path FROM downloaded WHERE chapter_url = ?', [chapterUrl]);
  if (!rows.length) return false;
  const zipPath = rows[0].zip_path;
  return fs.existsSync(zipPath) ? zipPath : false;
}

async function markDownloaded(chapterUrl, zipPath, imageCount) {
  const db = await getDb();
  if (!db) return;
  runSql(db, `INSERT OR REPLACE INTO downloaded (chapter_url, zip_path, image_count, downloaded_at) VALUES (?, ?, ?, ?)`,
    [chapterUrl, zipPath, imageCount, Date.now()]);
}

function getDownloadHistory() {
  if (!_db) return [];
  return queryAll(_db, 'SELECT * FROM downloaded ORDER BY downloaded_at DESC LIMIT 100');
}

async function clearCache() {
  const db = await getDb();
  if (!db) return;
  db.run('DELETE FROM manga_list; DELETE FROM chapters;');
  saveDb(db);
}

// Init DB on require
getDb().catch(() => {});

module.exports = {
  getCachedMangaList,
  saveMangaList,
  getCachedChapters,
  saveChapters,
  isAlreadyDownloaded,
  markDownloaded,
  getDownloadHistory,
  clearCache,
  getDb
};
