#!/usr/bin/env node
/**
 * vk_automation.js — публикация во ВКонтакте через браузерную автоматизацию (Puppeteer).
 * Запасной путь на случай если получить API-токен группы (vk.js) неудобно.
 * Структура идентична dzen_automation.js/ok_automation.js — см. комментарии там для деталей паттерна.
 * Свой userDataDir/cookies — сессии остальных площадок не пересекаются.
 *
 * У ВК (как и у Макса) вход по номеру телефона + SMS-код, пароля нет — код может
 * ввести только человек, поэтому автоматический вход невозможен. Единственный способ
 * авторизации — ручной режим `node vk_automation.js --login` (см. CLI-блок ниже).
 *
 * ⚠️ ВАЖНО: DOM-селекторы ВК ниже — ЗАГЛУШКИ (TODO). Перед боевым использованием:
 *   1. Запустить `node vk_automation.js --login`, вручную войти по телефону+SMS — сессия сохранится.
 *   2. Открыть форму создания поста на стене группы, посмотреть реальные selectors (devtools),
 *      заменить все места, помеченные `// TODO selector`.
 * До этого момента модуль НЕ подключается к автоматической очереди (queue.js).
 *
 * Использование:
 *   node vk_automation.js --login              — только авторизация (ручной вход по SMS-коду)
 *   node vk_automation.js <post.json>           — опубликовать пост из файла (нужна сохранённая сессия)
 *
 * Формат post.json: { text, imagePaths: [...], groupUrl }
 * Телефон (для справки в логах) — env VK_PHONE. Сессия — только через --login.
 *
 * Ссылки сообществ (для справки):
 *   ИМП — https://vk.com/inmetprom
 *   СМУ — https://vk.com/stalmetural
 *   МПЭ — https://vk.com/metpromenergo
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PLATFORM = 'vk';
const BASE_URL = 'https://vk.com';

const USER_BASE = process.env.CLICK_PROJECT_DIR
  ? path.join(__dirname, 'users-data', process.env.CLICK_PROJECT_DIR)
  : __dirname;
if (!fs.existsSync(USER_BASE)) fs.mkdirSync(USER_BASE, { recursive: true });

const SESSION_DIR = path.join(USER_BASE, 'session');
const COOKIES_PATH = path.join(SESSION_DIR, 'vk_cookies.json');
const USER_DATA_DIR = path.join(SESSION_DIR, 'vk-browser-data');
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
  info('🌐 Запуск браузера для ВК...');
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
    info(`🍪 Куки ВК сохранены (${cookies.length} шт.)`);
  } catch (e) { warn(`Не удалось сохранить куки: ${e.message}`); }
};

const loadCookies = async () => {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        info(`🍪 Куки ВК загружены (${cookies.length} шт.)`);
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
  // TODO selector: проверить реальный признак авторизованной сессии ВК
  // (например, наличие ссылки на "Мою страницу" в левом меню).
  try {
    await page.goto(`${BASE_URL}/feed`, { waitUntil: 'domcontentloaded' });
    await randDelay();
    return !/login|act=login/i.test(page.url());
  } catch { return false; }
};

// ВАЖНО: НЕ навигирует страницу (в отличие от isLoggedIn выше) — page.cookies() просто
// читает cookie jar браузера, не трогая открытую вкладку. Используется в цикле ожидания
// при ручном --login: если бы мы дёргали page.goto() каждые пару секунд, это сбрасывало бы
// форму ввода SMS-кода/QR прямо во время того, как человек её заполняет.
// Комбинируем два сигнала: URL больше не похож на страницу входа, И появились новые
// cookies по сравнению с состоянием до логина (сама по себе проверка URL может дать
// ложное срабатывание сразу после открытия страницы, до реального входа).
let stableLoginChecks = 0; // счётчик подряд-успешных проверок

const isLoggedInPassive = async (baselineCookieCount, elapsedMs) => {
  try {
    // Не принимаем решение слишком рано — даём ВК время самому "успокоиться"
    // после открытия страницы (его собственные фоновые куки перестают расти).
    if (elapsedMs < 8000) { stableLoginChecks = 0; return false; }

    const u = page.url();
    const urlLooksLoggedIn = u && !/login|act=login|^about:blank$/i.test(u) && u.startsWith(BASE_URL);
    if (!urlLooksLoggedIn) { stableLoginChecks = 0; return false; }

    const cookies = await page.cookies();
    const hasRealAuthCookie = cookies.some(c => /remixsid|remixlhk|l=/i.test(c.name));
    const cookiesGrew = cookies.length > baselineCookieCount + 3; // с запасом, не любое +1

    if (hasRealAuthCookie && cookiesGrew) {
      stableLoginChecks++;
    } else {
      stableLoginChecks = 0;
    }

    // Требуем 3 проверки подряд (то есть ~6 секунд стабильного состояния),
    // прежде чем поверить, что человек действительно вошёл.
    return stableLoginChecks >= 3;
  } catch { stableLoginChecks = 0; return false; }
};

// Автоматический вход НЕВОЗМОЖЕН: у ВК (для этого способа) вход по телефону + SMS-код,
// а код может ввести только человек. Поэтому единственный способ авторизации —
// ручной режим `node vk_automation.js --login` (см. CLI-блок ниже): открывается
// браузер, пользователь сам вводит номер и код из SMS, сессия сохраняется в cookies
// и переиспользуется дальше автоматически (пока не протухнет).

/**
 * publishToVkBrowser({phone}, {text, imagePaths, groupUrl})
 * Требует уже сохранённую сессию (через --login). До 10 изображений (как и в API-версии vk.js).
 * groupUrl — ссылка на сообщество (например https://vk.com/inmetprom), куда постим.
 * Возвращает { ok, status, error } — при ошибке status = 'Ошибка публикации'.
 */
