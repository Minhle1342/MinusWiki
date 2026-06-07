import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { marked } from 'marked';
import { Mutex } from 'async-mutex';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync, watch } from 'fs';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import fetch from 'node-fetch';
import crypto from 'crypto';
import * as lancedb from '@lancedb/lancedb';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve directories
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isVercel = process.env.VERCEL || process.env.NOW_REGION;
const STORAGE_DIR = isVercel ? '/tmp/storage' : path.join(__dirname, 'storage');
const PROJECTS_DIR = path.join(STORAGE_DIR, 'projects');
const TMP_DIR = isVercel ? '/tmp/tmp' : path.join(__dirname, 'tmp');

// Configuration System (Dynamic API keys via UI)
const CONFIG_PATH = path.join(STORAGE_DIR, 'config.json');

let appConfig = {
  LLM_PROVIDER: process.env.LLM_PROVIDER || 'gemini',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'DeepSeek-V4-Flash',
  OPENAI_API_BASE: process.env.OPENAI_API_BASE || 'https://api.deepseek.com'
};

async function loadConfig() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
      appConfig = { ...appConfig, ...data };
      console.log('Configuration loaded from storage/config.json');
    } catch (e) {
      // Config file might not exist yet, that's fine
    }
  } catch (err) {
    console.error('Error loading configuration:', err);
  }
}
loadConfig().catch(console.error);

async function saveConfig(newConfig) {
  try {
    appConfig = { ...appConfig, ...newConfig };
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(appConfig, null, 2), 'utf-8');
    console.log('Configuration saved to storage/config.json');
  } catch (err) {
    console.error('Error saving configuration:', err);
  }
}

// Configure multer for file uploads
const upload = multer({ dest: TMP_DIR });

// Concurrency Control: Map of projectId -> Mutex
// Used to prevent file corruption during concurrent LLM writes to index.md, overview.md, and other wiki pages.
const projectMutexes = new Map();

function getProjectMutex(projectId) {
  if (!projectMutexes.has(projectId)) {
    projectMutexes.set(projectId, new Mutex());
  }
  return projectMutexes.get(projectId);
}

// Ensure base directories exist
async function ensureDirs() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
}
ensureDirs().catch(console.error);

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// UTILITY FUNCTIONS & DOCUMENT PARSERS
// ==========================================

/**
 * Extracts text from various file formats
 */
async function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const buffer = await fs.readFile(filePath);

  if (ext === '.pdf') {
    const data = await pdfParse(buffer);
    return data.text || '';
  } else if (ext === '.docx') {
    const data = await mammoth.extractRawText({ buffer });
    return data.value || '';
  } else if (ext === '.xlsx' || ext === '.xls') {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    let text = '';
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      text += `--- Sheet: ${sheetName} ---\n`;
      text += xlsx.utils.sheet_to_csv(sheet) + '\n';
    });
    return text;
  } else if (ext === '.txt' || ext === '.md' || ext === '.json' || ext === '.csv') {
    return buffer.toString('utf-8');
  } else {
    throw new Error(`Unsupported file type: ${ext}`);
  }
}

// ==========================================
// LLM SERVICE & PIPELINES
// ==========================================

/**
 * Helper to parse JSON from LLM response safely (handles Markdown code block wraps)
 */
function cleanInvalidLLMQuotes(jsonStr) {
  let inString = false;
  let escaped = false;
  let cleaned = "";

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (!inString) {
      if (char === '"') {
        inString = true;
        escaped = false;
      }
      cleaned += char;
    } else {
      if (escaped) {
        cleaned += char;
        escaped = false;
      } else if (char === '\\') {
        cleaned += char;
        escaped = true;
      } else if (char === '"') {
        let nextChar = '';
        for (let j = i + 1; j < jsonStr.length; j++) {
          if (!/\s/.test(jsonStr[j])) {
            nextChar = jsonStr[j];
            break;
          }
        }
        if (nextChar === ',' || nextChar === '}' || nextChar === ']' || nextChar === ':') {
          inString = false;
          cleaned += char;
        } else {
          cleaned += '\\"';
        }
      } else {
        cleaned += char;
      }
    }
  }
  return cleaned;
}

function parseLLMJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?/i, '');
    cleaned = cleaned.replace(/```$/, '');
    cleaned = cleaned.trim();
  }
  cleaned = cleaned.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('[JSON Parser] Initial JSON parse failed. Attempting robust cleanup...', e.message);
    try {
      const repaired = cleanInvalidLLMQuotes(cleaned);
      return JSON.parse(repaired);
    } catch (secondErr) {
      console.error('Failed to parse clean LLM JSON response:', e);
      console.error('Cleaned text was:', cleaned);
      throw e;
    }
  }
}

// ==========================================
// NEW PIPELINE UTILITIES, ENHANCED CHUNKING & EMBEDDINGS
// ==========================================

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, content: markdown };
  }
  const fmText = match[1];
  const content = match[2];
  const frontmatter = {};

  const lines = fmText.split('\n');
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx !== -1) {
      const key = line.substring(0, idx).trim();
      let value = line.substring(idx + 1).trim();

      if (value.startsWith('[') && value.endsWith(']')) {
        try {
          value = JSON.parse(value);
        } catch (e) {
          value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        }
      }
      frontmatter[key] = value;
    }
  }
  return { frontmatter, content };
}

function stringifyFrontmatter(frontmatter, content) {
  let fmText = '---\n';
  for (const [key, val] of Object.entries(frontmatter)) {
    if (Array.isArray(val)) {
      fmText += `${key}: ${JSON.stringify(val)}\n`;
    } else {
      fmText += `${key}: ${val}\n`;
    }
  }
  fmText += '---\n';
  return fmText + content;
}

function adaptiveChunking(text, minTokens = 300, maxTokens = 600) {
  const paragraphs = text.split(/\n+/);
  const chunks = [];
  let currentChunk = [];
  let currentWordsCount = 0;

  for (const para of paragraphs) {
    const cleanPara = para.trim();
    if (!cleanPara) continue;

    const paraWords = cleanPara.split(/\s+/);
    const paraWordCount = paraWords.length;

    if (currentWordsCount + paraWordCount > maxTokens) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n\n'));
        currentChunk = [];
        currentWordsCount = 0;
      }

      if (paraWordCount > maxTokens) {
        const sentences = cleanPara.match(/[^.!?]+[.!?]+(\s|$)/g) || [cleanPara];
        let tempChunk = [];
        let tempWordsCount = 0;

        for (const sentence of sentences) {
          const sentenceWords = sentence.trim().split(/\s+/);
          const sentenceWordCount = sentenceWords.length;

          if (tempWordsCount + sentenceWordCount > maxTokens) {
            if (tempChunk.length > 0) {
              chunks.push(tempChunk.join(' '));
              tempChunk = [];
              tempWordsCount = 0;
            }
          }
          tempChunk.push(sentence.trim());
          tempWordsCount += sentenceWordCount;
        }

        if (tempChunk.length > 0) {
          chunks.push(tempChunk.join(' '));
        }
      } else {
        currentChunk.push(cleanPara);
        currentWordsCount = paraWordCount;
      }
    } else {
      currentChunk.push(cleanPara);
      currentWordsCount += paraWordCount;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n\n'));
  }

  return chunks;
}

async function getGeminiEmbedding(text) {
  const geminiKey = appConfig.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('GEMINI_API_KEY is not configured');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key=${geminiKey}`;
  const body = {
    model: 'models/gemini-embedding-2',
    content: {
      parts: [{ text }]
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini Embedding API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  return data.embedding.values;
}

async function describePdfImages(pdfBuffer) {
  const geminiKey = appConfig.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!geminiKey) return "";

  const model = appConfig.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  const userPrompt = "Hãy phân tích tài liệu PDF này và trích xuất/mô tả chi tiết tất cả các sơ đồ, hình vẽ, hình ảnh minh họa, bảng biểu để làm rõ ngữ cảnh trực quan (bằng tiếng Việt). Nếu không có hình ảnh hoặc sơ đồ nào, hãy trả về chuỗi rỗng.";

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: pdfBuffer.toString('base64'),
              mimeType: 'application/pdf'
            }
          },
          { text: userPrompt }
        ]
      }
    ],
    systemInstruction: {
      parts: [{ text: "Bạn là một chuyên gia phân tích tài liệu kỹ thuật. Nhiệm vụ của bạn là mô tả chi tiết các phần tử trực quan (hình ảnh, sơ đồ, biểu đồ) trong tài liệu để lưu trữ tri thức." }]
    }
  };

  try {
    console.log("Calling Gemini PDF image analyzer...");
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) {
      const data = await res.json();
      const description = data.candidates[0].content.parts[0].text;
      return description || "";
    }
  } catch (e) {
    console.error("Error describing PDF images:", e);
  }
  return "";
}

