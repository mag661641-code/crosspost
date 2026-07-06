#!/usr/bin/env node
/**
 * dzen_automation.js — публикация в Дзен через браузерную автоматизацию (Puppeteer).
 * Зеркалит паттерн publish.js (userDataDir, куки, retry, screenshot-on-error),
 * но использует СВОЙ userDataDir/cookies — сессии Яндекс.Бизнеса и Дзена не пересекаются.
 *
 * Селекторы редактора СТАТЬИ (заголовок/текст/кнопка фото/кнопка "+") подтверждены
 * вживую. Остаётся TODO: кнопка "Опубликовать" (ищется по тексту, не проверено на
 * реальной публикации) и режим "обычный пост" (pubType='post' — известен только
 * пункт меню для статьи, для поста используется тот же режим с warn в лог).
 *
 * Использование:
 *   node dzen_automation.js --login              — только авторизация (ручной вход)
 *   node dzen_automation.js <post.json>           — опубликовать пост из файла
 *
 * Формат post.json: { text, imagePaths: [...], pubType: 'article'|'post' }
 * text: первая строка используется как заголовок статьи, остальное — как тело.
 * Логин/пароль/groupUrl берутся из env DZEN_LOGIN/DZEN_PASSWORD (queue.js прокидывает
 * их из social-config.json так же, как CLICK_PROJECT_DIR прокидывается в publish.js).
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PLATFORM = 'dzen';
const BASE_URL = 'https://dzen.ru';

const USER_BASE = process.env.CLICK_PROJECT_DIR
  ? path.join(__dirname, 'users-data', process.env.CLICK_PROJECT_DIR)
  : __dirname;
if (!fs.existsSync(USER_BASE)) fs.mkdirSync(USER_BASE, { recursive: true });

const SESSION_DIR = path.join(USER_BASE, 'session');
const COOKIES_PATH = path.join(SESSION_DIR, 'dzen_cookies.json');
const USER_DATA_DIR = path.join(SESSION_DIR, 'dzen-browser-data');
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
// Случайная задержка между кликами — требование: 1-3 секунды.
const randDelay = () => sleep(1000 + Math.floor(Math.random() * 2000));

// Retry-константы — те же, что в publish.js (186-212), скопированы (не импортированы,
// чтобы не трогать publish.js).
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
  info('🌐 Запуск браузера для Дзена...');
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
    info(`🍪 Куки Дзена сохранены (${cookies.length} шт.)`);
  } catch (e) { warn(`Не удалось сохранить куки: ${e.message}`); }
};

const loadCookies = async () => {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        info(`🍪 Куки Дзена загружены (${cookies.length} шт.)`);
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
  // TODO selector: проверить реальный признак авторизованной сессии Дзена
  // (например, наличие ссылки на личный кабинет/аватар в шапке).
  try {
    await page.goto(`${BASE_URL}/profile/editor`, { waitUntil: 'domcontentloaded' });
    await randDelay();
    return !/passport|login/i.test(page.url());
  } catch { return false; }
};

// ВАЖНО: НЕ навигирует страницу (в отличие от isLoggedIn выше) — page.cookies() просто
// читает cookie jar браузера, не трогая открытую вкладку. Используется в цикле ожидания
// при ручном --login: если бы мы дёргали page.goto() каждые пару секунд, это сбрасывало бы
// форму ввода логина/пароля/2FA прямо во время того, как человек её заполняет.
// Комбинируем два сигнала: URL больше не похож на страницу входа, И появились новые
// cookies по сравнению с состоянием до логина (сама по себе проверка URL может дать
// ложное срабатывание сразу после открытия страницы, до реального входа).
// Раньше здесь была слишком лёгкая проверка (URL + "хоть одна новая кука"), из-за которой
// окно закрывалось почти сразу после открытия — dzen.ru/паспорт Яндекса сами ставят
// фоновые куки (аналитика, счётчики) ещё до реального входа, и это ложно засчитывалось
// как «вошёл». Теперь, как и у ВК/ОК:
//   1) не принимаем решение раньше 8 секунд с открытия страницы (даём сайту "успокоиться"),
//   2) требуем заметный прирост кук (+10, а не любое +1 — анонимный визит уже даёт немало),
//   3) требуем 3 успешных проверки ПОДРЯД (~6 секунд стабильного состояния),
// прежде чем поверить, что человек действительно вошёл и можно закрывать окно.
let stableLoginChecks = 0;

const isLoggedInPassive = async (baselineCookieCount, elapsedMs) => {
  try {
    if (elapsedMs < 8000) { stableLoginChecks = 0; return false; }

    const u = page.url();
    const urlLooksLoggedIn = u && !/passport|login|^about:blank$/i.test(u) && u.startsWith(BASE_URL);
    if (!urlLooksLoggedIn) { stableLoginChecks = 0; return false; }

    const cookies = await page.cookies();
    const cookiesGrew = cookies.length > baselineCookieCount + 10;

    stableLoginChecks = cookiesGrew ? stableLoginChecks + 1 : 0;
    return stableLoginChecks >= 3;
  } catch { stableLoginChecks = 0; return false; }
};

const login = async (loginValue, password) => {
  info('🔐 Авторизация в Дзене...');
  await page.goto(`${BASE_URL}`, { waitUntil: 'domcontentloaded' });
  await randDelay();
  if (await isLoggedIn()) { info('Уже авторизован (сессия из cookies)'); return; }

  // TODO selector: кнопка входа на главной Дзена
  await page.click('a[data-testid="login-button"]').catch(() => {});
  await randDelay();
  // TODO selector: поле логина на паспорте (аналогично publish.js login-флоу)
  await page.waitForSelector('input[name="login"]', { timeout: 15000 });
  await page.type('input[name="login"]', loginValue, { delay: 50 });
  await randDelay();
  // TODO selector: кнопка "Войти" после логина
  await page.click('button[type="submit"]').catch(() => {});
  await randDelay();
  // TODO selector: поле пароля
  await page.waitForSelector('input[name="passwd"]', { timeout: 15000 });
  await page.type('input[name="passwd"]', password, { delay: 50 });
  await randDelay();
  await page.click('button[type="submit"]').catch(() => {});
  await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await saveCookies();
  info('✅ Авторизация выполнена');
};

// Кликает по кнопке/элементу, находя его по иконке <use xlink:href="#...">.
// Дзен использует SVG-спрайты для иконок кнопок без текста (например кнопка "+" —
// иконка "add_bar" — подтверждено вживую).
const clickByIconHref = async (hrefFragment, timeout = 10000) => {
  const handle = await page.waitForFunction((frag) => {
    const use = Array.from(document.querySelectorAll('svg use')).find(el => {
      const href = el.getAttribute('xlink:href') || el.getAttribute('href') || '';
      return href.includes(frag);
    });
    if (!use) return null;
    return use.closest('button, [role="button"], label, a');
  }, { timeout }, hrefFragment);
  const el = handle.asElement();
  if (!el) throw new Error(`Элемент с иконкой "${hrefFragment}" не найден`);
  await el.click();
  return el;
};

// Кликает по кнопке, находя её по видимому тексту (для кнопок без стабильного data-testid).
const clickButtonByText = async (textFragment, timeout = 10000) => {
  const handle = await page.waitForFunction((fragment) => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    return candidates.find(el => (el.textContent || '').trim().startsWith(fragment)) || null;
  }, { timeout }, textFragment);
  const el = handle.asElement();
  if (!el) throw new Error(`Кнопка "${textFragment}" не найдена`);
  await el.click();
  return el;
};

// Селекторы редактора статьи Дзена — подтверждены вживую (профиль → редактор канала):
//   Заголовок: [class*="titleInput"] [contenteditable="true"] (placeholder "Заголовок")
//   Текст:     [class*="zenEditor"] [contenteditable="true"] (placeholder "Текст")
//   Фото:      button[data-tip="Вставить изображение"] в боковой панели инструментов
// TODO: кнопка "Опубликовать" ищется по тексту (не подтверждено вживую — не видели
// финальный экран публикации). TODO: пункт меню для обычного поста (не статьи) —
// известен только текст для статьи ("Написать статью"); для pubType='post' пока
// используется тот же режим статьи с предупреждением в лог.
const TITLE_SELECTOR = '[class*="titleInput"] [contenteditable="true"]';
const BODY_SELECTOR = '[class*="zenEditor"] [contenteditable="true"]';

/**
 * publishToDzen({login, password, groupUrl}, {text, imagePaths, pubType})
 * groupUrl — ссылка на редактор канала, например https://dzen.ru/profile/editor/inmetprom
 * pubType: 'article' | 'post' — сейчас поддержана только 'article' (см. TODO выше).
 * Возвращает { ok, status, error } — при ошибке status = 'Ошибка публикации'.
 */