// ВК использует "случайные"/хэшированные CSS-классы (vkit-jhwfrm, vkuiButton__content
// и т.п.) — они могут поменяться при любом обновлении сайта. Поэтому ищем кнопки
// по видимому ТЕКСТУ — надёжнее, чем угадывать классы.
const clickButtonByText = async (textFragment, timeout = 15000, scopeSelector = null) => {
  // Ищем среди широкого набора тегов (пункты меню ВК бывают div/li без role),
  // и из всех совпадений берём САМЫЙ ВНУТРЕННИЙ элемент (с наименьшим textContent) —
  // так меньше риск кликнуть по обёртке без обработчика клика.
  // scopeSelector — если задан, ищем ТОЛЬКО внутри этого контейнера (например,
  // внутри открытого диалога) — иначе на странице может найтись одноимённая
  // кнопка/пункт в другом, не относящемся к делу месте.
  const handle = await page.waitForFunction((fragment, scope) => {
    const root = scope ? document.querySelector(scope) : document;
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll('button, [role="button"], a, span, div, li'));
    const matches = candidates.filter(el => {
      const t = (el.textContent || '').trim();
      return t === fragment || t.startsWith(fragment);
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    return matches[0];
  }, { timeout }, textFragment, scopeSelector);
  const el = handle.asElement();
  if (!el) throw new Error(`Кнопка "${textFragment}" не найдена`);
  // Многие меню/тултипы ВК показываются и держатся открытыми, только пока курсор
  // реально "наведён" на них (hover), и закрываются сами при отсутствии движения
  // мыши в их сторону. Обычный el.click() кликает без физического движения курсора —
  // из-за этого меню могло закрываться раньше, чем скрипт успевал найти пункт внутри.
  // Поэтому явно двигаем мышь к элементу перед кликом.
  const box = await el.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await sleep(150);
  }
  await el.click();
  return el;
};

// Читает видимый текст кастомного селекта (шапка календаря/блок времени) — используется
// чтобы ПРОВЕРИТЬ, что клик по выпадающему списку реально дошёл до компонента.
const readCustomSelectTitle = async (containerHandle) => {
  return containerHandle.$eval('.vkuiCustomSelectInput__title', el => (el.textContent || '').trim()).catch(() => null);
};

