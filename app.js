#!/usr/bin/env node
/**
 * Crosspost v1.0.0 — отдельное приложение для постинга в Telegram/VK/OK/Дзен/Макс.
 * Полностью независимо от Click (автопостинг в Яндекс.Бизнес): свой процесс,
 * свой порт, своя кука сессии, свои данные на диске. Ничего не импортирует
 * из ../click и ничего оттуда не читает.
 *
 * node app.js → localhost:3900
 */

const http = require('http');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const projects = require('./projects.js');
const socialConfig = require('./social-config.js');
const telegramApi = require('./telegram.js');
const queueApi = require('./queue.js');
const { buildHTML } = require('./_ui.js');

const PORT = 3900;
const ROOT = __dirname;

// ── HELPERS: куки ────────────────────────────────────────
const parseCookies = (req) => {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  });
  return cookies;
};

const getCurrentProject = (req) => {
  const sid = parseCookies(req).crosspost_session;
  if (!sid) return null;
  return projects.validateSession(sid);
};

const setSessionCookie = (res, sessionId) => {
  res.setHeader('Set-Cookie', `crosspost_session=${sessionId}; Path=/; Max-Age=${7 * 24 * 60 * 60}; HttpOnly; SameSite=Lax`);
};
const clearSessionCookie = (res) => {
  res.setHeader('Set-Cookie', 'crosspost_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
};

// ── FS HELPERS ──────────────────────────────────────────
const ensureDir = (p) => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
const safeFilename = (name) => name.replace(/[^\w\-\.Ѐ-ӿ]/g, '_');

// Какая площадка сейчас занята браузером (окно входа ИЛИ фоновая проверка сессии) —
// у каждой площадки только один профиль браузера на диске, и Chrome не даёт открыть
// второй процесс поверх того же профиля. Поэтому и "Войти в аккаунт", и проверка
// статуса используют один и тот же замок — не могут работать одновременно.
const loginLocks = new Set();

// Площадки со входом кнопкой (--login/--check-session браузерных модулей).
const loginScriptByPlatform = {
  vk: 'vk_automation.js',
  ok: 'ok_automation.js',
  dzen: 'dzen_automation.js',
  max: 'max_automation.js',
};

// users-data/{projectId}/ — своя папка, не пересекается с click/users-data
const getProjectBase = (projectId) => {
  if (!projectId) return ROOT;
  const dir = path.join(ROOT, 'users-data', projects.projectDir(projectId));
  ensureDir(dir);
  return dir;
};

// ── HTTP HELPERS ────────────────────────────────────────
const send = (res, code, type, body) => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
  res.end(body);
};
const sendJSON = (res, obj, code = 200) => send(res, code, 'application/json', JSON.stringify(obj));
const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
  });
  req.on('error', reject);
});

