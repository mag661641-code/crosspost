#!/usr/bin/env node
/**
 * max_automation.js — публикация в Макс через браузерную автоматизацию (Puppeteer).
 * Структура идентична dzen_automation.js — см. комментарии там для деталей паттерна.
 * Свой userDataDir/cookies — сессии Яндекс.Бизнеса/Дзена/Макса не пересекаются.
 *
 * ⚠️ ВАЖНО: DOM-селекторы Макса ниже — ЗАГЛУШКИ (TODO), см. dzen_automation.js.
 * Перед боевым использованием: `node max_automation.js --login`, изучить живой DOM,
 * заменить места, помеченные `// TODO selector`. До этого — не подключать к queue.js.
 *
 * Использование:
 *   node max_automation.js --login              — только авторизация (ручной вход по SMS-коду)
 *   node max_automation.js <post.json>           — опубликовать пост из файла (нужна сохранённая сессия)
 *
 * У Макса нет пароля — вход по телефону + SMS-код, автоматически ввести код нельзя.
 * Телефон (для справки в логах) — env MAX_PHONE. Сессия — только через --login.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PLATFORM = 'max';
const BASE_URL = 'https://max.ru'; // TODO: уточнить реальный домен веб-версии Макса

const USER_BASE = process.env.CLICK_PROJECT_DIR
  ? path.join(__dirname, 'users-data', process.env.CLICK_PROJECT_DIR)
  : __dirname;
if (!fs.existsSync(USER_BASE)) fs.mkdirSync(USER_BASE, { recursive: true });

const SESSION_DIR = path.join(USER_BASE, 'session');
const COOKIES_PATH = path.join(SESSION_DIR, 'max_cookies.json');
const USER_DATA_DIR = path.join(SESSION_DIR, 'max-browser-data');
const LOG_DIR = path.join(USER_BASE, 'logs');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logFile = path.join(LOG_DIR, `${PLATFORM}-${new Date().toISOString().slice(0, 10)}.log`);
const log = (level, msg) => {
  const line = `[${new Date().toLocaleTimeString('ru-RU')}] [${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
};
const info = (m) => log('INFO', m);
const warn = (m) => log('WARN', m);
const error = (m) => log('ERROR', m);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randDelay = () => sleep(1000 + Math.floor(Math.random() * 2000));

const MAX_ATTEMPTS = 5;
const PAUSES_MS = [0, 2000, 5000, 10000, 20000];
const withRetry = async (fn, label) => {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (PAUSES_MS[attempt] > 0) await sleep(PAUSES_MS[attempt]);
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS - 1) warn(`↻ Попытка ${attempt + 1}/${MAX_ATTEMPTS} (${label}) не удалась: ${e.message}. Повторяю...`);
    }
  }
  throw lastErr;
};

let browser = null;
let page = null;

const initBrowser = async (headless = false) => {
  info('🌐 Запуск браузера для Макса...');
  const launchOpts = {
    headless: headless ? 'new' : false,
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
    protocolTimeout: 45000,
  };
  browser = await puppeteer.launch(launchOpts);
  page = await browser.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(45000);
  await loadCookies();
  info('✅ Браузер запущен');
};

const saveCookies = async () => {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    info(`🍪 Куки Макса сохранены (${cookies.length} шт.)`);
  } catch (e) { warn(`Не удалось сохранить куки: ${e.message}`); }
};

const loadCookies = async () => {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        info(`🍪 Куки Макса загружены (${cookies.length} шт.)`);
      }
    }
  } catch (e) { warn(`Не удалось загрузить куки: ${e.message}`); }
};

const closeBrowser = async () => {
  if (browser) {
    if (page) await saveCookies();
    await browser.close();
    browser = null; page = null;
    info('✅ Браузер закрыт (сессия сохранена)');
  }
};

const takeScreenshot = async (name) => {
  try {
    const dir = path.join(LOG_DIR, 'screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, `${PLATFORM}-${name}-${Date.now()}.png`);
    await page.screenshot({ path: filepath, fullPage: true });
    info(`📸 Скриншот сохранён: ${filepath}`);
    return filepath;
  } catch (e) { warn(`Не удалось сделать скриншот: ${e.message}`); return null; }
};

const isLoggedIn = async () => {
  // TODO selector: проверить реальный признак авторизованной сессии Макса
  try {
    await page.goto(`${BASE_URL}/settings`, { waitUntil: 'domcontentloaded' });
    await randDelay();
    return !/login|auth/i.test(page.url());
  } catch { return false; }
};

// ВАЖНО: НЕ навигирует страницу (в отличие от isLoggedIn выше) — page.cookies() просто
// читает cookie jar браузера, не трогая открытую вкладку. Используется в цикле ожидания
// при ручном --login: если бы мы дёргали page.goto() каждые пару секунд, это сбрасывало бы
// форму ввода номера/SMS-кода прямо во время того, как человек её заполняет.
// Комбинируем два сигнала: URL больше не похож на страницу входа, И появились новые
// cookies по сравнению с состоянием до логина (сама по себе проверка URL может дать
// ложное срабатывание сразу после открытия страницы, до реального входа).
// Раньше здесь была слишком лёгкая проверка (URL + "хоть одна новая кука"), из-за которой
// окно могло закрыться почти сразу после открытия — сайт сам ставит фоновые куки
// (аналитика, счётчики) ещё до реального входа, и это ложно засчитывалось как «вошёл».
// Теперь, как и у ВК/ОК/Дзена:
//   1) не принимаем решение раньше 8 секунд с открытия страницы (даём сайту "успокоиться"),
//   2) требуем заметный прирост кук (+10, а не любое +1 — анонимный визит уже даёт немало),
//   3) требуем 3 успешных проверки ПОДРЯД (~6 секунд стабильного состояния),
// прежде чем поверить, что человек действительно вошёл и можно закрывать окно.
let stableLoginChecks = 0;

const isLoggedInPassive = async (baselineCookieCount, elapsedMs) => {
  try {
    if (elapsedMs < 8000) { stableLoginChecks = 0; return false; }

    const u = page.url();
    const urlLooksLoggedIn = u && !/login|auth|^about:blank$/i.test(u) && u.startsWith(BASE_URL);
    if (!urlLooksLoggedIn) { stableLoginChecks = 0; return false; }

    const cookies = await page.cookies();
    const cookiesGrew = cookies.length > baselineCookieCount + 10;

    stableLoginChecks = cookiesGrew ? stableLoginChecks + 1 : 0;
    return stableLoginChecks >= 3;
  } catch { stableLoginChecks = 0; return false; }
};

// Автоматический вход НЕВОЗМОЖЕН: у Макса нет пароля, вход только по телефону + SMS-код,
// а код может ввести только человек. Поэтому единственный способ авторизации —
// ручной режим `node max_automation.js --login` (см. CLI-блок ниже): открывается
// браузер, пользователь сам вводит номер и код из SMS, сессия сохраняется в cookies
// и переиспользуется дальше автоматически (пока не протухнет).

/**
 * publishToMax({phone}, {text, imagePaths})
 * Требует уже сохранённую сессию (через --login). Если сессии нет — возвращает
 * ошибку с понятной подсказкой, а не пытается логиниться сам.
 * Возвращает { ok, status, error } — при ошибке status = 'Ошибка публикации'.
 */