// Выбирает значение в кастомном дропдауне ВК (месяц/год/час/минута в календаре) —
// КЛИКОМ по реальному пункту открывшегося списка, а не программной установкой
// скрытого <select> (page.select() меняет DOM-значение, но React-компонент ВК
// на него не реагирует — проверено: час оставался прежним, несмотря на select()).
// containerHandle — обёртка конкретного поля (например .vkuiCalendarHeader__picker),
// value — искомый видимый текст пункта списка (например "20" для часа, "июль" для месяца).
const clickCustomDropdownOption = async (containerHandle, value) => {
  const input = await containerHandle.$('input[role="combobox"]');
  if (!input) throw new Error('Поле-комбобокс не найдено в дропдауне');
  await input.click();
  await sleep(400);

  // Числовые пункты (час/минута) иногда отображаются с ведущим нулём ("06"),
  // а иногда без ("6") — ищем оба варианта написания.
  const numeric = /^\d+$/.test(String(value));
  const acceptable = numeric
    ? [String(value), String(value).padStart(2, '0')]
    : [String(value)];

  const tryClick = async () => page.evaluate((vals) => {
    // Список опций рендерится в портал (может быть вне исходного контейнера) —
    // ищем по всему документу элементы с точным текстом, предпочитая те, что
    // находятся внутри listbox/popover (а не случайный текст где-то ещё на странице).
    const candidates = Array.from(document.querySelectorAll('[role="option"], li, div, span'))
      .filter(el => el.children.length === 0 && vals.includes(el.textContent.trim()));
    const inListbox = candidates.find(el => el.closest('[role="listbox"], .vkuiPopover__in, [role="dialog"]'));
    const target = inListbox || candidates[0];
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  }, acceptable);

  let clicked = await tryClick();
  // Список может быть скроллируемым и показывать не все значения сразу — если
  // не нашли с первого раза, пробуем прокрутить открывшийся список вниз/вверх
  // и поискать ещё несколько раз, прежде чем сдаться.
  if (!clicked) {
    for (let i = 0; i < 8 && !clicked; i++) {
      const scrolled = await page.evaluate(() => {
        const box = document.querySelector('[role="listbox"], .vkuiPopover__in');
        if (!box) return false;
        box.scrollTop += 40;
        return true;
      });
      if (!scrolled) break;
      await sleep(150);
      clicked = await tryClick();
    }
  }
  if (!clicked) throw new Error(`Пункт "${value}" не найден в открывшемся списке`);
  await sleep(300);
};

// Час/минута в блоке времени — обычный <input> БЕЗ readonly (в отличие от месяца/года,
// у которых readonly и обязателен клик по списку) — поэтому проще и надёжнее просто
// напечатать число и подтвердить Enter, вместо кликов по прокручиваемому списку.
const typeCustomInputValue = async (containerHandle, value) => {
  const input = await containerHandle.$('input[role="combobox"]');
  if (!input) throw new Error('Поле-комбобокс не найдено');
  await input.click({ clickCount: 3 }); // тройной клик — выделяет всё текущее значение
  await sleep(150);
  await input.type(String(value), { delay: 30 });
  await sleep(150);
  await page.keyboard.press('Enter');
  // Escape убран намеренно: он вызывал пересборку DOM всего блока времени
  // (закрытие/переоткрытие дропдауна), из-за чего заранее полученная ссылка на
  // ВТОРОЕ поле (минуты) "отваливалась" — Node is detached from document.
  // Enter сам по себе подтверждает введённое значение, этого достаточно.
  await sleep(300);
};

