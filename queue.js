#!/usr/bin/env node
/**
 * queue.js — отложенный постинг: очередь на проект + диспетчер публикации.
 * Файл users-data/{projectId}/queue.json, по образцу остальных файловых хранилищ.
 *
 * Формат элемента очереди:
 * {
 *   "id": "...",
 *   "text": "...",
 *   "imagePaths": ["..."],
 *   "platforms": ["telegram", "vk"],
 *   "dzenPubType": "article" | "post",
 *   "scheduledTime": "2026-07-01T15:00:00Z",
 *   "status": "pending" | "published" | "failed" | "cancelled",
 *   "results": { "telegram": {ok:true}, ... },
 *   "createdAt": "..."
 * }
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const telegramApi = require('./telegram.js');
const socialConfig = require('./social-config.js');
const { adaptTextForPlatform } = require('./text-adapt.js');

const getQueuePath = (projectBaseDir) => path.join(projectBaseDir, 'queue.json');

const loadQueue = (projectBaseDir) => {
  try {
    const fp = getQueuePath(projectBaseDir);
    if (!fs.existsSync(fp)) return [];
    const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
};

const saveQueue = (projectBaseDir, arr) => {
  fs.writeFileSync(getQueuePath(projectBaseDir), JSON.stringify(arr, null, 2), 'utf-8');
};

const genId = () => 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

const addToQueue = (projectBaseDir, { text, imagePaths, platforms, scheduledTime, dzenPubType }) => {
  const queue = loadQueue(projectBaseDir);
  const item = {
    id: genId(),
    text: text || '',
    imagePaths: Array.isArray(imagePaths) ? imagePaths : [],
    platforms: Array.isArray(platforms) ? platforms : [],
    dzenPubType: dzenPubType || 'post',
    scheduledTime: scheduledTime || new Date().toISOString(),
    status: 'pending',
    results: {},
    createdAt: new Date().toISOString(),
  };
  queue.push(item);
  saveQueue(projectBaseDir, queue);
  return item;
};

const cancelQueueItem = (projectBaseDir, id) => {
  const queue = loadQueue(projectBaseDir);
  const item = queue.find(q => q.id === id);
  if (!item) return null;
  if (item.status === 'pending') item.status = 'cancelled';
  saveQueue(projectBaseDir, queue);
  return item;
};

// Простая блокировка «один Puppeteer-процесс на площадку за раз» —
// чтобы cron не запускал второй node dzen_automation.js, пока первый ещё работает.
const browserPlatformLocks = new Set();

// Запускает браузерный модуль (dzen/max) как дочерний процесс, аналогично /api/run в app.js.
const spawnBrowserPublish = (scriptName, projectDirName, post, credentials) => new Promise((resolve) => {
  const tmpFile = path.join(os.tmpdir(), `click-${scriptName}-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({
    text: post.text,
    imagePaths: post.imagePaths,
    pubType: post.dzenPubType,
    groupUrl: credentials.groupUrl,
    // Для ВК: если задано — публикация ставится в НАТИВНУЮ очередь отложенных постов
    // самого ВК (см. scheduleVkPost в vk_automation.js), а не ждёт нашего cron.
    // Остальные автоматизации это поле пока игнорируют.
    scheduledTime: post.scheduledTime,
  }), 'utf-8');

  // ВК/ОК/Макс логинятся только вручную кнопкой «Войти в аккаунт» (телефон+SMS-код
  // вводятся прямо в открывшемся окне и нигде не хранятся) — публикация требует
  // заранее сохранённой сессии, credentials для них тут не нужны.
  const env = { ...process.env, CLICK_PROJECT_DIR: projectDirName || '' };
  if (scriptName === 'dzen_automation.js') {
    env.DZEN_LOGIN = credentials.login || '';
    env.DZEN_PASSWORD = credentials.password || '';
  }

  const child = spawn('node', [scriptName, tmpFile], { cwd: __dirname, env, windowsHide: true });
  let out = '';
  child.stdout.on('data', d => { out += d.toString(); });
  child.stderr.on('data', d => { out += d.toString(); });
  child.on('close', (code) => {
    try { fs.unlinkSync(tmpFile); } catch {}
    const lastLine = out.trim().split('\n').pop() || '{}';
    try {
      const result = JSON.parse(lastLine);
      resolve(result);
    } catch {
      resolve({ ok: code === 0, status: code === 0 ? 'Опубликовано' : 'Ошибка публикации' });
    }
  });
});

// Авто-адаптация текста под площадку (анкорные ссылки [текст](url) — см. text-adapt.js).
// 'telegram' — реальные HTML-анкоры; 'vk' — экспериментальная разметка ссылок VK;
// 'plain' — везде остальном (ссылка остаётся видимым текстом, анкоров платформа не поддерживает).
const withAdaptedText = (post, mode) => ({ ...post, text: adaptTextForPlatform(post.text, mode) });

// Публикует пост на все выбранные платформы (кроме yandex — тот идёт через отдельный /api/run flow).
const publishToAllPlatforms = async (projectId, projectDirName, projectBaseDir, post) => {
  const config = socialConfig.loadSocialConfig(projectBaseDir);
  const results = {};

  for (const platform of post.platforms) {
    if (platform === 'yandex') continue; // Яндекс публикуется через отдельный существующий флоу, не через очередь

    if (platform === 'telegram') {
      results.telegram = await telegramApi.publishToTelegram(config.telegram, withAdaptedText(post, 'telegram'));
    } else if (platform === 'vk') {
      // ВК публикуется только браузерной автоматизацией (вход по телефону + SMS-код).
      const c = config.vk;
      if (!c.phone) {
        results.vk = { ok: false, error: 'Не задан телефон для ВК' };
      } else {
        const lockKey = `${projectId}:vk`;
        if (browserPlatformLocks.has(lockKey)) {
          results.vk = { ok: false, error: 'ВК уже публикует другой пост, пропущено — попробуется в следующем цикле' };
        } else {
          browserPlatformLocks.add(lockKey);
          try {
            results.vk = await spawnBrowserPublish('vk_automation.js', projectDirName, withAdaptedText(post, 'plain'), c);
          } finally { browserPlatformLocks.delete(lockKey); }
        }
      }
    } else if (platform === 'ok') {
      // ОК публикуется только браузерной автоматизацией — вход такой же, как у ВК:
      // по телефону + SMS-код (через кнопку «Войти через ВК»), заранее сохранённой
      // сессией (node ok_automation.js --login). У ОК есть родной тулбар «Ссылка»
      // в редакторе, поэтому туда передаём СЫРОЙ текст с разметкой [текст](url) —
      // ok_automation.js сам вставит настоящий анкор через диалог
      // (см. typeTextWithAnchors в ok_automation.js).
      const c = config.ok;
      const lockKey = `${projectId}:ok`;
      if (browserPlatformLocks.has(lockKey)) {
        results.ok = { ok: false, error: 'ОК уже публикует другой пост, пропущено — попробуется в следующем цикле' };
      } else {
        browserPlatformLocks.add(lockKey);
        try {
          results.ok = await spawnBrowserPublish('ok_automation.js', projectDirName, post, c);
        } finally { browserPlatformLocks.delete(lockKey); }
      }
    } else if (platform === 'dzen') {
      const lockKey = `${projectId}:dzen`;
      if (browserPlatformLocks.has(lockKey)) {
        results.dzen = { ok: false, error: 'Дзен уже публикует другой пост, пропущено — попробуется в следующем цикле' };
        continue;
      }
      browserPlatformLocks.add(lockKey);
      try {
        results.dzen = await spawnBrowserPublish('dzen_automation.js', projectDirName, withAdaptedText(post, 'plain'), config.dzen);
      } finally { browserPlatformLocks.delete(lockKey); }
    } else if (platform === 'max') {
      const lockKey = `${projectId}:max`;
      if (browserPlatformLocks.has(lockKey)) {
        results.max = { ok: false, error: 'Макс уже публикует другой пост, пропущено — попробуется в следующем цикле' };
        continue;
      }
      browserPlatformLocks.add(lockKey);
      try {
        results.max = await spawnBrowserPublish('max_automation.js', projectDirName, withAdaptedText(post, 'plain'), config.max);
      } finally { browserPlatformLocks.delete(lockKey); }
    }
  }

  return results;
};

/**
 * processDuePosts(listProjects) — вызывается раз в минуту из app.js (node-cron).
 * listProjects() -> [{ projectId, projectDirName, projectBaseDir }] — все известные проекты.
 */
const processDuePosts = async (listProjects) => {
  const now = Date.now();
  for (const { projectId, projectDirName, projectBaseDir } of listProjects()) {
    let queue;
    try { queue = loadQueue(projectBaseDir); } catch { continue; }
    let changed = false;

    for (const item of queue) {
      if (item.status !== 'pending') continue;
      const due = new Date(item.scheduledTime).getTime();
      if (isNaN(due) || due > now) continue;

      changed = true;
      try {
        const results = await publishToAllPlatforms(projectId, projectDirName, projectBaseDir, item);
        item.results = results;
        const anyFailed = Object.values(results).some(r => r && r.ok === false);
        item.status = anyFailed ? 'failed' : 'published';
      } catch (e) {
        item.status = 'failed';
        item.results = { error: e.message };
      }
    }

    if (changed) saveQueue(projectBaseDir, queue);
  }
};

module.exports = {
  loadQueue, saveQueue, addToQueue, cancelQueueItem,
  publishToAllPlatforms, processDuePosts,
};