const publishToDzen = async ({ login: loginValue, password, groupUrl }, { text, imagePaths, pubType }) => {
  try {
    await initBrowser(false);

    if (!(await isLoggedIn())) {
      if (!loginValue || !password) throw new Error('Нет сохранённой сессии и не заданы логин/пароль');
      await withRetry(() => login(loginValue, password), 'login');
    }

    await withRetry(async () => {
      if (!groupUrl) throw new Error('Не указана ссылка на редактор канала (groupUrl)');
      info(`Шаг 0: открываю ${groupUrl}`);
      await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
      await randDelay();

      // 1. Кнопка "+" — открывает меню создания публикации (иконка add_bar, подтверждено).
      info('Шаг 1: клик "+"');
      await clickByIconHref('add_bar');
      await randDelay();

      // 2. Пункт меню "Написать статью" (aria-label подтверждён вживую).
      if (pubType && pubType !== 'article') {
        warn(`pubType="${pubType}" пока не поддержан для Дзена (известен только пункт меню для статьи) — использую режим статьи`);
      }
      info('Шаг 2: клик "Написать статью"');
      await page.waitForSelector('[aria-label="Написать статью"]', { timeout: 10000 });
      await page.click('[aria-label="Написать статью"]');
      await randDelay();

      // 3. Открылся редактор статьи. Заголовок — первая строка текста, тело — остальное
      // (у статьи Дзена обязательны оба поля, отдельного поля "заголовок" в исходном
      // посте нет — выделяем его из текста).
      const lines = (text || '').split('\n');
      const title = (lines[0] || '').trim() || 'Без заголовка';
      const body = lines.slice(1).join('\n').trim();

      info(`Шаг 3: ввожу заголовок ("${title.slice(0, 40)}")`);
      await page.waitForSelector(TITLE_SELECTOR, { timeout: 15000 });
      await page.click(TITLE_SELECTOR);
      await randDelay();
      await page.type(TITLE_SELECTOR, title, { delay: 10 });
      await randDelay();

      if (body) {
        info(`Шаг 4: ввожу текст (${body.length} символов)`);
        await page.click(BODY_SELECTOR);
        await randDelay();
        await page.type(BODY_SELECTOR, body, { delay: 10 });
        await randDelay();
      } else {
        info('Шаг 4: тела статьи нет (весь текст ушёл в заголовок)');
      }

      // 5. Фото — через кнопку боковой панели инструментов (data-tip подтверждён).
      if (imagePaths && imagePaths.length > 0) {
        info(`Шаг 5: загружаю ${imagePaths.length} фото`);
        await page.waitForSelector('button[data-tip="Вставить изображение"]', { timeout: 10000 });
        await page.click('button[data-tip="Вставить изображение"]');
        await randDelay();
        const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000 });
        await fileInput.uploadFile(imagePaths[0]);
        await randDelay();
      } else {
        info('Шаг 5: фото нет, пропускаю');
      }

      // 6. Кнопка "Опубликовать" — TODO: селектор не подтверждён вживую (не видели
      // финальный экран), ищем по тексту как запасной вариант.
      info('Шаг 6: клик "Опубликовать"');
      await clickButtonByText('Опубликовать');
      await randDelay();
    }, 'publish');

    await saveCookies();
    await closeBrowser();
    return { ok: true, status: 'Опубликовано' };
  } catch (e) {
    error(`❌ Ошибка публикации в Дзен: ${e.message}`);
    try { await takeScreenshot('error'); } catch {}
    try { await closeBrowser(); } catch {}
    return { ok: false, status: 'Ошибка публикации', error: e.message };
  }
};