// Открывает попап "Запланировать" в форме поста и настраивает дату/время через
// нативный календарь ВК, затем подтверждает кнопкой "Добавить в очередь" —
// дальше публикацию в нужный момент делает сам ВК, Click не обязан быть запущен
// в это время (в отличие от нашей собственной очереди queue.json + cron).
// Проверить результат вручную: https://vk.com/wall-<id_группы>?postponed=1
//
// ВАЖНО: после каждого programmatic-изменения (page.select на скрытых <select>)
// сверяем видимое значение в интерфейсе — если он не поменялся, значит
// React-компонент не среагировал на событие, и мы явно падаем с ошибкой вместо
// того, чтобы тихо "успешно" нажать неактивную кнопку подтверждения (именно
// так один раз уже случилось: лог писал "Готово", а пост в ВК не появился).
const scheduleVkPost = async (scheduledDate) => {
  // 1. Кнопка "Запланировать" в форме поста
  await page.waitForSelector('[data-testid="posting_postponed_button"]', { timeout: 10000 });
  await page.click('[data-testid="posting_postponed_button"]');
  await sleep(400);
  await page.waitForSelector('.vkuiCalendar__host', { timeout: 10000 });

  const targetMonth = scheduledDate.getMonth(); // 0-11, как в <select> месяца
  const targetYear = scheduledDate.getFullYear();
  const targetDay = scheduledDate.getDate();
  const targetHour = scheduledDate.getHours();
  const targetMinute = scheduledDate.getMinutes();
  const MONTH_NAMES_RU = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

  // 2. Месяц и год — открываем настоящий дропдаун в шапке календаря и кликаем нужный
  // пункт (первый picker — месяц, второй — год). Пропускаем, если уже стоит нужное
  // значение (обычно так и есть, если планируем в пределах текущего месяца/года).
  const headerPickers = await page.$$('.vkuiCalendarHeader__picker');
  if (headerPickers[0]) {
    const shownMonthBefore = (await readCustomSelectTitle(headerPickers[0]) || '').toLowerCase();
    if (shownMonthBefore !== MONTH_NAMES_RU[targetMonth]) {
      await clickCustomDropdownOption(headerPickers[0], MONTH_NAMES_RU[targetMonth][0].toUpperCase() + MONTH_NAMES_RU[targetMonth].slice(1));
      const shownMonth = await readCustomSelectTitle(headerPickers[0]);
      if ((shownMonth || '').toLowerCase() !== MONTH_NAMES_RU[targetMonth]) {
        throw new Error(`Месяц не переключился: ожидали "${MONTH_NAMES_RU[targetMonth]}", в интерфейсе "${shownMonth}"`);
      }
    }
  }
  if (headerPickers[1]) {
    const shownYearBefore = await readCustomSelectTitle(headerPickers[1]);
    if (shownYearBefore !== String(targetYear)) {
      await clickCustomDropdownOption(headerPickers[1], String(targetYear));
      const shownYear = await readCustomSelectTitle(headerPickers[1]);
      if (shownYear !== String(targetYear)) {
        throw new Error(`Год не переключился: ожидали "${targetYear}", в интерфейсе "${shownYear}"`);
      }
    }
  }

  // 3. День — кликаем по ячейке сетки с нужным числом (после смены месяца сетка актуальна)
  const dayClicked = await page.evaluate((day) => {
    const numbers = Array.from(document.querySelectorAll('.vkuiCalendarDay__dayNumber span[aria-hidden="true"]'));
    const target = numbers.find(el => el.textContent.trim() === String(day));
    const cell = target ? target.closest('[role="gridcell"]') : null;
    if (!cell) return false;
    cell.click();
    return true;
  }, targetDay);
  if (!dayClicked) throw new Error(`Не удалось найти день ${targetDay} в календаре ВК`);
  await sleep(300);
  const daySelected = await page.evaluate((day) => {
    const numbers = Array.from(document.querySelectorAll('.vkuiCalendarDay__dayNumber span[aria-hidden="true"]'));
    const target = numbers.find(el => el.textContent.trim() === String(day));
    const cell = target ? target.closest('[role="gridcell"]') : null;
    return cell ? cell.getAttribute('aria-selected') === 'true' : false;
  }, targetDay);
  if (!daySelected) throw new Error(`День ${targetDay} кликнут, но не отмечен как выбранный (aria-selected≠true)`);

  // 4. Час и минута — печатаем число прямо в поле (оно текстовое, без readonly)
  // и подтверждаем Enter — надёжнее, чем клики по прокручиваемому списку.
  // ВАЖНО: получаем ссылку на каждое поле НЕПОСРЕДСТВЕННО перед использованием
  // (не заранее, одним махом для обоих) — если ввод в поле часа вызвал пересборку
  // DOM блока времени, старая ссылка на поле минут "отвалится" (Node is detached).
  const hourPicker = (await page.$$('.vkuiCalendarTime__picker'))[0];
  if (hourPicker) {
    await typeCustomInputValue(hourPicker, targetHour);
    const shownHour = await readCustomSelectTitle(hourPicker);
    if (Number(shownHour) !== targetHour) {
      throw new Error(`Час не переключился: ожидали "${targetHour}", в интерфейсе "${shownHour}"`);
    }
  }
  // Даём DOM время устояться после ввода часа, прежде чем искать поле минут заново —
  // если пересборка блока времени ещё не завершилась, свежий запрос может вернуть
  // не тот элемент (или их временно меньше/больше одного).
  await sleep(400);
  const timePickersAfterHour = await page.$$('.vkuiCalendarTime__picker');
  info(`Диагностика после ввода часа: найдено ${timePickersAfterHour.length} .vkuiCalendarTime__picker`);
  const minutePicker = timePickersAfterHour[timePickersAfterHour.length - 1];
  if (minutePicker) {
    // В отличие от часа, минута иногда не принимает напечатанное значение по Enter
    // и откатывается к прежнему пункту (например, оставалось "22" вместо введённого "0") —
    // поэтому выбираем минуту кликом по пункту в открывшемся списке, как месяц/год,
    // а не печатью текста.
    await clickCustomDropdownOption(minutePicker, targetMinute);
    const shownMinute = await readCustomSelectTitle(minutePicker);
    if (Number(shownMinute) !== targetMinute) {
      throw new Error(`Минута не переключилась: ожидали "${targetMinute}", в интерфейсе "${shownMinute}"`);
    }
  }

  // 5. Подтверждение — переносит пост во внутреннюю очередь отложенных публикаций ВК.
  // Проверяем, что кнопка не задизейблена — иначе клик по ней ничего не сделает
  // (именно так однажды получилось "успешно" завершить публикацию, ничего не запланировав).
  const confirmSelector = '[data-testid="posting_postponed_publish_button"]';
  await page.waitForSelector(confirmSelector, { timeout: 10000 });
  const isDisabled = await page.$eval(confirmSelector, el => el.disabled || el.getAttribute('aria-disabled') === 'true');
  if (isDisabled) throw new Error('Кнопка "Добавить в очередь" неактивна — дата/время не приняты формой');
  await page.click(confirmSelector);
  await sleep(500);
  // Модалка планирования должна закрыться после успешного подтверждения.
  const stillOpen = await page.$(confirmSelector);
  if (stillOpen) throw new Error('После клика "Добавить в очередь" попап планирования не закрылся — похоже, не сработало');
};