async function processDocumentTask(task) {
  const { projectId, filename, filePath } = task;

  // 1. Extract text from file
  console.log(`[Queue] Extracting text from ${filename}...`);
  const text = await extractTextFromFile(filePath, filename);
  if (!text || !text.trim()) {
    console.warn(`[Queue] File ${filename} is empty or could not be extracted. Skipping ingestion.`);
    const content = await fs.readFile(filePath).catch(() => Buffer.from(''));
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const cachePath = path.join(PROJECTS_DIR, projectId, 'cache_manifest.json');
    let cache = {};
    if (existsSync(cachePath)) {
      try {
        cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
      } catch (e) {
        cache = {};
      }
    }
    cache[filename] = sha256;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
    return;
  }

  // 2. Run ingestion pipeline or txt compilation
  const isTxtFile = filename.toLowerCase().endsWith('.txt');

  if (isTxtFile) {
    console.log(`[Queue] Special conversion of .txt file to .md for ${filename}...`);
    // 1. Read purpose.md or create a default one
    const wikiDir = path.join(PROJECTS_DIR, projectId, 'wiki');
    const purposePath = path.join(wikiDir, 'purpose.md');
    let purposeContent = '';
    if (!existsSync(purposePath)) {
      purposeContent = `# Mục tiêu hệ thống Wiki\nTài liệu thô cần được chuyển đổi thành các trang kiến thức Markdown (.md) chuẩn chỉnh.\n\n# Quy tắc biên soạn của AI:\n1. Đọc nội dung file thô và cấu trúc lại bằng các thẻ Header (#, ##, ###).\n2. Nếu có dữ liệu liệt kê, bắt buộc chuyển thành bảng (Table) hoặc danh sách (Bullet points).\n3. Sử dụng tính năng liên kết chéo dạng [[Tên_Khái_Niệm]] cho các từ khóa quan trọng.\n4. Tên file .md sinh ra phải trùng tên với file .txt (chỉ đổi đuôi).\n`;
      await fs.writeFile(purposePath, purposeContent, 'utf-8');
    } else {
      purposeContent = await fs.readFile(purposePath, 'utf-8');
    }

    // 2. Call LLM to format/rewrite txt content to markdown
    const systemInstruction = `Bạn là chuyên gia biên soạn tài liệu Markdown bằng tiếng Việt.
Dưới đây là mục tiêu hệ thống Wiki và các quy tắc biên soạn của bạn được đọc từ tệp cấu hình purpose.md:
${purposeContent}

Nhiệm vụ của bạn là đọc nội dung văn bản thô bên dưới và chuyển đổi nó thành một trang Markdown (.md) hoàn chỉnh theo đúng mục tiêu và quy tắc trên.
Đầu ra chỉ chứa mã Markdown của trang, không kèm theo bất kỳ giải thích, phản hồi nào bên ngoài.`;

    const userPrompt = `Nội dung file thô cần chuyển đổi:\n---\n${text}\n---`;

    let mdContent = await callLLM(systemInstruction, userPrompt, false);

    // Ensure it doesn't contain markdown fence block like \`\`\`markdown ... \`\`\`
    if (mdContent.startsWith('```markdown')) {
      mdContent = mdContent.slice(11);
      if (mdContent.endsWith('```')) {
        mdContent = mdContent.slice(0, -3);
      }
    } else if (mdContent.startsWith('```')) {
      mdContent = mdContent.slice(3);
      if (mdContent.endsWith('```')) {
        mdContent = mdContent.slice(0, -3);
      }
    }
    mdContent = mdContent.trim();

    // 3. Write target .md file matching the .txt filename (only extension changed)
    const baseName = filename.substring(0, filename.length - 4); // remove .txt
    const targetMdFilename = `${baseName}.md`;
    const targetMdPath = path.join(wikiDir, targetMdFilename);

    // Add metadata frontmatter (like sources: [filename.txt])
    const frontmatter = {
      sources: [filename]
    };
    const finalPageContent = stringifyFrontmatter(frontmatter, mdContent);
    await fs.writeFile(targetMdPath, finalPageContent, 'utf-8');

    // 4. Update index.md, overview.md, log.md
    const mockConcept = {
      name: baseName.replace(/_/g, ' '),
      slug: baseName,
      definition: `Tài liệu được chuyển đổi từ ${filename}.`
    };

    // Update Directory Page (index.md)
    try {
      const indexFilePath = path.join(wikiDir, 'index.md');
      const indexContent = await fs.readFile(indexFilePath, 'utf-8');
      const indexSystem = `
      Bạn là biên tập viên Wiki bằng tiếng Việt.
      Hãy cập nhật tệp lục danh mục \`index.md\` để chèn liên kết khái niệm mới vào đúng phần phân loại thích hợp nhất (ví dụ: Công nghệ, Khoa học, Nhân văn, v.v.).
      Nếu chưa có phần phù hợp, bạn có thể tạo phần mới. Hãy giữ nguyên định dạng danh sách và các liên kết cũ.
      Đầu ra phải là toàn bộ nội dung Markdown mới của tệp \`index.md\`, không chứa giải thích nào bên ngoài.
      `;
      const indexUser = `
      === DANH MỤC HIỆN TẠI (index.md) ===
      ${indexContent}

      === CÁC LIÊN KẾT MỚI CẦN THÊM ===
      - [${mockConcept.name}](${mockConcept.slug}.md) : ${mockConcept.definition}
      `;
      const updatedIndex = await callLLM(indexSystem, indexUser, false);
      let cleanIndex = updatedIndex.trim();
      if (cleanIndex.startsWith('```markdown')) {
        cleanIndex = cleanIndex.slice(11);
        if (cleanIndex.endsWith('```')) cleanIndex = cleanIndex.slice(0, -3);
      } else if (cleanIndex.startsWith('```')) {
        cleanIndex = cleanIndex.slice(3);
        if (cleanIndex.endsWith('```')) cleanIndex = cleanIndex.slice(0, -3);
      }
      await fs.writeFile(indexFilePath, cleanIndex.trim());
    } catch (err) {
      console.error('Failed to update index.md for txt:', err);
    }

    // Update Overview Page (overview.md)
    try {
      const overviewFilePath = path.join(wikiDir, 'overview.md');
      const overviewContent = await fs.readFile(overviewFilePath, 'utf-8');
      const overviewSystem = `
      Bạn là chuyên gia tổng hợp tài liệu bằng tiếng Việt.
      Hãy cập nhật tệp tổng quan \`overview.md\` để tích hợp tóm tắt về các khái niệm mới được thêm vào Wiki, giúp người đọc nắm bắt nhanh cấu trúc kiến thức hiện có.
      Giữ nguyên văn phong khoa học, rõ ràng và cấu trúc hiện tại của trang tổng quan.
      Đầu ra phải là toàn bộ nội dung Markdown mới của tệp \`overview.md\`, không chứa giải thích bên ngoài.
      `;
      const overviewUser = `
      === TỔNG QUAN HIỆN TẠI (overview.md) ===
      ${overviewContent}

      === CÁC KHÁI NIỆM MỚI THÊM ===
      - **${mockConcept.name}**: ${mockConcept.definition}
      `;
      const updatedOverview = await callLLM(overviewSystem, overviewUser, false);
      let cleanOverview = updatedOverview.trim();
      if (cleanOverview.startsWith('```markdown')) {
        cleanOverview = cleanOverview.slice(11);
        if (cleanOverview.endsWith('```')) cleanOverview = cleanOverview.slice(0, -3);
      } else if (cleanOverview.startsWith('```')) {
        cleanOverview = cleanOverview.slice(3);
        if (cleanOverview.endsWith('```')) cleanOverview = cleanOverview.slice(0, -3);
      }
      await fs.writeFile(overviewFilePath, cleanOverview.trim());
    } catch (err) {
      console.error('Failed to update overview.md for txt:', err);
    }

    // Log the changes to log.md
    try {
      const logFilePath = path.join(wikiDir, 'log.md');
      const timestamp = new Date().toISOString();
      await fs.appendFile(
        logFilePath,
        `\n- [${timestamp}] Nạp tài liệu "${filename}", tự động biên soạn thành trang wiki: [${mockConcept.name}](${mockConcept.slug}.md)\n`
      );
    } catch (err) {
      console.error('Failed to write log.md for txt:', err);
    }
  } else {
    console.log(`[Queue] Running ingest pipeline for ${filename}...`);
    const result = await runIngestPipeline(projectId, filename, text);
    if (!result || !result.success) {
      throw new Error(result ? result.message : 'Ingest pipeline failed.');
    }
  }

  // 3. Save hash to cache manifest to prevent redundant ingestion
  console.log(`[Queue] Updating cache manifest for ${filename}...`);
  const content = await fs.readFile(filePath);
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');

  const cachePath = path.join(PROJECTS_DIR, projectId, 'cache_manifest.json');
  let cache = {};
  if (existsSync(cachePath)) {
    try {
      cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
    } catch (e) {
      cache = {};
    }
  }
  cache[filename] = sha256;
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
}

class PersistentQueue {
  constructor() {
    this.queuePath = path.join(STORAGE_DIR, 'queue.json');
    this.tasks = [];
    this.isProcessing = false;
  }

  async load() {
    try {
      if (existsSync(this.queuePath)) {
        const content = await fs.readFile(this.queuePath, 'utf-8');
        this.tasks = JSON.parse(content);
        let updated = false;
        for (const task of this.tasks) {
          if (task.status === 'processing') {
            task.status = 'pending';
            updated = true;
          }
        }
        if (updated) {
          await this.save();
        }
      }
    } catch (e) {
      console.error('Error loading queue:', e);
      this.tasks = [];
    }
  }

  async save() {
    try {
      await fs.writeFile(this.queuePath, JSON.stringify(this.tasks, null, 2));
    } catch (e) {
      console.error('Error saving queue:', e);
    }
  }

  async addTask(projectId, filename, filePath) {
    const existing = this.tasks.find(t => t.projectId === projectId && t.filename === filename && (t.status === 'pending' || t.status === 'processing'));
    if (existing) {
      console.log(`Task for ${filename} in project ${projectId} already in queue.`);
      return existing;
    }

    const task = {
      id: uuidv4(),
      projectId,
      filename,
      filePath,
      status: 'pending',
      retries: 0,
      error: null,
      addedAt: new Date().toISOString()
    };
    this.tasks.push(task);
    await this.save();

    this.processNext();
    return task;
  }

