'use strict';
/**
 * backup.js — Xử lý tự động backup truyện lên Google Drive qua rclone
 */

const { exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const CONFIG_FILE = path.join(__dirname, '..', 'cuutruyen-config.json');

/**
 * Đọc cấu hình từ file json hoặc biến môi trường
 */
function loadConfig() {
  let config = {
    enabled: false,
    remote: 'gdrive',
    path: 'CuuTruyenBackup'
  };

  // 1. Đọc từ file JSON
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data && data.rclone) {
        config = { ...config, ...data.rclone };
      }
    } catch (err) {
      console.log(chalk.red(`  [Backup Config Error] Không thể đọc file cuutruyen-config.json: ${err.message}`));
    }
  }

  // 2. Gộp/Ghi đè bằng biến môi trường (nếu có)
  if (process.env.CUUTRUYEN_RCLONE_ENABLED !== undefined) {
    config.enabled = process.env.CUUTRUYEN_RCLONE_ENABLED === '1' || process.env.CUUTRUYEN_RCLONE_ENABLED === 'true';
  }
  if (process.env.CUUTRUYEN_RCLONE_REMOTE) {
    config.remote = process.env.CUUTRUYEN_RCLONE_REMOTE;
  }
  if (process.env.CUUTRUYEN_RCLONE_PATH) {
    config.path = process.env.CUUTRUYEN_RCLONE_PATH;
  }

  return config;
}

/**
 * Kiểm tra xem rclone có sẵn trong hệ thống hay không
 */
let _rcloneAvailable = null;
function isRcloneAvailable() {
  if (_rcloneAvailable !== null) return _rcloneAvailable;

  try {
    // Chạy thử rclone version
    execSync('rclone version', { stdio: 'ignore', timeout: 5000 });
    _rcloneAvailable = true;
  } catch {
    _rcloneAvailable = false;
  }
  return _rcloneAvailable;
}

/**
 * Upload chapter lên Google Drive qua rclone
 *
 * @param {string} localPath - Đường dẫn thư mục hoặc file ZIP cục bộ
 * @param {string} mangaTitle - Tên truyện
 * @param {string} outputName - Tên file hoặc tên thư mục
 * @param {'folder'|'zip'} outputType - Định dạng lưu trữ
 */
function backupChapter(localPath, mangaTitle, outputName, outputType) {
  return new Promise((resolve) => {
    const config = loadConfig();

    if (!config.enabled) {
      return resolve(false);
    }

    if (!isRcloneAvailable()) {
      console.log(chalk.yellow(`\n  [Backup] ⚠️ Cảnh báo: Tự động backup được bật nhưng không tìm thấy lệnh 'rclone' trong hệ thống.`));
      console.log(chalk.yellow(`           Hãy chắc chắn rằng rclone đã được cài đặt và thêm vào biến môi trường PATH.`));
      return resolve(false);
    }

    console.log(chalk.cyan(`\n  [Backup] Đang upload lên Google Drive: "${outputName}"...`));

    // Chuẩn hóa đường dẫn để tránh lỗi ký tự đặc biệt
    const cleanLocalPath = localPath.replace(/"/g, '\\"');
    const remote = config.remote;
    const remoteBasePath = config.path.replace(/\/+$/, ''); // Xóa dấu gạch chéo cuối nếu có
    const cleanMangaTitle = mangaTitle.replace(/"/g, '\\"');
    const cleanOutputName = outputName.replace(/"/g, '\\"');

    let command = '';
    if (outputType === 'folder') {
      // rclone copy "/local/folder" "remote:BackupPath/MangaTitle/FolderName"
      command = `rclone copy "${cleanLocalPath}" "${remote}:${remoteBasePath}/${cleanMangaTitle}/${cleanOutputName}"`;
    } else {
      // rclone copyto "/local/file.zip" "remote:BackupPath/MangaTitle/file.zip"
      command = `rclone copyto "${cleanLocalPath}" "${remote}:${remoteBasePath}/${cleanMangaTitle}/${cleanOutputName}"`;
    }

    // Thực thi rclone
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.log(chalk.red(`  [Backup] ✗ Backup thất bại: ${error.message.trim()}`));
        if (stderr) console.log(chalk.red(`           Chi tiết: ${stderr.trim()}`));
        return resolve(false);
      }
      console.log(chalk.green(`  [Backup] ✓ Đã backup thành công lên Google Drive!`));
      return resolve(true);
    });
  });
}

module.exports = {
  loadConfig,
  isRcloneAvailable,
  backupChapter
};