const publishToVkBrowser = async ({ phone }, { text, imagePaths, groupUrl, scheduledTime }) => {
  try {
    await initBrowser(false);

    if (!(await isLoggedIn())) {
      throw new Error(
        `Нет сохранённой сессии ВК${phone ? ` (телефон ${phone})` : ''}. ` +
        `Войдите вручную: node vk_automation.js --login (код из SMS вводится в открывшемся браузере).`
      );
    }

    await withRetry(async () => {
      if (!groupUrl) throw new Error('Не указана ссылка на сообщество (groupUrl)');
      info(`Шаг 0: открываю ${groupUrl}`);
      await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
      await randDelay();

      // 1. Кнопка "+ Создать" (над постами группы) — открывает выпадающее меню
      // (Пост/Пост в канал/История/Клип/Видео/Трансляция/Статья). Ищем по тексту,
      // не по классам, т.к. классы ВК хэшированные и меняются (см. clickButtonByText).
      // ВАЖНО: это меню — hover-флайаут, закрывается само без движения мыши в его
      // сторону, поэтому между этим кликом и следующим — короткая пауза, НЕ randDelay
      // (1-3с), чтобы не дать меню закрыться раньше, чем найдём пункт "Пост".
      info('Шаг 1: клик "Создать"');
      await clickButtonByText('Создать');
      await sleep(300);

      // 2. В открывшемся меню — пункт "Пост" (обычный текстовый пост на стену).
      info('Шаг 2: клик "Пост" в меню');
      await clickButtonByText('Пост');

      // 2.5. Ждём, пока откроется именно МОДАЛЬНОЕ ОКНО "Новый пост" (role=dialog),
      // и дальше ищем элементы формы ТОЛЬКО внутри него. Это важно: без такого
      // ограничения запасной поиск "любой input[type=file] на странице" иногда
      // попадал на другие, не относящиеся к посту загрузчики файлов (например,
      // на странице сообщества их несколько — для обложки, для раздела «Фото» и т.п.),
      // из-за чего фото улетало не туда, форма поста ломалась, и retry запускал
      // всё заново поверх уже частично заполненной старой формы — отсюда дубли.
      await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
      const dialogSelector = '[role="dialog"]';
      await randDelay();

      // 2.6. ВК автоматически сохраняет черновик поста — если предыдущая попытка
      // (в этом же retry-цикле) успела прикрепить фото/текст и упала на более
      // позднем шаге, следующая попытка открывает уже НЕ пустую форму, а тот же
      // черновик, и новое фото/текст просто наслаиваются поверх старых (карусель
      // из задублированных фото, задублированный текст). Поэтому перед заполнением
      // явно очищаем форму: убираем все уже прикреплённые фото и стираем весь текст.
      info('Шаг 2.6: очищаю форму от возможного черновика');
      // Удаляем все превью фото — кнопка удаления подтверждена вживую:
      // data-testid="posting_attachment_photo_item_remove" (скрыта до наведения через
      // CSS, но реально есть в DOM и кликабельна программно без наведения мышью).
      for (let i = 0; i < 10; i++) {
        const removeBtn = await page.$(`${dialogSelector} [data-testid="posting_attachment_photo_item_remove"]`);
        if (!removeBtn) break;
        await removeBtn.click();
        await sleep(300);
      }
      // Стираем весь текст в поле (если черновик его тоже восстановил) — фокус,
      // выделить всё, удалить.
      const textFieldForClear = `${dialogSelector} [data-testid="posting_base_screen_input_message"]`;
      const hasTextField = await page.$(textFieldForClear);
      if (hasTextField) {
        await page.click(textFieldForClear);
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await sleep(200);
      }

      // 3. Открылась модалка "Новый пост" — сначала фото (если есть), это
      // подгружает превью и не мешает последующему вводу текста.
      if (imagePaths && imagePaths.length > 0) {
        info(`Шаг 3: загружаю ${imagePaths.length} фото`);
        // Основной селектор — точный data-testid, СТРОГО внутри диалога. Если не
        // найден за 8с — логируем диагностику (что за input'ы вообще есть внутри
        // диалога) и пробуем запасной селектор, тоже ограниченный диалогом.
        let fileInput = await page.waitForSelector(`${dialogSelector} input[data-testid="posting_base_screen_download_from_device"]`, { timeout: 8000 }).catch(() => null);
        if (!fileInput) {
          const diag = await page.evaluate((sel) => {
            const dialog = document.querySelector(sel);
            if (!dialog) return 'dialog not found';
            return Array.from(dialog.querySelectorAll('input[type="file"]')).map(el => ({
              testid: el.getAttribute('data-testid'),
              accept: (el.getAttribute('accept') || '').slice(0, 60),
            }));
          }, dialogSelector);
          warn(`Шаг 3: точный селектор не найден внутри диалога: ${JSON.stringify(diag)}`);
          fileInput = await page.waitForSelector(`${dialogSelector} input[type="file"]`, { timeout: 8000 });
        }
        await fileInput.uploadFile(...imagePaths.slice(0, 10));
        await randDelay();
      } else {
        info('Шаг 3: фото нет, пропускаю');
      }

      // 4. Текстовое поле формы ("Напишите что-нибудь...") — contenteditable span
      // с подтверждённым data-testid, тоже строго внутри диалога.
      info(`Шаг 4: ввожу текст (${(text || '').length} символов)`);
      const textFieldSelector = `${dialogSelector} [data-testid="posting_base_screen_input_message"]`;
      await page.waitForSelector(textFieldSelector, { timeout: 10000 });
      await page.click(textFieldSelector);
      await randDelay();
      await page.type(textFieldSelector, text || '', { delay: 10 });
      await randDelay();
      // Проверяем, что текст реально попал в поле — если нет, лучше упасть с понятной
      // ошибкой сейчас, чем молча продолжать с пустым постом.
      const typedText = await page.$eval(textFieldSelector, el => el.textContent || '').catch(() => '');
      info(`Шаг 4: в поле сейчас "${typedText.slice(0, 60)}"`);
      if ((text || '').trim() && !typedText.trim()) {
        throw new Error('Текст не попал в поле ввода (после page.type поле осталось пустым)');
      }

      // 5. Кнопка "Далее" — переход от экрана "Новый пост" к экрану настроек/публикации.
      info('Шаг 5: клик "Далее"');
      await clickButtonByText('Далее', 15000, dialogSelector);
      await randDelay();

      // 6. Если scheduledTime реально в будущем — ставим пост во внутреннюю очередь ВК
      // (публикацию дальше делает сам ВК). Если время уже наступило (например, это
      // вызов из нашего собственного cron ровно в назначенный момент) — планировать
      // через календарь ВК бессмысленно, публикуем сразу как обычно.
      const dt = scheduledTime ? new Date(scheduledTime) : null;
      const isFutureSchedule = dt && !isNaN(dt.getTime()) && dt.getTime() > Date.now() + 60000;
      if (isFutureSchedule) {
        info(`Шаг 6: планирую через календарь ВК на ${dt.toISOString()}`);
        await scheduleVkPost(dt);
        info('Шаг 6: пост поставлен в очередь ВК — проверить: https://vk.com/wall-<id_группы>?postponed=1');
      } else {
        info('Шаг 6: публикую сразу');
        await page.waitForSelector('[data-testid="posting_submit_button"]', { timeout: 10000 });
        await page.click('[data-testid="posting_submit_button"]');
        await randDelay();
      }
      info('Готово: пост отправлен');
    }, 'publish');

    await saveCookies();
    await closeBrowser();
    return { ok: true, status: 'Опубликовано' };
  } catch (e) {
    error(`❌ Ошибка публикации в ВК: ${e.message}`);
    try { await takeScreenshot('error'); } catch {}
    try { await closeBrowser(); } catch {}
    return { ok: false, status: 'Ошибка публикации', error: e.message };
  }
};

module.exports = { publishToVkBrowser };

// ── CLI ──
if (require.main === module) {
  (async () => {
    if (process.argv.includes('--check-session')) {
      // Раньше здесь запускался headless-браузер и проверял страницу ленты — но ВК
      // распознаёт headless-режим как подозрительный и подсовывает вместо ленты страницу
      // проверки безопасности, из-за чего проверка ложно решала "не авторизован", хотя
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
      console.log('  ВК — режим ручной авторизации');
      console.log('═'.repeat(50));
      await initBrowser(false);
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      const baselineCookieCount = (await page.cookies()).length;
      info('Войдите в ВК в открытом окне. Ожидание до 5 минут...');
      const start = Date.now();
      let ok = false;
      while (Date.now() - start < 5 * 60 * 1000) {
        // Пассивная проверка — НЕ перезагружает страницу, чтобы не сбить ввод SMS-кода/QR.
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
      console.error('Использование: node vk_automation.js --login | node vk_automation.js <post.json>');
      process.exit(1);
    }
    const post = JSON.parse(fs.readFileSync(postFile, 'utf-8'));
    const result = await publishToVkBrowser({ phone: process.env.VK_PHONE }, post);
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  })();
}