module.exports = { publishToDzen };

// ── CLI ──
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--check-session')) {
      // Раньше здесь запускался headless-браузер для реальной проверки — но сайты
      // распознают headless-режим как подозрительный, из-за чего проверка могла ложно
      // решить "не авторизован", хотя сессия была рабочей (реальная публикация
      // не использует headless и работает нормально). Поэтому здесь только лёгкая
      // проверка: есть ли вообще сохранённые куки — без запуска браузера. Если сессия
      // всё же истекла — при публикации сработает автоматический перевход по логину/паролю.
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
      console.log('  ДЗЕН — режим ручной авторизации');
      console.log('═'.repeat(50));
      await initBrowser(false);
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      const baselineCookieCount = (await page.cookies()).length;
      info('Войдите в Дзен в открытом окне. Ожидание до 5 минут...');
      const start = Date.now();
      let ok = false;
      while (Date.now() - start < 5 * 60 * 1000) {
        // Пассивная проверка — НЕ перезагружает страницу, чтобы не сбить ввод логина/пароля/2FA.
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
      console.error('Использование: node dzen_automation.js --login | node dzen_automation.js <post.json>');
      process.exit(1);
    }
    const post = JSON.parse(fs.readFileSync(postFile, 'utf-8'));
    const result = await publishToDzen(
      { login: process.env.DZEN_LOGIN, password: process.env.DZEN_PASSWORD, groupUrl: post.groupUrl },
      post
    );
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  })();
}