  async processNext() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (true) {
        const task = this.tasks.find(t => t.status === 'pending');
        if (!task) break;

        task.status = 'processing';
        await this.save();

        console.log(`[Queue] Processing task ${task.id} for file: ${task.filename} in project ${task.projectId}`);
        try {
          await processDocumentTask(task);

          task.status = 'completed';
          task.error = null;
          console.log(`[Queue] Task ${task.id} completed successfully.`);
        } catch (err) {
          task.retries += 1;
          task.error = err.message;
          console.error(`[Queue] Task ${task.id} failed (attempt ${task.retries}/3). Error: ${err.message}`);

          if (task.retries >= 3) {
            task.status = 'failed';
          } else {
            task.status = 'pending';
          }
        }
        await this.save();

        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

const ingestQueue = new PersistentQueue();

const projectWatchers = new Map();

async function watchProjectSources(projectId) {
  if (projectWatchers.has(projectId)) return;

  const sourcesDir = path.join(PROJECTS_DIR, projectId, 'sources');
  await fs.mkdir(sourcesDir, { recursive: true });

  console.log(`Starting source watcher for project ${projectId} at ${sourcesDir}`);

  const handleFileChange = async (filename) => {
    try {
      const filePath = path.join(sourcesDir, filename);
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!existsSync(filePath)) {
        return;
      }

      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return;

      const content = await fs.readFile(filePath);
      const sha256 = crypto.createHash('sha256').update(content).digest('hex');

      const cachePath = path.join(PROJECTS_DIR, projectId, 'cache_manifest.json');
      let cache = {};
      if (existsSync(cachePath)) {
        try {
          cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
        } catch (e) {
          cache = {};
        }
      }

      if (cache[filename] === sha256) {
        console.log(`[Cache Hit] File ${filename} has not changed. Skipping ingestion.`);
        return;
      }

      console.log(`[Cache Miss] File ${filename} changed or new. Adding to queue.`);
      await ingestQueue.addTask(projectId, filename, filePath);
    } catch (e) {
      console.error(`Error in watcher callback for file ${filename}:`, e);
    }
  };

  try {
    const watcher = watch(sourcesDir, async (eventType, filename) => {
      if (!filename) return;
      if (filename.endsWith('.tmp') || filename.startsWith('.')) return;
      if (eventType === 'rename' || eventType === 'change') {
        await handleFileChange(filename);
      }
    });
    projectWatchers.set(projectId, watcher);
  } catch (err) {
    console.error(`Failed to watch sources for project ${projectId}:`, err);
  }
}

async function initAllProjectWatchers() {
  try {
    if (!existsSync(PROJECTS_DIR)) return;
    const items = await fs.readdir(PROJECTS_DIR);
    for (const item of items) {
      const itemPath = path.join(PROJECTS_DIR, item);
      const stat = await fs.stat(itemPath);
      if (stat.isDirectory()) {
        await watchProjectSources(item);
      }
    }
  } catch (err) {
    console.error('Failed to initialize project watchers:', err);
  }
}

/**
 * Helper to call Gemini specifically with thinking budget, timeout, and fallback retry
 */
async function callLLMGemini(systemInstruction, userPrompt, jsonMode, useThinking = true) {
  const geminiKey = appConfig.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const model = appConfig.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }]
      }
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }]
    },
    generationConfig: {}
  };

  if (jsonMode) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  if (useThinking) {
    body.generationConfig.thinkingConfig = {
      thinkingBudget: 2048
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(`[Gemini Timeout] Request timed out after 60s. Aborting and retrying without thinking budget.`);
    controller.abort();
  }, 60000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      // If error points to thinkingConfig, or is a 400 Bad Request, retry without thinking budget
      if (errText.includes('thinkingConfig') || errText.includes('thinking_config') || res.status === 400) {
        if (useThinking) {
          console.warn(`[Gemini Warning] thinkingConfig not supported by model or parameter is invalid. Retrying without it.`);
          return callLLMGemini(systemInstruction, userPrompt, jsonMode, false);
        }
      }
      throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    try {
      const text = data.candidates[0].content.parts[0].text;
      return text;
    } catch (e) {
      throw new Error(`Failed to parse Gemini response: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError' && useThinking) {
      console.warn(`[Gemini Timeout Retry] Retrying without thinking budget.`);
      return callLLMGemini(systemInstruction, userPrompt, jsonMode, false);
    }
    throw err;
  }
}

/**
 * Unified LLM caller supporting Gemini API and OpenAI API
 */
async function callLLM(systemInstruction, userPrompt, jsonMode = false) {
  const geminiKey = appConfig.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const openaiKey = appConfig.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const provider = appConfig.LLM_PROVIDER || process.env.LLM_PROVIDER || (geminiKey ? 'gemini' : 'openai');

  if (provider === 'gemini' && geminiKey) {
    try {
      return await callLLMGemini(systemInstruction, userPrompt, jsonMode, true);
    } catch (geminiErr) {
      if (openaiKey) {
        console.warn(`[LLM Fallback] Gemini failed, falling back to OpenAI/DeepSeek. Error:`, geminiErr.message);
      } else {
        throw geminiErr;
      }
    }
  }

  if (openaiKey) {
    try {
      const model = appConfig.OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
      let url = appConfig.OPENAI_API_BASE || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1/chat/completions';
      if (url && !url.endsWith('/chat/completions')) {
        url = url.replace(/\/$/, '') + '/chat/completions';
      }

      const body = {
        model,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt }
        ]
      };

      if (jsonMode) {
        body.response_format = { type: 'json_object' };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI API error (${res.status}): ${errText}`);
      }

      const data = await res.json();
      return data.choices[0].message.content;
    } catch (openaiErr) {
      if (provider === 'openai' && geminiKey) {
        console.warn(`[LLM Fallback] OpenAI/DeepSeek failed, falling back to Gemini. Error:`, openaiErr.message);
        return await callLLMGemini(systemInstruction, userPrompt, jsonMode, true);
      }
      throw openaiErr;
    }
  }

  console.warn("No LLM API keys configured. Running in MOCK mode.");
  if (jsonMode) {
    const isSearch = systemInstruction.includes('relevant_pages') || userPrompt.includes('relevant_pages');
    const isAnswer = systemInstruction.includes('answer') || systemInstruction.includes('suggestions');

    if (isSearch) {
      return JSON.stringify({
        relevant_pages: ["overview.md"]
      });
    } else if (isAnswer) {
      return JSON.stringify({
        answer: "Vui lòng cấu hình `GEMINI_API_KEY` trong file `.env` để kích hoạt tính năng hỏi đáp thông minh sử dụng mô hình ngôn ngữ lớn.",
        suggestions: [
          "Làm thế nào để cấu hình API Key?",
          "Xem hướng dẫn sử dụng Wiki",
          "MinusWiki là gì?"
        ]
      });
    } else {
      return JSON.stringify({
        concepts: [
          {
            name: "Mẫu Tri Thức",
            slug: "mau_tri_thuc",
            definition: "Đây là khái niệm mẫu được tạo ra do hệ thống chưa được cấu hình API Key.",
            content: "Nội dung chi tiết của Khái niệm Mẫu. Khi cấu hình GEMINI_API_KEY trong file .env, LLM sẽ tự động phân tích tài liệu và thay thế trang này bằng kiến thức thực tế trích xuất được.",
            related: []
          }
        ]
      });
    }
  } else {
    // jsonMode is false (Markdown responses)
    if (systemInstruction.includes('tích hợp') || systemInstruction.includes('merge')) {
      const match = userPrompt.match(/=== NỘI DUNG WIKI HIỆN TẠI ===\s*([\s\S]*?)\s*=== THÔNG TIN MỚI CẦN BỔ SUNG ===/);
      const existing = match ? match[1].trim() : '';
      return existing + '\n\n## Cập nhật bổ sung (Mock Mode)\nĐây là thông tin bổ sung được cập nhật mô phỏng ở chế độ Mock do chưa cấu hình API Key.';
    } else if (systemInstruction.includes('định dạng thông tin') || systemInstruction.includes('create')) {
      const defMatch = userPrompt.match(/Định nghĩa:\s*([^\n]+)/);
      const contentMatch = userPrompt.match(/Nội dung chi tiết:\s*([\s\S]+?)(?=\s*Các khái niệm|$)/);
      const def = defMatch ? defMatch[1].trim() : 'Đây là khái niệm mẫu được tạo ra do chưa cấu hình API Key.';
      const contentText = contentMatch ? contentMatch[1].trim() : 'Nội dung được tạo ở chế độ Mock.';

      const nameMatch = systemInstruction.match(/khái niệm "([^"]+)"/);
      const conceptName = nameMatch ? nameMatch[1] : 'Khái niệm';
      return `# ${conceptName}\n\n> **Định nghĩa:** ${def}\n\n${contentText}\n\n## Khái niệm liên quan\n- [Trang chủ](overview.md)\n`;
    } else if (systemInstruction.includes('index.md') || systemInstruction.includes('danh mục')) {
      // Could be cascade deletion or normal index update
      if (systemInstruction.includes('vừa bị xóa')) {
        const indexMatch = userPrompt.match(/=== index\.md ===\s*([\s\S]+)/);
        const indexContent = indexMatch ? indexMatch[1] : userPrompt;
        const targetMatch = systemInstruction.match(/vừa bị xóa "([^"]+)"/);
        if (targetMatch) {
          const target = targetMatch[1];
          const lines = indexContent.split('\n').filter(line => !line.includes(target));
          return lines.join('\n');
        }
        return indexContent;
      } else {
        const match = userPrompt.match(/=== DANH MỤC HIỆN TẠI \(index\.md\) ===\s*([\s\S]*?)\s*=== CÁC LIÊN KẾT MỚI CẦN THÊM ===/);
        const existing = match ? match[1].trim() : '';
        const newLinksMatch = userPrompt.match(/=== CÁC LIÊN KẾT MỚI CẦN THÊM ===\s*([\s\S]+)/);
        const newLinks = newLinksMatch ? newLinksMatch[1].trim() : '';
        return existing + '\n\n### Tài liệu mới cập nhật (Mock Mode)\n' + newLinks;
      }
    } else if (systemInstruction.includes('overview.md') || systemInstruction.includes('tổng quan')) {
      const match = userPrompt.match(/=== TỔNG QUAN HIỆN TẠI \(overview\.md\) ===\s*([\s\S]*?)\s*=== CÁC KHÁI NIỆM MỚI THÊM ===/);
      const existing = match ? match[1].trim() : '';
      const newConceptsMatch = userPrompt.match(/=== CÁC KHÁI NIỆM MỚI THÊM ===\s*([\s\S]+)/);
      const newConcepts = newConceptsMatch ? newConceptsMatch[1].trim() : '';
      return existing + '\n\n### Tóm tắt tài liệu mới (Mock Mode)\n' + newConcepts;
    }

    return "Đây là nội dung văn bản được tạo tự động ở chế độ Mock.";
  }
}

/**
 * Split text into chunks if it exceeds maxWords
 */
function chunkText(text, maxWords = 15000) {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) {
    return [text];
  }
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) {
    chunks.push(words.slice(i, i + maxWords).join(' '));
  }
  return chunks;
}

