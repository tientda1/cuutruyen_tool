'use strict';
/**
 * captcha.js — Giải CAPTCHA dùng Ollama + Gemma 3 (multimodal)
 *
 * Ollama API: http://localhost:11434/api/generate
 * Model: gemma3:4b
 */

const axios = require('axios');
const chalk = require('chalk');

const OLLAMA_BASE = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma3:4b';

/**
 * Kiểm tra xem Ollama có đang chạy không
 */
async function checkOllamaAvailable() {
  try {
    const res = await axios.get(`${OLLAMA_BASE}/api/tags`, { timeout: 3000 });
    const models = (res.data.models || []).map(m => m.name);
    const hasGemma = models.some(m => m.includes('gemma3'));
    return {
      available: true,
      models,
      hasGemma,
      message: hasGemma
        ? `✓ Ollama OK — Gemma 3 có sẵn`
        : `⚠ Ollama OK nhưng chưa có gemma3:4b (chạy: ollama pull gemma3:4b)`
    };
  } catch (e) {
    return {
      available: false,
      models: [],
      hasGemma: false,
      message: `✗ Ollama chưa chạy (localhost:11434)\n  → Xem README.md để cài đặt`
    };
  }
}

/**
 * Gửi ảnh CAPTCHA lên Gemma 3 để giải
 * @param {Buffer} imageBuffer - buffer của ảnh CAPTCHA
 * @param {string} [hint] - gợi ý thêm cho model
 * @returns {Promise<string>} - text CAPTCHA giải được
 */
async function solveImageCaptcha(imageBuffer, hint = '') {
  const base64 = imageBuffer.toString('base64');

  const prompt = hint
    ? `${hint}\nChỉ trả lời đúng text trong CAPTCHA, không giải thích thêm.`
    : `Đây là ảnh CAPTCHA. Hãy đọc và trả về đúng các ký tự trong ảnh (chữ hoa, chữ thường, số). Chỉ trả về text, không giải thích.`;

  try {
    const res = await axios.post(`${OLLAMA_BASE}/api/generate`, {
      model: DEFAULT_MODEL,
      prompt,
      images: [base64],
      stream: false,
      options: {
        temperature: 0.1,  // thấp để deterministic hơn
        top_p: 0.9
      }
    }, { timeout: 30000 });

    const answer = (res.data.response || '').trim().replace(/\s+/g, '');
    return answer;
  } catch (e) {
    throw new Error(`Ollama API error: ${e.message}`);
  }
}

/**
 * Hỏi Gemma về nội dung trang để debug/phân tích
 * @param {string} question - câu hỏi
 * @param {Buffer|null} screenshotBuffer - screenshot nếu có
 */
async function askGemma(question, screenshotBuffer = null) {
  const payload = {
    model: DEFAULT_MODEL,
    prompt: question,
    stream: false,
    options: { temperature: 0.3 }
  };
  if (screenshotBuffer) {
    payload.images = [screenshotBuffer.toString('base64')];
  }

  const res = await axios.post(`${OLLAMA_BASE}/api/generate`, payload, { timeout: 30000 });
  return (res.data.response || '').trim();
}

/**
 * Pull model nếu chưa có (gọi 1 lần khi setup)
 */
async function pullModelIfNeeded(modelName = DEFAULT_MODEL) {
  console.log(chalk.yellow(`  Đang pull model ${modelName} từ Ollama...`));
  console.log(chalk.gray('  (Lần đầu có thể mất vài phút tùy internet)\n'));

  try {
    // Streaming pull
    const res = await axios.post(`${OLLAMA_BASE}/api/pull`, {
      name: modelName,
      stream: false
    }, { timeout: 5 * 60 * 1000 });

    console.log(chalk.green(`  ✓ Pull ${modelName} thành công!\n`));
    return true;
  } catch (e) {
    console.log(chalk.red(`  ✗ Không thể pull ${modelName}: ${e.message}\n`));
    return false;
  }
}

module.exports = {
  checkOllamaAvailable,
  solveImageCaptcha,
  askGemma,
  pullModelIfNeeded,
  OLLAMA_BASE,
  DEFAULT_MODEL
};
