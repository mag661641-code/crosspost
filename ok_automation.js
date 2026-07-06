#!/usr/bin/env node
/**
 * ok_automation.js — публикация в Одноклассники через браузерную автоматизацию (Puppeteer).
 * Вход — такой же, как у ВК: по телефону + SMS-код, через кнопку «Войти через ВК»
 * (у ОК нет своего пароля в этом сценарии). Как и у ВК, автоматический вход НЕВОЗМОЖЕН —
 * код из SMS может ввести только человек. Сессия сохраняется в cookies один раз через
 * ручной `--login`, дальше публикация идёт по сохранённой сессии.
 * Структура идентична dzen_automation.js/vk_automation.js — см. комментарии там для деталей.
 * Свой userDataDir/cookies — сессии Яндекс.Бизнеса/Дзена/Макса/ВК/ОК не пересекаются.
 *
 * ⚠️ ВАЖНО: DOM-селекторы ОК ниже — ЗАГЛУШКИ (TODO). Перед боевым использованием:
 *   1. Запустить `node ok_automation.js --login`, вручную войти через «Войти через ВК» —
 *      сессия сохранится.
 *   2. Открыть форму создания поста в группе, посмотреть реальные selectors (devtools),
 *      заменить все места, помеченные `// TODO selector`.
 * До этого момента модуль НЕ подключается к автоматической очереди (queue.js).
 *
 * Использование:
 *   node ok_automation.js --login              — только авторизация (ручной вход по SMS-коду)
 *   node ok_automation.js <post.json>           — опубликовать пост из файла
 *
 * Формат post.json: { text, imagePaths: [...], groupUrl }
 * Телефон — env OK_PHONE, только для информативных сообщений об ошибке (сама публикация
 * требует заранее сохранённой сессии).
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PLATFORM = 'ok';
const BASE_URL = 'https://ok.ru';

const USER_BASE = process.env.CLICK_PROJECT_DIR
  ? path.join(__dirname, 'users-data', process.env.CLICK_PROJECT_DIR)
  : __dirname;
if (!fs.existsSync(USER_BASE)) fs.mkdirSync(USER_BASE, { recursive: true });

const SESSION_DIR = path.join(USER_BASE, 'session');
const COOKIES_PATH = path.join(SESSION_DIR, 'ok_cookies.json');
const USER_DATA_DIR = path.join(SESSION_DIR, 'ok-browser-data');
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

// Retry-константы — те же, что в publish.js (186-212), скопированы (не импортированы).
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
  info('🌐 Запуск браузера для ОК...');
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
    info(`🍪 Куки ОК сохранены (${cookies.length} шт.)`);
  } catch (e) { warn(`Не удалось сохранить куки: ${e.message}`); }
};

const loadCookies = async () => {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        info(`🍪 Куки ОК загружены (${cookies.length} шт.)`);
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
  // TODO selector: проверить реальный признак авторизованной сессии ОК
  // (например, наличие ссылки на профиль/аватар в шапке).
  try {
    await page.goto(`${BASE_URL}/profile`, { waitUntil: 'domcontentloaded' });
    await randDelay();
    return !/\/dk\?st\.cmd=|login/i.test(page.url());
  } catch { return false; }
};

// ВАЖНО: НЕ навигирует страницу (в отличие от isLoggedIn выше) — page.cookies() просто
// читает cookie jar браузера, не трогая открытую вкладку. Используется в цикле ожидания
// при ручном --login: если бы мы дёргали page.goto() каждые пару секунд, это сбрасывало бы
// форму ввода логина/пароля/SMS-кода прямо во время того, как человек её заполняет.
//
// Раньше здесь была слишком лёгкая проверка (URL + "хоть одна новая кука"), из-за которой
// окно закрывалось почти сразу после открытия — ok.ru сам ставит фоновые куки (аналитика,
// счётчики) ещё до реального входа, и это ложно засчитывалось как «вошёл» (на практике
// анонимный визит уже даёт 15-20 кук). Теперь, как и у ВК:
//   1) не принимаем решение раньше 8 секунд с открытия страницы (даём ok.ru "успокоиться"),
//   2) требуем ЗАМЕТНЫЙ прирост кук (+10 к тому, что было до открытия — обычный анонимный
//      набор кук уже близок к этому числу, поэтому нужен настоящий скачок от входа),
//   3) требуем 3 успешных проверки ПОДРЯД (~6 секунд стабильного состояния),
// прежде чем поверить, что человек действительно вошёл и можно закрывать окно.
// TODO selector: точнее было бы искать конкретную куку авторизации ОК по имени
// (как у ВК — remixsid), но её имя пока не подтверждено вживую.
let stableLoginChecks = 0;

const isLoggedInPassive = async (baselineCookieCount, elapsedMs) => {
  try {
    if (elapsedMs < 8000) { stableLoginChecks = 0; return false; }

    const u = page.url();
    const urlLooksLoggedIn = u && !/\/dk\?st\.cmd=|login|^about:blank$/i.test(u) && u.startsWith(BASE_URL);
    if (!urlLooksLoggedIn) { stableLoginChecks = 0; return false; }

    const cookies = await page.cookies();
    const cookiesGrew = cookies.length > baselineCookieCount + 10;

    stableLoginChecks = cookiesGrew ? stableLoginChecks + 1 : 0;
    return stableLoginChecks >= 3;
  } catch { stableLoginChecks = 0; return false; }
};

// Автоматический вход НЕВОЗМОЖЕН: вход в ОК — через «Войти через ВК» по телефону + SMS-код,
// код может ввести только человек. Поэтому здесь нет функции login() — есть только ручной
// `--login` (см. ниже) и проверка уже сохранённой сессии в publishToOkBrowser.

// Разметка анкоров в исходном тексте: [текст](url). ОК не поддерживает эту разметку
// через API/plain-текст — но редактор ОК на сайте умеет вставлять настоящие
// кликабельные анкоры через тулбар (кнопка 🔗 «Ссылка» → диалог с полями
// «Текст» + «Введите ссылку» → «Добавить»). Ниже — набор текста с реальными
// анкорами через этот диалог, а не просто текстом.
const ANCHOR_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

// Кликает по кнопке, находя её по видимому тексту (надёжнее чем угадывать классы/атрибуты).
const clickButtonByText = async (textFragment, timeout = 8000) => {
  const handle = await page.waitForFunction((fragment) => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
    return candidates.find(el => (el.textContent || '').trim().includes(fragment)) || null;
  }, { timeout }, textFragment);
  const el = handle.asElement();
  if (!el) throw new Error(`Кнопка "${textFragment}" не найдена`);
  await el.click();
  return el;
};

/**
 * Печатает текст в фокусированный contenteditable, превращая [текст](url) в
 * настоящие кликабельные анкоры через тулбар редактора ОК.
 * TODO selector: точные селекторы тулбара/диалога — предположения, нужна проверка
 * вживую (запустить node ok_automation.js --login, открыть форму поста, посмотреть DOM).
 */