const publishToMax = async ({ phone }, { text, imagePaths }) => {
  try {
    await initBrowser(false);

    if (!(await isLoggedIn())) {
      throw new Error(
        `Нет сохранённой сессии Макса${phone ? ` (телефон ${phone})` : ''}. ` +
        `Войдите вручную: node max_automation.js --login (код из SMS вводится в открывшемся браузере).`
      );
    }

    await withRetry(async () => {
      // TODO selector/URL: страница создания поста в Максе
      await page.goto(`${BASE_URL}/post/new`, { waitUntil: 'domcontentloaded' });
      await randDelay();

      // TODO selector: поле ввода текста поста
      await page.waitForSelector('[data-testid="post-text"]', { timeout: 15000 });
      await page.click('[data-testid="post-text"]');
      await randDelay();
      await page.type('[data-testid="post-text"]', text || '', { delay: 10 });
      await randDelay();

      if (imagePaths && imagePaths.length > 0) {
        // TODO selector: input[type=file] загрузки изображения
        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.uploadFile(imagePaths[0]);
          await randDelay();
        }
      }

      await randDelay();
      // TODO selector: кнопка "Опубликовать"
      await page.click('[data-testid="publish-button"]');
      await randDelay();
    }, 'publish');

    await saveCookies();
    await closeBrowser();
    return { ok: true, status: 'Опубликовано' };
  } catch (e) {
    error(`❌ Ошибка публикации в Макс: ${e.message}`);
    try { await takeScreenshot('error'); } catch {}
    try { await closeBrowser(); } catch {}
    return { ok: false, status: 'Ошибка публикации', error: e.message };
  }
};

module.exports = { publishToMax };

// ── CLI ──
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--check-session')) {
      // Раньше здесь запускался headless-браузер для реальной проверки — но сайты
      // распознают headless-режим как подозрительный, из-за чего проверка могла ложно
      // решить "не авторизован", хотя сессия была рабочей (реальная публикация
      // не использует headless и работает нормально). Поэтому здесь только лёгкая
      // проверка: есть ли вообще сохранённые куки — без запуска браузера.
      try {
        const loggedIn = fs.existsSync(COOKIES_PATH) && JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8')).length > 0;
        console.log(JSON.stringify({ loggedIn }));
        process.exit(loggedIn ? 0 : 1);
      } catch (e) {
        console.log(JSON.stringify({ loggedIn: false, error: e.message }));
        process.exit(1);
      }
    }

    if (process.argv.includes('--login')) {
      console.log('\n' + '═'.repeat(50));
      console.log('  МАКС — режим ручной авторизации');
      console.log('═'.repeat(50));
      await initBrowser(false);
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      const baselineCookieCount = (await page.cookies()).length;
      info('Войдите в Макс в открытом окне. Ожидание до 5 минут...');
      const start = Date.now();
      let ok = false;
      while (Date.now() - start < 5 * 60 * 1000) {
        // Пассивная проверка — НЕ перезагружает страницу, чтобы не сбить ввод номера/SMS-кода.
        if (await isLoggedInPassive(baselineCookieCount, Date.now() - start)) { ok = true; break; }
        await sleep(2000);
      }
      if (ok) { await saveCookies(); info('✅ Сессия сохранена'); }
      else warn('⚠️ Время ожидания истекло — вход не выполнен.');
      await closeBrowser();
      process.exit(ok ? 0 : 1);
    }

    const postFile = process.argv.find(a => a.endsWith('.json'));
    if (!postFile) {
      console.error('Использование: node max_automation.js --login | node max_automation.js <post.json>');
      process.exit(1);
    }
    const post = JSON.parse(fs.readFileSync(postFile, 'utf-8'));
    const result = await publishToMax({ phone: process.env.MAX_PHONE }, post);
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  })();
}