/**
 * Merge list of concepts (e.g. from multiple chunks)
 */
function mergeConcepts(allConceptsList) {
  const mergedMap = new Map();
  for (const concepts of allConceptsList) {
    for (const concept of concepts) {
      if (!concept.slug || !concept.name) continue;
      const slug = concept.slug.toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
      if (mergedMap.has(slug)) {
        const existing = mergedMap.get(slug);
        existing.definition = (existing.definition + ' | ' + concept.definition).substring(0, 500);
        existing.content = existing.content + '\n\n' + concept.content;
        existing.related = [...new Set([...existing.related, ...(concept.related || [])])];
      } else {
        mergedMap.set(slug, { ...concept, slug });
      }
    }
  }
  return Array.from(mergedMap.values());
}

/**
 * Two-Step Chain-of-Thought Ingest Pipeline
 * Extracts key entities/concepts from text and merges them into the wiki markdown structure.
 */
async function runIngestPipeline(projectId, sourceName, text) {
  const mutex = getProjectMutex(projectId);
  return mutex.runExclusive(async () => {
    console.log(`Starting Ingest Pipeline for project ${projectId}, source: ${sourceName}`);
    const wikiDir = path.join(PROJECTS_DIR, projectId, 'wiki');

    // Step 0: Handle document chunking if exceeds limits (approx 20,000 words ~ 12,000 limit for safety)
    const chunks = chunkText(text, 12000);
    const allExtractedConcepts = [];

    // Step 1: Chain-of-Thought Extraction for each chunk
    const extractSystem = `
    Bạn là chuyên gia phân tích tài liệu và xây dựng Cơ sở tri thức (Wiki) cá nhân bằng tiếng Việt.
    Nhiệm vụ của bạn là đọc kỹ đoạn văn bản được cung cấp và trích xuất tất cả các thực thể, định nghĩa, khái niệm quan trọng có ý nghĩa nghiên cứu/học tập lâu dài.
    Đầu ra PHẢI là một đối tượng JSON hợp lệ có định dạng sau:
    {
      "concepts": [
        {
          "name": "Tên khái niệm (ví dụ: Trí tuệ nhân tạo)",
          "slug": "slug_viet_tat_khong_dau_viet_lien_hoac_noi_bang_gach_duoi (ví dụ: tri_tue_nhan_tao)",
          "definition": "Định nghĩa ngắn gọn, rõ ràng (1-2 câu) bằng tiếng Việt",
          "content": "Nội dung chi tiết giải thích sâu về khái niệm này. Sử dụng định dạng Markdown phong phú (tiêu đề ##, ###, danh sách bullet points, bảng biểu, công thức...). Nội dung này phải toàn diện và tự chứa đựng.",
          "related": ["slug_khai_niem_lien_quan_1", "slug_khai_niem_lien_quan_2"]
        }
      ]
    }
    Chỉ trích xuất các khái niệm cốt lõi thực sự hữu ích. Trả về đúng định dạng JSON, không có thêm ký tự markdown hay lời giải thích nào bên ngoài khối JSON.
    `;

    for (let i = 0; i < chunks.length; i++) {
      console.log(`Processing chunk ${i + 1}/${chunks.length} for source "${sourceName}"`);
      const userPrompt = `Hãy trích xuất kiến thức từ đoạn văn bản sau đây:\n\n${chunks[i]}`;
      try {
        const responseText = await callLLM(extractSystem, userPrompt, true);
        const parsed = parseLLMJSON(responseText);
        if (parsed && Array.isArray(parsed.concepts)) {
          allExtractedConcepts.push(parsed.concepts);
        }
      } catch (err) {
        console.error(`Error processing chunk ${i + 1}:`, err);
      }
    }

    const mergedConcepts = mergeConcepts(allExtractedConcepts);
    if (mergedConcepts.length === 0) {
      return { success: false, message: 'No concepts could be extracted.' };
    }

    // Step 2: Synthesis & File Integration
    const files = await fs.readdir(wikiDir);
    const existingSlugs = files.filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));

    for (const concept of mergedConcepts) {
      const pagePath = path.join(wikiDir, `${concept.slug}.md`);
      let bodyContent = '';
      let frontmatter = {};
      let contradiction = null;

      if (existsSync(pagePath)) {
        // Merge with existing page
        const existingContent = await fs.readFile(pagePath, 'utf-8');
        const parsed = parseFrontmatter(existingContent);

        let sources = parsed.frontmatter.sources || [];
        if (!Array.isArray(sources)) {
          sources = sources ? [sources] : [];
        }
        if (!sources.includes(sourceName)) {
          sources.push(sourceName);
        }
        frontmatter = {
          ...parsed.frontmatter,
          sources
        };

        // Check for contradictions before merging
        try {
          const checkSystem = `
          Bạn là chuyên gia kiểm định chất lượng tri thức bằng tiếng Việt.
          Hãy so sánh nội dung Wiki hiện tại và thông tin mới nhận được.
          Nhiệm vụ của bạn là phát hiện xem có mâu thuẫn hay trái ngược trực tiếp nào về số liệu, ngày tháng, định nghĩa hoặc khẳng định khoa học giữa hai văn bản hay không.
          Nếu có mâu thuẫn, hãy viết 1 câu mô tả ngắn gọn mâu thuẫn đó bằng tiếng Việt.
          Nếu không có mâu thuẫn nào, trả về chính xác từ khóa: NO_CONTRADICTION
          `;
          const checkUser = `
          === NỘI DUNG WIKI HIỆN TẠI ===
          ${parsed.content}

          === THÔNG TIN MỚI CẦN BỔ SUNG ===
          Định nghĩa mới: ${concept.definition}
          Nội dung mới: ${concept.content}
          `;

          console.log(`Checking contradiction for ${concept.slug}...`);
          const checkRes = await callLLM(checkSystem, checkUser, false);
          if (checkRes && checkRes.trim() !== 'NO_CONTRADICTION' && !checkRes.trim().includes('NO_CONTRADICTION')) {
            contradiction = checkRes.trim();
            console.log(`Contradiction detected in ${concept.slug}: ${contradiction}`);
          }
        } catch (err) {
          console.error(`Error checking contradiction for ${concept.slug}:`, err);
        }

        const mergeSystem = `
        Bạn là chuyên gia biên soạn Wiki chuyên nghiệp bằng tiếng Việt.
        Nhiệm vụ của bạn là tích hợp thông tin mới về khái niệm "${concept.name}" vào nội dung trang Wiki hiện tại của nó.
        Hãy giữ nguyên các tiêu đề, định dạng cũ, không làm mất bất kỳ thông tin cũ nào, đồng thời thêm thông tin mới một cách logic.
        Duy trì và bổ sung các liên kết markdown định dạng [Tên Khái Niệm](slug.md) tới các khái niệm khác.
        Đầu ra phải là toàn bộ nội dung Markdown mới của trang (không bao gồm frontmatter), không chứa bất kỳ giải thích nào bên ngoài.
        `;

        const mergeUser = `
        === NỘI DUNG WIKI HIỆN TẠI ===
        ${parsed.content}

        === THÔNG TIN MỚI CẦN BỔ SUNG ===
        Định nghĩa mới: ${concept.definition}
        Nội dung mới: ${concept.content}
        `;

        try {
          bodyContent = await callLLM(mergeSystem, mergeUser, false);
        } catch (err) {
          console.error(`Failed to merge concept ${concept.slug}:`, err);
          bodyContent = parsed.content + `\n\n## Cập nhật bổ sung từ ${sourceName}\n${concept.content}`;
        }
      } else {
        // Create new page
        frontmatter = {
          sources: [sourceName]
        };

        const createSystem = `
        Bạn là chuyên gia biên soạn Wiki bằng tiếng Việt.
        Nhiệm vụ của bạn là định dạng thông tin của khái niệm "${concept.name}" thành một trang Markdown Wiki đẹp, rõ ràng.
        Dưới đây là danh sách các trang Wiki hiện có: ${JSON.stringify(existingSlugs)}.
        Hãy quét qua phần nội dung và tự động tạo liên kết markdown định dạng [Tên hiển thị](slug.md) khi nhắc tới bất kỳ khái niệm nào trong danh sách trên.
        Đầu ra chỉ chứa mã Markdown trang Wiki, bắt đầu bằng tiêu đề # ${concept.name}. Không chứa giải thích ngoài.
        `;

        const createUser = `
        Định nghĩa: ${concept.definition}
        Nội dung chi tiết: ${concept.content}
        Các khái niệm liên quan đề xuất: ${JSON.stringify(concept.related)}
        `;

        try {
          bodyContent = await callLLM(createSystem, createUser, false);
        } catch (err) {
          console.error(`Failed to create page for ${concept.slug}, using basic layout:`, err);
          bodyContent = `# ${concept.name}\n\n> **Định nghĩa:** ${concept.definition}\n\n${concept.content}\n\n## Khái niệm liên quan\n${(concept.related || []).map(r => `- [${r.replace(/_/g, ' ')}](${r}.md)`).join('\n')}`;
        }
      }

      if (contradiction) {
        frontmatter.contradiction = contradiction;
        frontmatter.originalContent = parsed ? parsed.content : '';
      }

      const finalPageContent = stringifyFrontmatter(frontmatter, bodyContent);
      await fs.writeFile(pagePath, finalPageContent);

      // Add new slug to local existing slugs so subsequent iterations can interlink
      if (!existingSlugs.includes(concept.slug)) {
        existingSlugs.push(concept.slug);
      }
    }

    // Update Directory Page (index.md)
    try {
      const indexFilePath = path.join(wikiDir, 'index.md');
      const indexContent = await fs.readFile(indexFilePath, 'utf-8');
      const indexSystem = `
      Bạn là biên tập viên Wiki bằng tiếng Việt.
      Hãy cập nhật tệp lục danh mục \`index.md\` để chèn các liên kết khái niệm mới vào đúng phần phân loại thích hợp nhất (ví dụ: Công nghệ, Khoa học, Nhân văn, v.v.).
      Nếu chưa có phần phù hợp, bạn có thể tạo phần mới. Hãy giữ nguyên định dạng danh sách và các liên kết cũ.
      Đầu ra phải là toàn bộ nội dung Markdown mới của tệp \`index.md\`, không chứa giải thích nào bên ngoài.
      `;
      const indexUser = `
      === DANH MỤC HIỆN TẠI (index.md) ===
      ${indexContent}

      === CÁC LIÊN KẾT MỚI CẦN THÊM ===
      ${mergedConcepts.map(c => `- [${c.name}](${c.slug}.md) : ${c.definition}`).join('\n')}
      `;
      const updatedIndex = await callLLM(indexSystem, indexUser, false);
      await fs.writeFile(indexFilePath, updatedIndex);
    } catch (err) {
      console.error('Failed to update index.md:', err);
    }

    // Update Overview Page (overview.md)
    try {
      const overviewFilePath = path.join(wikiDir, 'overview.md');
      const overviewContent = await fs.readFile(overviewFilePath, 'utf-8');
      const overviewSystem = `
      Bạn là chuyên gia tổng hợp tài liệu bằng tiếng Việt.
      Hãy cập nhật tệp tổng quan \`overview.md\` để tích hợp tóm tắt về các khái niệm mới được thêm vào Wiki, giúp người đọc nắm bắt nhanh cấu trúc kiến thức hiện có.
      Giữ nguyên văn phong khoa học, rõ ràng và cấu trúc hiện tại của trang tổng quan.
      Đầu ra phải là toàn bộ nội dung Markdown mới của tệp \`overview.md\`, không chứa giải thích bên ngoài.
      `;
      const overviewUser = `
      === TỔNG QUAN HIỆN TẠI (overview.md) ===
      ${overviewContent}

      === CÁC KHÁI NIỆM MỚI THÊM ===
      ${mergedConcepts.map(c => `- **${c.name}**: ${c.definition}`).join('\n')}
      `;
      const updatedOverview = await callLLM(overviewSystem, overviewUser, false);
      await fs.writeFile(overviewFilePath, updatedOverview);
    } catch (err) {
      console.error('Failed to update overview.md:', err);
    }

    // Log the changes to log.md
    try {
      const logFilePath = path.join(wikiDir, 'log.md');
      const timestamp = new Date().toISOString();
      const newLogs = mergedConcepts.map(c => `[${c.name}](${c.slug}.md)`).join(', ');
      await fs.appendFile(
        logFilePath,
        `\n- [${timestamp}] Nạp tài liệu "${sourceName}", trích xuất và cập nhật các trang: ${newLogs}\n`
      );
    } catch (err) {
      console.error('Failed to write log.md:', err);
    }

    return {
      success: true,
      message: `Ingested ${mergedConcepts.length} concepts successfully.`,
    };
  });
}