const typeTextWithAnchors = async (editorSelector, text) => {
  let lastIndex = 0;
  let m;
  const re = new RegExp(ANCHOR_RE);
  while ((m = re.exec(text)) !== null) {
    const plainBefore = text.slice(lastIndex, m.index);
    if (plainBefore) { await page.type(editorSelector, plainBefore, { delay: 10 }); await randDelay(); }

    const [, label, url] = m;
    // 1. Печатаем текст будущего анкора
    await page.type(editorSelector, label, { delay: 10 });
    // 2. Выделяем только что напечатанный текст (Shift+ArrowLeft × длина текста)
    await page.keyboard.down('Shift');
    for (let i = 0; i < label.length; i++) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await randDelay();
    // 3. Кликаем по кнопке "Ссылка" (🔗) во всплывающем тулбаре форматирования
    // TODO selector: уточнить точный селектор кнопки (сейчас — поиск по aria-label/title)
    const linkBtn = await page.$('[aria-label="Ссылка"], [title="Ссылка"], button[data-name="link"]');
    if (linkBtn) await linkBtn.click();
    else await clickButtonByText('Ссылка').catch(() => { throw new Error('Не найдена кнопка "Ссылка" в тулбаре редактора'); });
    await randDelay();
    // 4. В диалоге поле "Текст" уже заполнено выделением — ищем ВТОРОЕ текстовое поле
    // (URL, с плейсхолдером "Введите ссылку") и вводим туда ссылку
    // TODO selector: уточнить точный селектор полей диалога
    await page.waitForSelector('input[placeholder="Введите ссылку"], input[type="url"]', { timeout: 8000 });
    const urlInput = await page.$('input[placeholder="Введите ссылку"], input[type="url"]');
    await urlInput.click({ clickCount: 3 });
    await urlInput.type(url, { delay: 10 });
    await randDelay();
    // 5. Подтверждаем — кнопка "Добавить"
    await clickButtonByText('Добавить');
    await randDelay();
    // 6. Возвращаем курсор в конец вставленного анкора, чтобы продолжить печатать дальше
    await page.click(editorSelector);
    await page.keyboard.press('End');

    lastIndex = m.index + m[0].length;
  }
  const plainAfter = text.slice(lastIndex);
  if (plainAfter) await page.type(editorSelector, plainAfter, { delay: 10 });
};

/**
 * publishToOkBrowser({phone}, {text, imagePaths, groupUrl})
 * Ровно 1 изображение на пост (требование ОК).
 * groupUrl — ссылка на группу (например https://ok.ru/group/1234567890), куда постим.
 * Возвращает { ok, status, error } — при ошибке status = 'Ошибка публикации'.
 */