// ── ROUTES ──────────────────────────────────────────────
const handleRoute = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    return send(res, 200, 'text/html', buildHTML());
  }

  // ── PROJECTS (публичные) ──
  if (p === '/api/projects/list' && req.method === 'GET') {
    return sendJSON(res, { projects: projects.listProjectsPublic() });
  }
  if (p === '/api/projects/login' && req.method === 'POST') {
    const body = await readBody(req);
    const result = projects.loginProject(body.projectId, body.password);
    if (result.error) return sendJSON(res, { error: result.error }, 401);
    setSessionCookie(res, result.sessionId);
    return sendJSON(res, { ok: true, project: result.project });
  }
  if (p === '/api/auth/state' && req.method === 'GET') {
    const projectId = getCurrentProject(req);
    return sendJSON(res, { currentProjectId: projectId, project: projectId ? projects.getProjectPublic(projectId) : null });
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    const sid = parseCookies(req).crosspost_session;
    if (sid) projects.destroySession(sid);
    clearSessionCookie(res);
    return sendJSON(res, { ok: true });
  }

  // ── AUTH GUARD ──
  const currentProjectId = getCurrentProject(req);
  const isPublicEndpoint = p === '/api/status';
  if (p.startsWith('/api/') && !isPublicEndpoint && !currentProjectId) {
    return sendJSON(res, { error: 'Не авторизован', needLogin: true }, 401);
  }

  if (p === '/api/status') {
    return sendJSON(res, { ok: true, projectId: currentProjectId });
  }

  // ── СОЦСЕТИ (users-data/{projectId}/social-config.json) ──
  if (p === '/api/social/config' && req.method === 'GET') {
    try {
      return sendJSON(res, { config: socialConfig.loadSocialConfig(getProjectBase(currentProjectId)) });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (p === '/api/social/config' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const config = socialConfig.saveSocialConfig(getProjectBase(currentProjectId), body.config || {});
      return sendJSON(res, { ok: true, config });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (p === '/api/social/test' && req.method === 'POST') {
    try {
      const { platform } = await readBody(req);
      const config = socialConfig.loadSocialConfig(getProjectBase(currentProjectId));
      const cfg = config[platform];
      if (!cfg) return sendJSON(res, { error: 'unknown platform' }, 400);

      // У ВК/ОК/Дзен/Макс логин/пароль/телефон — лишь запасной способ повторного входа:
      // достаточно один раз войти вручную (`node <платформа>_automation.js --login`,
      // для ОК это можно сделать и через кнопку «Войти через ВК»), дальше сессия
      // хранится в cookies и эти поля не обязательны. Строго required — только Telegram (API).
      const requiredByPlatform = { telegram: ['botToken', 'chatId'] };
      const required = requiredByPlatform[platform];
      if (required) {
        const missing = required.filter(k => !cfg[k]);
        if (missing.length > 0) return sendJSON(res, { ok: false, error: `Не заполнено: ${missing.join(', ')}` });
      }
      if (!['telegram', 'vk', 'ok', 'dzen', 'max'].includes(platform)) return sendJSON(res, { error: 'unknown platform' }, 400);

      const checkers = { telegram: telegramApi.checkConnection };
      const checker = checkers[platform];
      if (checker) {
        try { await checker(cfg); return sendJSON(res, { ok: true }); }
        catch (e) { return sendJSON(res, { ok: false, error: e.message }); }
      }
      return sendJSON(res, { ok: true, note: 'Поля заполнены. Настоящий вход проверится, когда вы нажмёте «Войти в аккаунт» или когда пойдёт публикация.' });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }

  // ── ВХОД В АККАУНТ ЧЕРЕЗ КНОПКУ (без терминала) ──
  // Открывает то же самое окно браузера, что и ручной `node <платформа>_automation.js --login`,
  // просто по нажатию кнопки в интерфейсе. Пользователь сам вводит SMS-код/логин-пароль
  // в открывшемся окне — сервер лишь запускает процесс и ждёт его завершения (до 5 минут,
  // как и сам --login), чтобы вернуть в UI результат "вошли / не вошли".
  if (p === '/api/social/status' && req.method === 'GET') {
    try {
      const platform = url.searchParams.get('platform');
      const scriptName = loginScriptByPlatform[platform];
      if (!scriptName) return sendJSON(res, { error: 'unknown platform' }, 400);

      const lockKey = `${currentProjectId}:${platform}:login`;
      // Профиль браузера этой площадки занят — либо открытым окном входа, либо другой
      // проверкой сессии. Не запускаем второй Chrome поверх него (иначе именно так
      // "Войти в аккаунт" может не открыться — Chrome откажется стартовать второй
      // процесс с тем же профилем). Просто говорим клиенту "подождите".
      if (loginLocks.has(lockKey)) {
        return sendJSON(res, { pending: true });
      }
      loginLocks.add(lockKey);

      const env = { ...process.env, CLICK_PROJECT_DIR: projects.projectDir(currentProjectId) };
      const child = spawn('node', [scriptName, '--check-session'], { cwd: ROOT, env, windowsHide: true });
      let out = '';
      let done = false;
      child.stdout.on('data', d => { out += d.toString(); });
      // Проверка сессии должна быть быстрой (headless, без ввода человека). Если она
      // зависла (например, Chrome не смог сразу запуститься из-за нехватки ресурсов) —
      // принудительно останавливаем через минуту, чтобы блокировка не осталась навсегда
      // и не мешала следующим попыткам "Войти в аккаунт".
      const hardTimeout = setTimeout(() => { try { child.kill(); } catch {} }, 60 * 1000);
      child.on('close', () => {
        if (done) return;
        done = true;
        clearTimeout(hardTimeout);
        loginLocks.delete(lockKey);
        const lastLine = out.trim().split('\n').pop() || '{}';
        try { return sendJSON(res, JSON.parse(lastLine)); }
        catch { return sendJSON(res, { loggedIn: false }); }
      });
      return;
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (p === '/api/social/login' && req.method === 'POST') {
    try {
      const { platform } = await readBody(req);
      const scriptName = loginScriptByPlatform[platform];
      if (!scriptName) return sendJSON(res, { error: 'Для этой площадки кнопка входа не нужна' }, 400);

      const lockKey = `${currentProjectId}:${platform}:login`;
      if (loginLocks.has(lockKey)) {
        return sendJSON(res, { error: 'Окно входа для этой площадки уже открыто — закончите там вход' }, 409);
      }
      loginLocks.add(lockKey);

      const env = { ...process.env, CLICK_PROJECT_DIR: projects.projectDir(currentProjectId) };
      const child = spawn('node', [scriptName, '--login'], { cwd: ROOT, env, windowsHide: false });
      let out = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { out += d.toString(); });
      // Сам --login ждёт человека не дольше 5 минут и закрывается сам. Но если браузер
      // вообще не смог запуститься (например, не хватило ресурсов) — этот таймер никогда
      // не сработает и процесс зависнет, а с ним и блокировка. Подстраховываемся: жёстко
      // останавливаем через 7 минут в любом случае, чтобы не залипать навсегда.
      const hardTimeout = setTimeout(() => { try { child.kill(); } catch {} }, 7 * 60 * 1000);
      child.on('close', () => {
        clearTimeout(hardTimeout);
        loginLocks.delete(lockKey);
      });

      return sendJSON(res, { ok: true, note: 'Открылось окно браузера — войдите там (телефон+SMS или логин/пароль). Окно закроется само после входа.' });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }

  // ── ОЧЕРЕДЬ / ОТЛОЖЕННЫЙ ПОСТИНГ ──
  if (p === '/api/queue' && req.method === 'GET') {
    try { return sendJSON(res, { items: queueApi.loadQueue(getProjectBase(currentProjectId)) }); }
    catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (p === '/api/queue/add' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const item = queueApi.addToQueue(getProjectBase(currentProjectId), body);
      return sendJSON(res, { ok: true, item });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (p === '/api/queue/cancel' && req.method === 'POST') {
    try {
      const { id } = await readBody(req);
      const item = queueApi.cancelQueueItem(getProjectBase(currentProjectId), id);
      if (!item) return sendJSON(res, { error: 'not found' }, 404);
      return sendJSON(res, { ok: true, item });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }
  if (p === '/api/queue/publish-now' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const projectDirName = currentProjectId ? projects.projectDir(currentProjectId) : null;
      const results = await queueApi.publishToAllPlatforms(currentProjectId, projectDirName, getProjectBase(currentProjectId), body);
      return sendJSON(res, { ok: true, results });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }

  // ── ЛОКАЛЬНЫЕ КАРТИНКИ ──
  if (p === '/api/upload-image' && req.method === 'POST') {
    try {
      const uploadsDir = path.join(getProjectBase(currentProjectId), 'uploads');
      ensureDir(uploadsDir);

      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      if (!boundaryMatch) return sendJSON(res, { error: 'Не указан boundary в multipart' }, 400);
      const boundary = '--' + (boundaryMatch[1] || boundaryMatch[2]).trim();

      const chunks = [];
      let totalSize = 0;
      const MAX_SIZE = 20 * 1024 * 1024;
      for await (const chunk of req) {
        chunks.push(chunk);
        totalSize += chunk.length;
        if (totalSize > MAX_SIZE) return sendJSON(res, { error: 'Файл больше 20 МБ' }, 413);
      }
      const body = Buffer.concat(chunks);

      const boundaryBuf = Buffer.from(boundary);
      const startIdx = body.indexOf(boundaryBuf);
      if (startIdx === -1) return sendJSON(res, { error: 'Не найден boundary в теле' }, 400);

      const partStart = startIdx + boundaryBuf.length + 2;
      const headerEnd = body.indexOf('\r\n\r\n', partStart);
      if (headerEnd === -1) return sendJSON(res, { error: 'Не найден разделитель заголовков части' }, 400);

      const headers = body.slice(partStart, headerEnd).toString('utf-8');
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      if (!filenameMatch) return sendJSON(res, { error: 'Не указано имя файла' }, 400);
      const originalName = filenameMatch[1];

      const dataStart = headerEnd + 4;
      const dataEnd = body.indexOf(boundaryBuf, dataStart);
      if (dataEnd === -1) return sendJSON(res, { error: 'Не найден конец данных файла' }, 400);
      const fileData = body.slice(dataStart, dataEnd - 2);

      const ext = path.extname(originalName).toLowerCase().slice(0, 5) || '.jpg';
      const validExt = /\.(jpg|jpeg|png|gif|webp)$/i.test(ext) ? ext : '.jpg';
      const safeName = safeFilename(path.basename(originalName, path.extname(originalName)));
      const fileName = `${Date.now()}-${safeName}${validExt}`;
      const filePath = path.join(uploadsDir, fileName);

      fs.writeFileSync(filePath, fileData);

      return sendJSON(res, {
        ok: true, fileName, path: filePath,
        url: `/api/uploads/${encodeURIComponent(fileName)}`,
        size: fileData.length, originalName,
      });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }

  if (p.startsWith('/api/uploads/') && req.method === 'GET') {
    try {
      const fileName = decodeURIComponent(p.slice('/api/uploads/'.length));
      if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.startsWith('.')) {
        return send(res, 400, 'text/plain', 'Bad filename');
      }
      const filePath = path.join(getProjectBase(currentProjectId), 'uploads', fileName);
      if (!fs.existsSync(filePath)) return send(res, 404, 'text/plain', 'Not found');
      const ext = path.extname(fileName).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
      res.end(data);
      return;
    } catch (e) { return send(res, 500, 'text/plain', 'Error: ' + e.message); }
  }

  if (p.startsWith('/api/uploads/') && req.method === 'DELETE') {
    try {
      const fileName = decodeURIComponent(p.slice('/api/uploads/'.length));
      if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.startsWith('.')) {
        return sendJSON(res, { error: 'Bad filename' }, 400);
      }
      const filePath = path.join(getProjectBase(currentProjectId), 'uploads', fileName);
      if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch {} }
      return sendJSON(res, { ok: true });
    } catch (e) { return sendJSON(res, { error: e.message }, 500); }
  }

  send(res, 404, 'text/plain', 'Not Found');
};

const server = http.createServer(async (req, res) => {
  try { await handleRoute(req, res); }
  catch (e) {
    console.error('ROUTE ERROR:', e);
    try { sendJSON(res, { error: e.message }, 500); } catch {}
  }
});

// Планировщик очереди: раз в минуту проверяем все проекты на "созревшие" посты.
const listProjectsForQueue = () => projects.listProjectsPublic().map(p => ({
  projectId: p.id,
  projectDirName: projects.projectDir(p.id),
  projectBaseDir: getProjectBase(p.id),
}));
cron.schedule('* * * * *', () => {
  queueApi.processDuePosts(listProjectsForQueue).catch(e => console.error('[queue] processDuePosts error:', e));
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  +-------------------------------------------+');
  console.log('  |  Crosspost - server started                |');
  console.log('  +-------------------------------------------+');
  console.log(`  |  ${url.padEnd(41)}|`);
  console.log('  +-------------------------------------------+');
  console.log('');
  console.log('  Ctrl+C - stop server');
  console.log('');

  const openCmd = process.platform === 'win32' ? `start "" "${url}"`
                : process.platform === 'darwin' ? `open "${url}"`
                : `xdg-open "${url}"`;
  exec(openCmd);
});

process.on('SIGINT', () => {
  console.log('\n  Сервер остановлен\n');
  process.exit(0);
});