/**
 * Query Retrieval Pipeline (4 phases)
 * Searches the wiki pages, synthesizes a reply, and suggests follow-up actions.
 */
async function runQueryPipeline(projectId, query) {
  console.log(`Starting Query Pipeline for project ${projectId}, query: "${query}"`);
  const wikiDir = path.join(PROJECTS_DIR, projectId, 'wiki');

  if (!existsSync(wikiDir)) {
    throw new Error('Wiki directory not found');
  }

  // Phase 1: Search / Index Lookup
  const files = await fs.readdir(wikiDir);
  const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'log.md' && f !== 'index.md');
  const pagesSummary = [];

  for (const file of mdFiles) {
    const filePath = path.join(wikiDir, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const slug = file.replace('.md', '');
    const firstLines = content.split('\n').slice(0, 5).join(' ');
    pagesSummary.push({
      slug,
      summary: firstLines.substring(0, 200)
    });
  }

  // Use LLM to select the most relevant pages
  const searchSystem = `
  Bạn là trợ lý tìm kiếm Wiki thông minh bằng tiếng Việt.
  Dựa trên câu hỏi của người dùng, hãy chọn ra tối đa 5 tệp Wiki (.md) liên quan nhất từ danh sách các trang đang có sẵn.
  Trả về kết quả dưới dạng JSON duy nhất có cấu trúc:
  {
    "relevant_pages": ["slug1.md", "slug2.md"]
  }
  Nếu không có trang nào liên quan, trả về mảng rỗng. Không kèm giải thích.
  `;

  const searchUser = `
  Câu hỏi người dùng: "${query}"

  Danh sách các trang Wiki hiện có:
  ${JSON.stringify(pagesSummary, null, 2)}
  `;

  let relevantPages = [];
  try {
    const searchResponse = await callLLM(searchSystem, searchUser, true);
    const parsedSearch = parseLLMJSON(searchResponse);
    if (parsedSearch && Array.isArray(parsedSearch.relevant_pages)) {
      relevantPages = parsedSearch.relevant_pages.map(p => p.endsWith('.md') ? p : `${p}.md`);
    }
  } catch (err) {
    console.error('Failed to run LLM search selection:', err);
    // Simple fallback keyword search
    relevantPages = mdFiles.filter(file => {
      const normalizedQuery = query.toLowerCase();
      const normalizedName = file.replace('.md', '').replace(/_/g, ' ').toLowerCase();
      return normalizedQuery.includes(normalizedName) || normalizedName.includes(normalizedQuery);
    }).slice(0, 5);
  }

  // Always include index.md and overview.md for general context if no pages found
  if (relevantPages.length === 0) {
    relevantPages = ['overview.md'];
  }

  // Phase 2: Read relevant pages
  let contextText = '';
  const loadedSources = [];
  for (const page of relevantPages) {
    const pagePath = path.join(wikiDir, page);
    if (existsSync(pagePath)) {
      const content = await fs.readFile(pagePath, 'utf-8');
      contextText += `=== FILE: ${page} ===\n${content}\n\n`;
      loadedSources.push(page);
    }
  }

  // Phase 3 & 4: Generate Answer & Suggestions
  const answerSystem = `
  Bạn là chuyên gia tư vấn thông tin dựa trên Wiki cá nhân bằng tiếng Việt.
  Hãy trả lời câu hỏi của người dùng bằng cách sử dụng thông tin từ ngữ cảnh Wiki được cung cấp.
  Đầu ra phải là một đối tượng JSON có cấu trúc sau:
  {
    "answer": "Nội dung trả lời chi tiết bằng Markdown tiếng Việt. Luôn đính kèm liên kết nội bộ dạng [Tên hiển thị](slug.md) khi đề cập đến các khái niệm trong Wiki. Chỉ liên kết tới các trang thực sự tồn tại trong Wiki.",
    "suggestions": [
      "Câu hỏi gợi ý tiếp theo 1",
      "Câu hỏi gợi ý tiếp theo 2",
      "Câu hỏi gợi ý tiếp theo 3"
    ]
  }
  Chỉ trả về JSON, không kèm lời giải thích nào ngoài khối JSON.
  `;

  const answerUser = `
  Ngữ cảnh Wiki:
  ${contextText}

  Câu hỏi người dùng: "${query}"
  `;

  try {
    const answerResponse = await callLLM(answerSystem, answerUser, true);
    const parsedAnswer = parseLLMJSON(answerResponse);
    return {
      answer: parsedAnswer.answer,
      sources: loadedSources.map(s => s.replace('.md', '')),
      suggestions: parsedAnswer.suggestions || []
    };
  } catch (err) {
    console.error('Failed to generate answer via LLM:', err);
    return {
      answer: `Đã xảy ra lỗi khi kết nối với LLM để trả lời câu hỏi của bạn: **${err.message}**\n\nVui lòng kiểm tra lại cấu hình khóa API trong tệp \`.env\` hoặc số dư tài khoản của bạn. Dưới đây là các tài liệu liên quan được tìm thấy:\n\n${relevantPages.map(p => `- [${p.replace('.md', '')}](${p})`).join('\n')}`,
      sources: loadedSources.map(s => s.replace('.md', '')),
      suggestions: ['Hãy thử lại câu hỏi của bạn', 'Xem danh mục các trang']
    };
  }
}

/**
 * Cascade Deletion & Lint Operation
 * Triggered when a wiki page is deleted. Updates index.md, removes dead links from other pages, and logs deletion.
 */