const publishToOkBrowser = async ({ phone }, { text, imagePaths, groupUrl }) => {
  try {
    await initBrowser(false);

    if (!(await isLoggedIn())) {
      throw new Error(
        `Нет сохранённой сессии ОК${phone ? ` (телефон ${phone})` : ''}. ` +
        `Войдите вручную: node ok_automation.js --login (в открывшемся окне — «Войти через ВК», код из SMS вводится там же).`
      );
    }

    await withRetry(async () => {
      // TODO selector/URL: если groupUrl не задан — публикуем на свою стену
      await page.goto(groupUrl || `${BASE_URL}/profile`, { waitUntil: 'domcontentloaded' });
      await randDelay();

// Кнопка "Создать пост" — найдена вживую через devtools (03.07.2026)
      await page.waitForSelector('a.pf-head_itx_a', { timeout: 15000 });
      await page.click('a.pf-head_itx_a');
      await randDelay();

      // Поле ввода текста поста — contenteditable-блок внутри открывшейся формы.
      // Уточняем класс (не просто [contenteditable="true"]), чтобы не перепутать
      // с другими редактируемыми полями, если они появятся на странице.
      const textFieldSelector = '.js-posting-itx[contenteditable="true"]';
      await page.waitForSelector(textFieldSelector, { timeout: 15000 });
      await page.click(textFieldSelector);
      await randDelay();
      // Набор текста с реальными анкорными ссылками (см. typeTextWithAnchors выше) —
      // [текст](url) в исходном тексте превращается в кликабельную ссылку через
      // родной тулбар редактора ОК, а не просто в текст.
      await typeTextWithAnchors(textFieldSelector, text || '');
      await randDelay();

      if (imagePaths && imagePaths.length > 0) {
        info('Загружаю фото...');
        // Сначала кликаем по кнопке "Добавить фото" — найдена вживую (03.07.2026).
        // Она открывает отдельное всплывающее окно выбора фото.
        const photoBtn = await page.$('.js-photos-btn');
        if (photoBtn) {
          await photoBtn.click();
          await randDelay();
        } else {
          warn('Кнопка "Добавить фото" (.js-photos-btn) не найдена — пробую найти поле загрузки напрямую');
        }
        // Ищем поле загрузки файла — оно должно появиться после клика.
        // ВАЖНО: если это место снова не сработает — здесь нужно уточнить
        // реальный селектор input[type=file] внутри открывшегося окна выбора фото.
        const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 8000 }).catch(() => null);
        if (fileInput) {
          await fileInput.uploadFile(imagePaths[0]);
          await randDelay();
          info('Фото загружено');
        } else {
          warn('Поле загрузки файла не найдено — публикую без фото');
        }
      }

      await randDelay();
      // Кнопка "Поделиться" (публикация поста) — найдена вживую через devtools (03.07.2026).
      // ВАЖНО: используем именно эту комбинацию классов, а не просто .js-publish-btn —
      // на странице есть ДРУГАЯ кнопка ("Место"/геометка) с похожим классом .js-publish-btn,
      // но без класса .posting_submit — такая комбинация её точно исключает.
      const publishSelector = 'button.posting_submit.js-publish-btn';
      await page.waitForSelector(publishSelector, { timeout: 10000 });
      await page.click(publishSelector);
      await randDelay();
    }, 'publish');

    await saveCookies();
    await closeBrowser();
    return { ok: true, status: 'Опубликовано' };
  } catch (e) {
    error(`❌ Ошибка публикации в ОК: ${e.message}`);
    try { await takeScreenshot('error'); } catch {}
    try { await closeBrowser(); } catch {}
    return { ok: false, status: 'Ошибка публикации', error: e.message };
  }
};

module.exports = { publishToOkBrowser };

// ── CLI ──
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--check-session')) {
      // Раньше здесь запускался headless-браузер и навигировал на /profile — но сайт
      // распознаёт headless-режим как подозрительный и может подсунуть вместо профиля
      // страницу проверки, из-за чего проверка ложно решала "не авторизован", хотя
      // сессия была рабочей (реальная публикация не использует headless и работает нормально).
      // Поэтому здесь только лёгкая проверка: есть ли вообще сохранённые куки —
      // без запуска браузера, значит и без ложных срабатываний от антибот-защиты.
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
      console.log('  ОК — режим ручной авторизации');
      console.log('═'.repeat(50));
      await initBrowser(false);
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      const baselineCookieCount = (await page.cookies()).length;
      info('В открытом окне нажмите «Войти через ВК» и авторизуйтесь по телефону/SMS-коду. Ожидание до 5 минут...');
      const start = Date.now();
      let ok = false;
      while (Date.now() - start < 5 * 60 * 1000) {
        // Пассивная проверка — НЕ перезагружает страницу, чтобы не сбить ввод SMS-кода/2FA.
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
      console.error('Использование: node ok_automation.js --login | node ok_automation.js <post.json>');
      process.exit(1);
    }
    const post = JSON.parse(fs.readFileSync(postFile, 'utf-8'));
    const result = await publishToOkBrowser({ phone: process.env.OK_PHONE }, post);
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  })();
}