async function runCascadeDeletionAndLint(projectId, targetFilename) {
  const mutex = getProjectMutex(projectId);
  return mutex.runExclusive(async () => {
    console.log(`Running Cascade Deletion & Lint for page: ${targetFilename}`);
    const wikiDir = path.join(PROJECTS_DIR, projectId, 'wiki');

    // 1. Delete page reference from index.md using LLM
    try {
      const indexFilePath = path.join(wikiDir, 'index.md');
      if (existsSync(indexFilePath)) {
        const indexContent = await fs.readFile(indexFilePath, 'utf-8');
        const lintSystem = `
        Bạn là biên tập viên Wiki bằng tiếng Việt.
        Nhiệm vụ của bạn là dọn dẹp liên kết của trang Wiki vừa bị xóa "${targetFilename}" khỏi danh mục \`index.md\`.
        Hãy xóa dòng liên kết liên quan đến trang đó nhưng giữ nguyên phần còn lại của danh mục.
        Đầu ra phải là toàn bộ nội dung Markdown mới của tệp \`index.md\`, không chứa giải thích nào bên ngoài.
        `;
        const updatedIndex = await callLLM(lintSystem, `=== index.md ===\n${indexContent}`, false);
        await fs.writeFile(indexFilePath, updatedIndex);
      }
    } catch (err) {
      console.error('Failed to update index.md during deletion lint:', err);
    }

    // 2. Scan and remove references from all other wiki pages (Programmatically using Regex)
    try {
      const files = await fs.readdir(wikiDir);
      const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md');

      // Target link regex: [text](targetFilename) or [text](./targetFilename)
      const linkRegex = new RegExp(`\\[([^\\]]+)\\]\\((?:\\.\\/)?${targetFilename.replace('.', '\\.')}\\)`, 'g');

      for (const file of mdFiles) {
        const filePath = path.join(wikiDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        if (linkRegex.test(content)) {
          const updatedContent = content.replace(linkRegex, '$1'); // Replace markdown link with plain text
          await fs.writeFile(filePath, updatedContent);
          console.log(`Auto-cleaned dead link in file: ${file}`);
        }
      }
    } catch (err) {
      console.error('Failed to check and replace dead links programmatically:', err);
    }

    // 3. Log the deletion to log.md
    try {
      const logFilePath = path.join(wikiDir, 'log.md');
      const timestamp = new Date().toISOString();
      await fs.appendFile(
        logFilePath,
        `\n- [${timestamp}] Đã xóa trang "${targetFilename.replace('.md', '')}" và tự động dọn dẹp các liên kết hỏng.\n`
      );
    } catch (err) {
      console.error('Failed to log deletion to log.md:', err);
    }
  });
}

// ==========================================
// API ENDPOINTS
// ==========================================

// --- Project Management Endpoints ---

/**
 * GET /api/projects
 * List all projects (reads metadata from each project directory)
 */
app.get('/api/projects', async (req, res) => {
  try {
    const files = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    const projects = [];

    for (const file of files) {
      if (file.isDirectory()) {
        const projectId = file.name;
        const metaPath = path.join(PROJECTS_DIR, projectId, 'metadata.json');
        if (existsSync(metaPath)) {
          const metaContent = await fs.readFile(metaPath, 'utf-8');
          projects.push(JSON.parse(metaContent));
        } else {
          projects.push({ id: projectId, title: 'Untitled Wiki', createdAt: 'Unknown' });
        }
      }
    }

    res.json(projects);
  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

/**
 * POST /api/projects
 * Create a new wiki project
 */
app.post('/api/projects', async (req, res) => {
  try {
    const { title } = req.body;
    const projectId = uuidv4();
    const projectPath = path.join(PROJECTS_DIR, projectId);
    const wikiPath = path.join(projectPath, 'wiki');
    const sourcesPath = path.join(projectPath, 'sources');

    // Create folders
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(wikiPath, { recursive: true });
    await fs.mkdir(sourcesPath, { recursive: true });

    // Initialize project files
    const metadata = {
      id: projectId,
      title: title || 'New Knowledge Base',
      createdAt: new Date().toISOString(),
    };

    await fs.writeFile(path.join(projectPath, 'metadata.json'), JSON.stringify(metadata, null, 2));

    // Create default wiki pages
    const indexContent = `# Danh mục (Wiki Index)\n\n- [Trang chủ (Overview)](overview.md)\n- [Lịch sử cập nhật (Log)](log.md)\n`;
    const overviewContent = `# Tổng quan (Overview)\n\nChào mừng bạn đến với **${metadata.title}**!\n\nHãy tải tài liệu lên hoặc lưu các trang web để bắt đầu biên soạn cơ sở tri thức cá nhân của bạn.`;
    const logContent = `# Nhật ký hoạt động (Activity Log)\n\n- [${metadata.createdAt}] Cơ sở tri thức được tạo mới.\n`;

    await fs.writeFile(path.join(wikiPath, 'index.md'), indexContent);
    await fs.writeFile(path.join(wikiPath, 'overview.md'), overviewContent);
    await fs.writeFile(path.join(wikiPath, 'log.md'), logContent);

    // Create default purpose.md file
    const purposeContent = `# Mục tiêu hệ thống Wiki
Hệ thống này đóng vai trò là một "Kiến trúc sư tri thức chủ động". Nhiệm vụ cốt lõi là tiếp nhận các tài liệu thô, rời rạc (Văn bản, nhật ký, tài liệu kỹ thuật) và chuyển đổi, cấu trúc lại chúng thành các trang kiến thức Markdown (.md) chuẩn chỉnh, có tính liên kết cao và dễ tra cứu.

# Quy tắc biên soạn và Định dạng của AI (Bắt buộc)

## 1. Cấu trúc Phân cấp Ngữ nghĩa (Semantic Hierarchy)
- Phân tích nội dung thô và phân loại logic thành các phần rõ ràng bằng thẻ Header từ lớn đến nhỏ (\`#\`, \`##\`, \`###\`).
- Không sử dụng quá 4 cấp độ Header (\`####\`) để tránh làm rối cấu trúc cây thư mục.
- Giữa các Header và đoạn văn bắt buộc phải có 1 dòng trống để đảm bảo chuẩn hiển thị CommonMark.

## 2. Trực quan hóa dữ liệu (Tables & Lists)
- **Dữ liệu liệt kê/so sánh:** Nếu nội dung chứa thông số, dữ liệu so sánh, hoặc danh sách thuộc tính của một đối tượng, BẮT BUỘC phải chuyển đổi thành bảng dữ liệu (\`| Column |\`). Các cột phải có hàng phân cách (\`|---|---|\`) rõ ràng.
- **Danh sách lồng nhau:** Sử dụng dấu gạch đầu dòng (\`-\`) cho danh sách không thứ tự và số (\`1.\`) cho quy trình tuần tự. Danh sách lồng nhau phải thụt lề đúng 4 khoảng trắng (spaces).

## 3. Quản lý Liên kết chéo (Wikilinks & Terminology)
- Chỉ áp dụng tính năng liên kết chéo dạng \`[[Tên_Khái_Niệm]]\` cho các từ khóa quan trọng, thuật ngữ chuyên ngành, hoặc thực thể (Entity) xuất hiện lần đầu tiên trong bài văn. KHÔNG liên kết vô tội vạ các từ ngữ thông thường.
- **Giữ nguyên thuật ngữ chuyên ngành:** Giữ nguyên các thuật ngữ tiếng Anh kỹ thuật gốc (ví dụ: *Context Window*, *Caching*, *Full-stack*) nếu việc dịch sang tiếng Việt làm tối nghĩa hoặc mất đi tính chuẩn xác của ngành.

## 4. Kiểm soát Đầu ra Sạch (Clean Output Control)
- Phản hồi trả về PHẢI là định dạng Markdown sạch 100%. 
- BẮT BUỘC bọc toàn bộ mã nguồn Markdown trong một khối codeblock lớn: \`\`\`markdown ... \`\`\`
`;
    await fs.writeFile(path.join(wikiPath, 'purpose.md'), purposeContent);

    // Initialize watcher for new project sources
    await watchProjectSources(projectId);

    res.status(201).json(metadata);
  } catch (error) {
    console.error('Error creating project:', error);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

/**
 * GET /api/projects/:id
 * Retrieve project details including sources, logs, and list of wiki pages
 */
app.get('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  const projectPath = path.join(PROJECTS_DIR, id);

  if (!existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project not found' });
  }

  try {
    const metaPath = path.join(projectPath, 'metadata.json');
    const metadata = existsSync(metaPath) ? JSON.parse(await fs.readFile(metaPath, 'utf-8')) : { id };

    // Get sources list
    const sourcesPath = path.join(projectPath, 'sources');
    const sourceFiles = existsSync(sourcesPath) ? await fs.readdir(sourcesPath) : [];

    // Get wiki files list
    const wikiPath = path.join(projectPath, 'wiki');
    const wikiFiles = existsSync(wikiPath) ? await fs.readdir(wikiPath) : [];

    const pages = [];
    for (const filename of wikiFiles) {
      if (filename.endsWith('.md')) {
        const filePath = path.join(wikiPath, filename);
        const stats = await fs.stat(filePath);
        let hasContradiction = false;
        try {
          const fileContent = await fs.readFile(filePath, 'utf-8');
          const parsed = parseFrontmatter(fileContent);
          if (parsed.frontmatter && parsed.frontmatter.contradiction) {
            hasContradiction = true;
          }
        } catch (err) {
          console.error(`Error checking contradiction for ${filename}:`, err);
        }
        pages.push({
          filename,
          title: filename.replace('.md', '').replace(/_/g, ' '),
          updatedAt: stats.mtime.toISOString(),
          size: stats.size,
          hasContradiction
        });
      }
    }

    res.json({
      metadata,
      sources: sourceFiles,
      pages
    });
  } catch (error) {
    console.error('Error retrieving project details:', error);
    res.status(500).json({ error: 'Failed to retrieve project details' });
  }
});

/**
 * DELETE /api/projects/:id
 * Delete a project and all its files
 */
app.delete('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  const projectPath = path.join(PROJECTS_DIR, id);

  if (!existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project not found' });
  }

  try {
    await fs.rm(projectPath, { recursive: true, force: true });
    projectMutexes.delete(id); // Clean up mutex references
    res.json({ success: true, message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
});

// --- Document Ingestion & Web Clipper Endpoints ---

/**
 * POST /api/projects/:id/upload
 * Handle file upload(s) by saving them in the sources/ directory.
 * The file watcher will automatically queue them for background ingestion.
 */
app.post('/api/projects/:id/upload', upload.array('files'), async (req, res) => {
  const { id } = req.params;
  const projectPath = path.join(PROJECTS_DIR, id);

  if (!existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project not found' });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const results = [];
  try {
    for (const file of req.files) {
      const destPath = path.join(projectPath, 'sources', file.originalname);
      await fs.rename(file.path, destPath);

      results.push({
        filename: file.originalname,
        success: true,
        message: 'File uploaded and queued for background ingestion.'
      });
    }

    res.json({
      success: true,
      message: 'Files uploaded successfully. Background ingestion started.',
      results
    });
  } catch (error) {
    console.error('Error handling upload:', error);
    res.status(500).json({ error: `Upload processing failed: ${error.message}` });
  }
});

/**
 * POST /api/projects/:id/clip
 * Receive cropped web page details from Chrome Extension and save in sources/ to trigger queue ingestion.
 */
app.post('/api/projects/:id/clip', async (req, res) => {
  const { id } = req.params;
  const { title, url, html, text } = req.body;
  const projectPath = path.join(PROJECTS_DIR, id);

  if (!existsSync(projectPath)) {
    return res.status(404).json({ error: 'Project not found' });
  }

  if (!url || !text) {
    return res.status(400).json({ error: 'Missing clip URL or content text' });
  }

  try {
    const clipSlug = url.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 100);
    const sourceFileName = `clip_${clipSlug}.txt`;
    const sourcePath = path.join(projectPath, 'sources', sourceFileName);

    const fullContent = `URL: ${url}\nTitle: ${title || 'Web Clip'}\nClipped At: ${new Date().toISOString()}\n\n${text}`;
    await fs.writeFile(sourcePath, fullContent);

    res.json({
      success: true,
      source: sourceFileName,
      message: 'Web clip saved successfully. Background ingestion started.'
    });
  } catch (error) {
    console.error('Error handling web clip:', error);
    res.status(500).json({ error: 'Failed to process web clip' });
  }
});

/**
 * GET /api/projects/:id/queue
 * Retrieve queue tasks list for a project
 */
app.get('/api/projects/:id/queue', (req, res) => {
  const { id } = req.params;
  const projectTasks = ingestQueue.tasks.filter(t => t.projectId === id);
  res.json(projectTasks);
});

/**
 * POST /api/projects/:id/queue/retry
 * Retry a failed or pending queue task manually
 */
app.post('/api/projects/:id/queue/retry', async (req, res) => {
  const { id } = req.params;
  const { taskId } = req.body;
  const task = ingestQueue.tasks.find(t => t.id === taskId && t.projectId === id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  task.status = 'pending';
  task.retries = 0;
  task.error = null;
  await ingestQueue.save();
  ingestQueue.processNext();
  res.json({ success: true, task });
});

/**
 * DELETE /api/projects/:id/sources/:filename
 * Delete a source file and trigger cascade deletion for pages created exclusively from it
 */
app.delete('/api/projects/:id/sources/:filename', async (req, res) => {
  const { id, filename } = req.params;
  const projectPath = path.join(PROJECTS_DIR, id);
  const sourcePath = path.join(projectPath, 'sources', filename);

  if (!existsSync(sourcePath)) {
    return res.status(404).json({ error: 'Source file not found' });
  }

  try {
    // 1. Delete source file
    await fs.unlink(sourcePath);

    // Remove from SHA256 cache
    const cachePath = path.join(projectPath, 'cache_manifest.json');
    if (existsSync(cachePath)) {
      try {
        const cache = JSON.parse(await fs.readFile(cachePath, 'utf-8'));
        delete cache[filename];
        await fs.writeFile(cachePath, JSON.stringify(cache, null, 2));
      } catch (e) {
        console.error('Failed to clean cache manifest for deleted source:', e);
      }
    }

    // Remove tasks from queue associated with this file
    ingestQueue.tasks = ingestQueue.tasks.filter(t => !(t.projectId === id && t.filename === filename));
    await ingestQueue.save();

    // 2. Scan wiki files to identify which pages list this source file in frontmatter
    const wikiDir = path.join(projectPath, 'wiki');
    if (existsSync(wikiDir)) {
      const files = await fs.readdir(wikiDir);
      const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md');

      for (const file of mdFiles) {
        const filePath = path.join(wikiDir, file);
        const rawContent = await fs.readFile(filePath, 'utf-8');
        const { frontmatter, content } = parseFrontmatter(rawContent);

        let sources = frontmatter.sources || [];
        if (!Array.isArray(sources)) sources = [sources];

        if (sources.includes(filename)) {
          // Remove this source
          sources = sources.filter(s => s !== filename);

          if (sources.length === 0) {
            // No other sources refer to this page -> Delete page entirely (Cascade deletion)
            await fs.unlink(filePath);
            await runCascadeDeletionAndLint(id, file);
          } else {
            // Update page with remaining sources
            frontmatter.sources = sources;
            const updatedContent = stringifyFrontmatter(frontmatter, content);
            await fs.writeFile(filePath, updatedContent);
          }
        }
      }
    }

    res.json({ success: true, message: 'Source file deleted and cascade cleaned successfully.' });
  } catch (error) {
    console.error('Error deleting source file:', error);
    res.status(500).json({ error: `Failed to delete source file: ${error.message}` });
  }
});

// --- Wiki Content Reading & Editing Endpoints ---

/**
 * GET /api/projects/:id/wiki/:filename
 * Get raw and rendered HTML content of a wiki markdown file
 */
app.get('/api/projects/:id/wiki/:filename', async (req, res) => {
  const { id, filename } = req.params;

  // Safe filename validation
  const safeFilename = path.basename(filename);
  const filePath = path.join(PROJECTS_DIR, id, 'wiki', safeFilename.endsWith('.md') ? safeFilename : `${safeFilename}.md`);

  if (!existsSync(filePath)) {
    return res.status(404).json({ error: `Wiki page "${safeFilename}" not found` });
  }

  try {
    const markdown = await fs.readFile(filePath, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(markdown);
    const html = marked.parse(content);

    res.json({
      filename: safeFilename.endsWith('.md') ? safeFilename : `${safeFilename}.md`,
      title: safeFilename.replace('.md', '').replace(/_/g, ' '),
      markdown: content,
      rawMarkdown: markdown,
      frontmatter,
      html
    });
  } catch (error) {
    console.error('Error reading wiki page:', error);
    res.status(500).json({ error: 'Failed to read wiki page' });
  }
});

/**
 * PUT /api/projects/:id/wiki/:filename
 * Update content of a wiki page. Enforces project-specific Mutex lock.
 */
app.put('/api/projects/:id/wiki/:filename', async (req, res) => {
  const { id, filename } = req.params;
  const { markdown } = req.body;

  const safeFilename = path.basename(filename);
  const wikiDir = path.join(PROJECTS_DIR, id, 'wiki');
  const filePath = path.join(wikiDir, safeFilename.endsWith('.md') ? safeFilename : `${safeFilename}.md`);

  if (!markdown) {
    return res.status(400).json({ error: 'Markdown content is required' });
  }

  const mutex = getProjectMutex(id);
  try {
    await mutex.runExclusive(async () => {
      // Preserve existing frontmatter if it exists
      let frontmatter = {};
      if (existsSync(filePath)) {
        const existing = await fs.readFile(filePath, 'utf-8');
        const parsed = parseFrontmatter(existing);
        frontmatter = parsed.frontmatter;
      }

      // Format markdown with frontmatter
      const finalContent = stringifyFrontmatter(frontmatter, markdown);

      // Write to file
      await fs.writeFile(filePath, finalContent);

      // Log manual edit
      const timestamp = new Date().toISOString();
      await fs.appendFile(
        path.join(wikiDir, 'log.md'),
        `\n- [${timestamp}] Manually updated page "${safeFilename.replace('.md', '')}"`
      );
    });

    res.json({ success: true, message: 'Wiki page updated successfully' });
  } catch (error) {
    console.error('Error updating wiki page:', error);
    res.status(500).json({ error: 'Failed to update wiki page' });
  }
});

/**
 * DELETE /api/projects/:id/wiki/:filename
 * Delete a wiki page and trigger cascade deletion & link checking (lint)
 */
app.delete('/api/projects/:id/wiki/:filename', async (req, res) => {
  const { id, filename } = req.params;
  const safeFilename = path.basename(filename);
  const targetMd = safeFilename.endsWith('.md') ? safeFilename : `${safeFilename}.md`;
  const filePath = path.join(PROJECTS_DIR, id, 'wiki', targetMd);

  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'Wiki page not found' });
  }

  try {
    // Delete page file
    await fs.unlink(filePath);

    // Trigger cascade deletion / link fixes
    await runCascadeDeletionAndLint(id, targetMd);

    res.json({ success: true, message: `Wiki page "${targetMd}" deleted and link references cleaned.` });
  } catch (error) {
    console.error('Error deleting wiki page:', error);
    res.status(500).json({ error: 'Failed to delete wiki page' });
  }
});

// --- Query, Graph & Log Endpoints ---

/**
 * POST /api/projects/:id/query
 * Execute the 4-phase retrieval chat pipeline
 */
app.post('/api/projects/:id/query', async (req, res) => {
  const { id } = req.params;
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query parameter is required' });
  }

  try {
    const result = await runQueryPipeline(id, query);
    res.json(result);
  } catch (error) {
    console.error('Error processing query:', error);
    res.status(500).json({ error: 'Failed to process query' });
  }
});

/**
 * GET /api/projects/:id/graph
 * Scan wiki files and build standard Node-Edge visualization object mapping references
 */
app.get('/api/projects/:id/graph', async (req, res) => {
  const { id } = req.params;
  const wikiDir = path.join(PROJECTS_DIR, id, 'wiki');

  if (!existsSync(wikiDir)) {
    return res.status(404).json({ error: 'Wiki directory not found' });
  }

  try {
    const files = await fs.readdir(wikiDir);
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'log.md');

    const nodes = [];
    const links = [];

    // Initialize nodes
    mdFiles.forEach(file => {
      const pageId = file.replace('.md', '');
      nodes.push({
        id: pageId,
        label: pageId.replace(/_/g, ' '),
        size: pageId === 'index' || pageId === 'overview' ? 15 : 10
      });
    });

    // Detect links in content
    for (const file of mdFiles) {
      const sourceId = file.replace('.md', '');
      const content = await fs.readFile(path.join(wikiDir, file), 'utf-8');

      // Match Markdown link format: [label](target.md) or [label](./target.md)
      // Captures group: target.md
      const linkRegex = /\[.*?\]\((?:\.\/)?([^)]+?\.md)\)/g;
      let match;
      while ((match = linkRegex.exec(content)) !== null) {
        const targetFilename = match[1];
        const targetId = path.basename(targetFilename).replace('.md', '');

        // Ensure destination node exists
        if (nodes.some(n => n.id === targetId)) {
          // Prevent duplicates
          if (!links.some(l => l.source === sourceId && l.target === targetId)) {
            links.push({
              source: sourceId,
              target: targetId
            });
          }
        }
      }
    }

    res.json({ nodes, links });
  } catch (error) {
    console.error('Error building wiki graph:', error);
    res.status(500).json({ error: 'Failed to build wiki graph' });
  }
});

/**
 * GET /api/projects/:id/logs
 * Retrieve the contents of wiki/log.md for history viewing
 */
app.get('/api/projects/:id/logs', async (req, res) => {
  const { id } = req.params;
  const logPath = path.join(PROJECTS_DIR, id, 'wiki', 'log.md');

  if (!existsSync(logPath)) {
    return res.status(404).json({ error: 'Log file not found' });
  }

  try {
    const logs = await fs.readFile(logPath, 'utf-8');
    res.json({ logs });
  } catch (error) {
    console.error('Error reading logs:', error);
    res.status(500).json({ error: 'Failed to retrieve logs' });
  }
});

/**
 * POST /api/projects/:id/wiki/:filename/resolve-contradiction
 * Resolve / remove the contradiction flag from a wiki page's frontmatter
 */
app.post('/api/projects/:id/wiki/:filename/resolve-contradiction', async (req, res) => {
  const { id, filename } = req.params;
  const { resolution } = req.body; // 'keep_a' or 'keep_b'
  const safeFilename = path.basename(filename);
  const filePath = path.join(PROJECTS_DIR, id, 'wiki', safeFilename.endsWith('.md') ? safeFilename : `${safeFilename}.md`);

  if (!existsSync(filePath)) {
    return res.status(404).json({ error: 'Wiki page not found' });
  }

  const mutex = getProjectMutex(id);
  try {
    await mutex.runExclusive(async () => {
      const existing = await fs.readFile(filePath, 'utf-8');
      const { frontmatter, content } = parseFrontmatter(existing);

      let finalContentText = content; // default is keep current (keep_b)
      if (resolution === 'keep_a' && frontmatter.originalContent) {
        finalContentText = frontmatter.originalContent;
      }

      delete frontmatter.contradiction;
      delete frontmatter.originalContent;

      const finalContent = stringifyFrontmatter(frontmatter, finalContentText);
      await fs.writeFile(filePath, finalContent);

      // Log the contradiction resolution to log.md
      try {
        const wikiDir = path.join(PROJECTS_DIR, id, 'wiki');
        const logFilePath = path.join(wikiDir, 'log.md');
        const timestamp = new Date().toISOString();
        const pageTitle = safeFilename.replace('.md', '');
        const choiceText = resolution === 'keep_a' ? 'dữ liệu A (Tài liệu cũ)' : 'dữ liệu B (Tài liệu mới)';
        await fs.appendFile(
          logFilePath,
          `\n- [${timestamp}] Đã giải quyết mâu thuẫn tri thức cho trang [${pageTitle}](${safeFilename}): Chọn ${choiceText}\n`
        );
      } catch (err) {
        console.error('Failed to log contradiction resolution to log.md:', err);
      }
    });
    res.json({ success: true, message: 'Contradiction resolved.' });
  } catch (error) {
    console.error('Error resolving contradiction:', error);
    res.status(500).json({ error: 'Failed to resolve contradiction' });
  }
});

/**
 * GET /api/projects/:id/maintenance
 * Scan entire Wiki for maintenance:
 * 1. Orphans (pages with no incoming links from other pages)
 * 2. Investigation gaps (analyzed by LLM based on existing topics)
 * 3. Contradictions (pages flagged with a contradiction in frontmatter)
 */
app.get('/api/projects/:id/maintenance', async (req, res) => {
  const { id } = req.params;
  const wikiDir = path.join(PROJECTS_DIR, id, 'wiki');

  if (!existsSync(wikiDir)) {
    return res.status(404).json({ error: 'Wiki directory not found' });
  }

  try {
    const files = await fs.readdir(wikiDir);
    // Ignore index.md, overview.md, log.md
    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'overview.md' && f !== 'log.md');

    const pageTitles = {};
    const inboundLinks = {};
    const contradictions = [];

    // Initialize inbounds
    for (const file of mdFiles) {
      inboundLinks[file] = [];
    }

    // Scan links and contradictions
    for (const file of mdFiles) {
      const filePath = path.join(wikiDir, file);
      const rawContent = await fs.readFile(filePath, 'utf-8');
      const { frontmatter, content } = parseFrontmatter(rawContent);

      // Extract title from H1 or filename
      let title = file.replace('.md', '').replace(/_/g, ' ');
      const h1Match = content.match(/^#\s+(.+)$/m);
      if (h1Match) {
        title = h1Match[1].trim();
      }
      pageTitles[file] = title;

      // Track contradiction
      if (frontmatter.contradiction) {
        contradictions.push({
          filename: file,
          title,
          contradiction: frontmatter.contradiction
        });
      }

      // Match markdown links
      const linkRegex = /\[.*?\]\((?:\.\/)?([^)]+?\.md)\)/g;
      let match;
      while ((match = linkRegex.exec(content)) !== null) {
        const targetFilename = path.basename(match[1]);
        if (targetFilename !== file && inboundLinks[targetFilename] !== undefined) {
          if (!inboundLinks[targetFilename].includes(file)) {
            inboundLinks[targetFilename].push(file);
          }
        }
      }
    }

    // Identify Orphans
    const orphans = [];
    for (const file of mdFiles) {
      if (inboundLinks[file].length === 0) {
        orphans.push({
          filename: file,
          title: pageTitles[file]
        });
      }
    }

    // Call LLM for orphan connection suggestions if there are orphans
    let orphanSuggestions = {};
    if (orphans.length > 0) {
      const conceptsList = mdFiles.map(file => ({
        filename: file,
        title: pageTitles[file]
      }));

      const orphanSystem = `
      Bạn là chuyên gia cấu trúc cơ sở tri thức bằng tiếng Việt.
      Hãy xem xét danh sách các "trang mồ côi" (trang không có liên kết từ các trang khác) và danh sách tất cả các trang hiện có trong Wiki.
      Đề xuất 1-2 trang thích hợp nhất nên liên kết tới mỗi trang mồ côi này để tích hợp chúng vào sơ đồ tri thức chung.
      Đầu ra phải là một đối tượng JSON có định dạng:
      {
        "suggestions": {
          "ten_file_mo_coi.md": [
            {
              "target": "ten_file_lien_ket.md",
              "reason": "Mô tả ngắn gọn lý do liên kết (1 câu)"
            }
          ]
        }
      }
      Chỉ trả về JSON, không kèm giải thích ngoài.
      `;

      const orphanUser = `
      Danh sách các trang mồ côi cần liên kết:
      ${JSON.stringify(orphans, null, 2)}

      Danh sách tất cả các trang trong Wiki:
      ${JSON.stringify(conceptsList, null, 2)}
      `;

      try {
        const responseText = await callLLM(orphanSystem, orphanUser, true);
        const parsed = parseLLMJSON(responseText);
        if (parsed && parsed.suggestions) {
          orphanSuggestions = parsed.suggestions;
        }
      } catch (err) {
        console.error('Failed to get orphan suggestions:', err);
      }
    }

    // Call LLM for investigation gaps
    let gaps = [];
    const conceptsSummary = mdFiles.map(file => ({
      title: pageTitles[file],
      filename: file
    }));

    if (conceptsSummary.length > 0) {
      const gapsSystem = `
      Bạn là chuyên gia phân tích hệ thống tri thức cá nhân bằng tiếng Việt.
      Dưới đây là danh sách các chủ đề và khái niệm hiện có trong Wiki:
      ${JSON.stringify(conceptsSummary, null, 2)}

      Dựa trên các chủ đề này, hãy phân tích và chỉ ra 3-5 "lỗ hổng nghiên cứu" (khoảng trống kiến thức) quan trọng mà người dùng nên bổ sung tài liệu để hoàn thiện hệ thống tri thức này.
      Ví dụ: Nếu có các trang về "Mạng neural hồi quy" và "Transformer" nhưng thiếu "Mạng neural nhân chập (CNN)" hoặc các kỹ thuật tiền xử lý dữ liệu.
      Đầu ra phải là một đối tượng JSON có định dạng:
      {
        "gaps": [
          {
            "gap": "Tên lỗ hổng kiến thức",
            "description": "Mô tả chi tiết lý do vì sao thiếu và gợi ý các tài liệu cần bổ sung.",
            "suggested_topics": ["Chủ đề gợi ý 1", "Chủ đề gợi ý 2"]
          }
        ]
      }
      Chỉ trả về JSON, không kèm lời giải thích nào ngoài khối JSON.
      `;

      try {
        const responseText = await callLLM(gapsSystem, "Hãy tìm các lỗ hổng nghiên cứu trong hệ thống tri thức này.", true);
        const parsed = parseLLMJSON(responseText);
        if (parsed && Array.isArray(parsed.gaps)) {
          gaps = parsed.gaps;
        }
      } catch (err) {
        console.error('Failed to get research gaps:', err);
      }
    }

    res.json({
      success: true,
      orphans: orphans.map(o => ({
        ...o,
        suggestions: orphanSuggestions[o.filename] || []
      })),
      gaps,
      contradictions
    });
  } catch (error) {
    console.error('Error running maintenance scan:', error);
    res.status(500).json({ error: 'Failed to run maintenance scan' });
  }
});

/**
 * GET /api/config
 * Get app configurations (LLM provider, models, and keys)
 */
app.get('/api/config', (req, res) => {
  res.json(appConfig);
});

/**
 * POST /api/config
 * Save configurations dynamically
 */
app.post('/api/config', async (req, res) => {
  try {
    const {
      LLM_PROVIDER,
      GEMINI_API_KEY,
      GEMINI_MODEL,
      OPENAI_API_KEY,
      OPENAI_MODEL,
      OPENAI_API_BASE
    } = req.body;

    await saveConfig({
      LLM_PROVIDER: LLM_PROVIDER || 'gemini',
      GEMINI_API_KEY: GEMINI_API_KEY || '',
      GEMINI_MODEL: GEMINI_MODEL || 'gemini-3.1-flash-lite-preview',
      OPENAI_API_KEY: OPENAI_API_KEY || '',
      OPENAI_MODEL: OPENAI_MODEL || 'DeepSeek-V4-Flash',
      OPENAI_API_BASE: OPENAI_API_BASE || 'https://api.deepseek.com'
    });

    res.json({ success: true, message: 'Cấu hình đã được lưu thành công!', config: appConfig });
  } catch (err) {
    console.error('Failed to save config:', err);
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

// Start the server
app.listen(PORT, async () => {
  console.log(`MinusWiki backend listening on port ${PORT}`);
  try {
    await ingestQueue.load();
    await initAllProjectWatchers();
    console.log('Ingest queue and project source watchers initialized.');

    // Start processing queue if anything is pending
    ingestQueue.processNext();
  } catch (err) {
    console.error('Failed to initialize ingest queue and watchers:', err);
  }
});
// Nodemon trigger comment 2
