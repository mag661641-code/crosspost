// _ui.js — интерфейс Crosspost. Одна страница: логин → соцсети → очередь постов.
// Временный UI, планируется к замене на Streamlit-фронт поверх тех же /api/* эндпоинтов.

const buildHTML = () => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Crosspost</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 24px; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 16px; }
  .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  label { display: block; font-size: 13px; color: #94a3b8; margin: 10px 0 4px; }
  input, textarea, select { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 14px; }
  textarea { min-height: 90px; resize: vertical; }
  button { cursor: pointer; border: none; border-radius: 8px; padding: 9px 16px; font-size: 14px; font-weight: 600; background: #3b82f6; color: white; margin-top: 10px; }
  button.secondary { background: #334155; }
  button.danger { background: #ef4444; }
  button.loggedin { background: #334155; color: #94a3b8; cursor: default; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .row > * { flex: 1; }
  .platforms { display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0; }
  .platforms label { display: flex; align-items: center; gap: 6px; color: #e2e8f0; margin: 0; }
  .platforms input { width: auto; }
  .queue-item { border: 1px solid #334155; border-radius: 8px; padding: 10px; margin-top: 8px; font-size: 13px; }
  .queue-item .meta { color: #94a3b8; font-size: 12px; }
  .status-pending { color: #fbbf24; } .status-published { color: #34d399; } .status-failed { color: #f87171; } .status-cancelled { color: #94a3b8; }
  .hidden { display: none !important; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tabs button { background: #334155; margin: 0; }
  .tabs button.active { background: #3b82f6; }
  .err { color: #f87171; font-size: 13px; margin-top: 6px; }
  .ok { color: #34d399; font-size: 13px; margin-top: 6px; }
  .thumbs { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>📤 Crosspost</h1>

  <div id="loginScreen" class="card hidden">
    <div id="projectList"></div>
    <div id="passwordBlock" class="hidden">
      <label>Пароль</label>
      <input type="password" id="loginPassword">
      <button onclick="doLogin()">Войти</button>
      <div id="loginError" class="err"></div>
    </div>
  </div>

  <div id="mainScreen" class="hidden">
    <div class="row" style="align-items:center; margin-bottom: 12px;">
      <div id="currentProject" style="font-weight:600;"></div>
      <button class="secondary" style="flex:0 0 auto;" onclick="logout()">Выйти</button>
    </div>

    <div class="tabs">
      <button id="tabBtnCompose" class="active" onclick="switchTab('compose')">Новый пост</button>
      <button id="tabBtnQueue" onclick="switchTab('queue')">Очередь</button>
      <button id="tabBtnSocial" onclick="switchTab('social')">Соцсети</button>
    </div>

    <div id="tabCompose" class="card">
      <label>Текст поста</label>
      <textarea id="postText" placeholder="Текст... ссылки можно в формате [текст](url)"></textarea>

      <label>Картинки</label>
      <input type="file" id="imageInput" multiple accept="image/*" onchange="uploadImages()">
      <div class="thumbs" id="thumbs"></div>

      <label>Платформы</label>
      <div class="platforms">
        <label><input type="checkbox" value="telegram" onchange="onPlatformsChanged()"> Telegram</label>
        <label><input type="checkbox" value="vk" onchange="onPlatformsChanged()"> VK</label>
        <label><input type="checkbox" value="ok" onchange="onPlatformsChanged()"> Одноклассники</label>
        <label><input type="checkbox" value="dzen" onchange="onPlatformsChanged()"> Дзен</label>
        <label><input type="checkbox" value="max" onchange="onPlatformsChanged()"> Макс</label>
      </div>

      <div class="row">
        <div id="dzenPubTypeBlock" class="hidden">
          <label>Тип публикации в Дзен</label>
          <select id="dzenPubType"><option value="post">Пост</option><option value="article">Статья</option></select>
        </div>
        <div>
          <label>Запланировать на (пусто = сейчас)</label>
          <input type="datetime-local" id="scheduledTime">
        </div>
      </div>

      <button onclick="addToQueue()">Добавить в очередь</button>
      <button class="secondary" onclick="publishNow()">Опубликовать сейчас</button>
      <div id="composeMsg"></div>
    </div>

    <div id="tabQueue" class="card hidden">
      <button class="secondary" onclick="loadQueue()">Обновить</button>
      <div id="queueList"></div>
    </div>

    <div id="tabSocial" class="card hidden">
      <div id="socialForms"></div>
      <button onclick="saveSocial()">Сохранить</button>
      <div id="socialMsg"></div>
    </div>
  </div>
</div>

<script>
let uploadedImages = [];
let selectedProjectId = null;

const api = async (url, opts) => {
  const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};

const init = async () => {
  const state = await api('/api/auth/state');
  if (state.currentProjectId) {
    showMain(state.project);
  } else {
    showLogin();
  }
};

const showLogin = async () => {
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('mainScreen').classList.add('hidden');
  const { projects } = await api('/api/projects/list');
  const list = document.getElementById('projectList');
  list.innerHTML = projects.map(p =>
    \`<button style="background:\${p.color}" onclick="selectProject('\${p.id}')">\${p.icon} \${p.name}</button>\`
  ).join(' ');
};

const selectProject = (id) => {
  selectedProjectId = id;
  document.getElementById('passwordBlock').classList.remove('hidden');
  document.getElementById('loginPassword').focus();
};

const doLogin = async () => {
  const password = document.getElementById('loginPassword').value;
  try {
    const res = await api('/api/projects/login', { method: 'POST', body: JSON.stringify({ projectId: selectedProjectId, password }) });
    showMain(res.project);
  } catch (e) {
    document.getElementById('loginError').textContent = e.message;
  }
};

const logout = async () => {
  await api('/api/auth/logout', { method: 'POST' });
  location.reload();
};

const showMain = (project) => {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('mainScreen').classList.remove('hidden');
  document.getElementById('currentProject').textContent = project.fullName + ' (' + project.name + ')';
  loadSocialForms();
  loadQueue();
};

const switchTab = (name) => {
  ['compose', 'queue', 'social'].forEach(t => {
    document.getElementById('tab' + t[0].toUpperCase() + t.slice(1)).classList.toggle('hidden', t !== name);
    document.getElementById('tabBtn' + t[0].toUpperCase() + t.slice(1)).classList.toggle('active', t === name);
  });
};

const onPlatformsChanged = () => {
  const dzenChecked = document.querySelector('.platforms input[value="dzen"]').checked;
  document.getElementById('dzenPubTypeBlock').classList.toggle('hidden', !dzenChecked);
};

// ── ЗАГРУЗКА КАРТИНОК ──
const uploadImages = async () => {
  const files = document.getElementById('imageInput').files;
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload-image', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) uploadedImages.push(data.path);
  }
  renderThumbs();
};
const renderThumbs = () => {
  document.getElementById('thumbs').innerHTML = uploadedImages.map((p, i) =>
    \`<div>📎 \${p.split(/[\\\\/]/).pop()} <a href="#" onclick="removeImage(\${i});return false">✕</a></div>\`
  ).join('');
};
const removeImage = (i) => { uploadedImages.splice(i, 1); renderThumbs(); };

const getSelectedPlatforms = () => Array.from(document.querySelectorAll('.platforms input:checked')).map(i => i.value);

const buildPost = () => {
  const scheduledTimeRaw = document.getElementById('scheduledTime').value;
  return {
    text: document.getElementById('postText').value,
    imagePaths: uploadedImages,
    platforms: getSelectedPlatforms(),
    dzenPubType: document.getElementById('dzenPubType').value,
    scheduledTime: scheduledTimeRaw ? new Date(scheduledTimeRaw).toISOString() : new Date().toISOString(),
  };
};

const addToQueue = async () => {
  const msg = document.getElementById('composeMsg');
  try {
    const post = buildPost();
    if (post.platforms.length === 0) throw new Error('Выберите хотя бы одну платформу');
    await api('/api/queue/add', { method: 'POST', body: JSON.stringify(post) });
    msg.className = 'ok'; msg.textContent = 'Добавлено в очередь';
    resetCompose();
    switchTab('queue'); loadQueue();
  } catch (e) { msg.className = 'err'; msg.textContent = e.message; }
};

const publishNow = async () => {
  const msg = document.getElementById('composeMsg');
  try {
    const post = buildPost();
    if (post.platforms.length === 0) throw new Error('Выберите хотя бы одну платформу');
    msg.className = 'ok'; msg.textContent = 'Публикуем...';
    const res = await api('/api/queue/publish-now', { method: 'POST', body: JSON.stringify(post) });
    msg.textContent = JSON.stringify(res.results);
    resetCompose();
  } catch (e) { msg.className = 'err'; msg.textContent = e.message; }
};

const resetCompose = () => {
  document.getElementById('postText').value = '';
  uploadedImages = []; renderThumbs();
  document.querySelectorAll('.platforms input').forEach(i => i.checked = false);
  document.getElementById('scheduledTime').value = '';
  onPlatformsChanged();
};

// ── ОЧЕРЕДЬ ──
const loadQueue = async () => {
  const { items } = await api('/api/queue');
  const list = document.getElementById('queueList');
  if (items.length === 0) { list.innerHTML = '<div class="meta">Очередь пуста</div>'; return; }
  list.innerHTML = items.slice().reverse().map(item => \`
    <div class="queue-item">
      <div>\${(item.text || '').slice(0, 120) || '<без текста>'}</div>
      <div class="meta">
        \${item.platforms.join(', ')} · \${new Date(item.scheduledTime).toLocaleString()} ·
        <span class="status-\${item.status}">\${item.status}</span>
      </div>
      \${item.status === 'pending' ? \`<button class="danger" onclick="cancelItem('\${item.id}')">Отменить</button>\` : ''}
    </div>
  \`).join('');
};
const cancelItem = async (id) => { await api('/api/queue/cancel', { method: 'POST', body: JSON.stringify({ id }) }); loadQueue(); };

// ── СОЦСЕТИ ──
const PLATFORM_FIELDS = {
  telegram: [['botToken', 'Bot Token'], ['chatId', 'Chat ID']],
  vk: [['groupUrl', 'Ссылка на группу/страницу']],
  ok: [['groupUrl', 'Ссылка на группу']],
  dzen: [['login', 'Логин'], ['password', 'Пароль'], ['groupUrl', 'Ссылка на редактор канала']],
  max: [],
};
const PLATFORM_NAMES = { telegram: 'Telegram', vk: 'VK', ok: 'Одноклассники', dzen: 'Дзен', max: 'Макс' };
// Площадки, где нужно один раз войти в аккаунт кнопкой (не терминалом) — откроется
// окно браузера, вход по SMS-коду (ВК/ОК/Макс) или логину-паролю (Дзен).
const LOGIN_BUTTON_PLATFORMS = { vk: true, ok: true, dzen: true, max: true };
const PLATFORM_HINTS = {
  ok: 'Одноклассники входят так же, как ВК — по номеру телефона и коду из SMS, без отдельного пароля. Нажмите кнопку «Войти в аккаунт» ниже, введите номер телефона и код из SMS в открывшемся окне. После этого вход запомнится, и в следующий раз ничего вводить не придётся.',
  vk: 'Нажмите «Войти в аккаунт» ниже, введите номер телефона и код из SMS в открывшемся окне. Вход нужен только один раз — дальше запомнится.',
  dzen: 'Нажмите «Войти в аккаунт» ниже и войдите своим логином и паролем от Дзена в открывшемся окне — вход запомнится, полей ниже для этого достаточно не заполнять. Логин/Пароль в форме — запасной вариант: если сессия слетит, приложение само перезайдёт этими данными, без открытия окна и без вашего участия (у Дзена, в отличие от ВК/ОК/Макса, нет SMS-кода, поэтому автоматический повторный вход возможен).',
  max: 'Нажмите «Войти в аккаунт» ниже, введите номер телефона и код из SMS в открывшемся окне. Вход нужен только один раз — дальше запомнится.',
};

let socialConfigCache = null;
const loadSocialForms = async () => {
  const { config } = await api('/api/social/config');
  socialConfigCache = config;
  const container = document.getElementById('socialForms');
  container.innerHTML = Object.keys(PLATFORM_FIELDS).map(platform => \`
    <div style="margin-bottom:16px; border-bottom:1px solid #334155; padding-bottom:12px;">
      <div class="row" style="align-items:center;">
        <strong>\${PLATFORM_NAMES[platform]}</strong>
        <button class="secondary" style="flex:0 0 auto;" onclick="testPlatform('\${platform}')">Проверить поля</button>
        \${LOGIN_BUTTON_PLATFORMS[platform] ? \`<button id="loginBtn-\${platform}" style="flex:0 0 auto;" onclick="loginPlatform('\${platform}')">Войти в аккаунт</button>\` : ''}
      </div>
      \${PLATFORM_HINTS[platform] ? \`<div class="meta" style="margin:4px 0 8px;">\${PLATFORM_HINTS[platform]}</div>\` : ''}
      \${PLATFORM_FIELDS[platform].map(([key, label]) => \`
        <label>\${label}</label>
        <input data-platform="\${platform}" data-key="\${key}" value="\${(config[platform] && config[platform][key]) || ''}">
      \`).join('')}
      <div id="testResult-\${platform}" class="meta"></div>
    </div>
  \`).join('');

  // Проверяем, кто уже вошёл — чтобы сразу показать блёклую кнопку "Уже вошли",
  // не дожидаясь клика.
  Object.keys(LOGIN_BUTTON_PLATFORMS).forEach(refreshLoginButton);
};

const setLoginButtonState = (platform, loggedIn) => {
  const btn = document.getElementById('loginBtn-' + platform);
  if (!btn) return;
  btn.classList.toggle('loggedin', loggedIn);
  btn.textContent = loggedIn ? '✓ Уже вошли' : 'Войти в аккаунт';
};

const refreshLoginButton = async (platform) => {
  try {
    const res = await api('/api/social/status?platform=' + platform);
    setLoginButtonState(platform, !!res.loggedIn);
  } catch { /* не критично — кнопка просто останется как есть */ }
};

const loginPlatform = async (platform) => {
  const el = document.getElementById('testResult-' + platform);
  el.textContent = 'Открываю окно браузера...';
  try {
    const res = await api('/api/social/login', { method: 'POST', body: JSON.stringify({ platform }) });
    el.textContent = '🪟 ' + res.note;
    // Окно входа открыто в отдельном процессе (до 5 минут) — периодически проверяем,
    // не завершился ли вход, и как только да — гасим кнопку. Проверяем нечасто и не
    // бесконечно: сама проверка тоже открывает браузер тем же профилем, что и окно
    // входа, — слишком частые проверки мешают самому входу и лишний раз дёргают сайт.
    let attempts = 0;
    const MAX_ATTEMPTS = 8; // ~2 минуты
    const poll = setInterval(async () => {
      attempts++;
      const status = await api('/api/social/status?platform=' + platform).catch(() => null);
      if (status && status.loggedIn) {
        setLoginButtonState(platform, true);
        el.textContent = '✅ Вход выполнен';
        clearInterval(poll);
      } else if (attempts >= MAX_ATTEMPTS) {
        el.textContent = 'Не удалось это подтвердить автоматически. Если вы уже вошли в открывшемся окне — всё в порядке, можно закрыть окно и пробовать публиковать.';
        clearInterval(poll);
      }
    }, 15000);
  } catch (e) { el.textContent = '❌ ' + e.message; }
};

const saveSocial = async () => {
  const config = JSON.parse(JSON.stringify(socialConfigCache));
  document.querySelectorAll('#socialForms input').forEach(input => {
    config[input.dataset.platform][input.dataset.key] = input.value;
  });
  const msg = document.getElementById('socialMsg');
  try {
    await api('/api/social/config', { method: 'POST', body: JSON.stringify({ config }) });
    socialConfigCache = config;
    msg.className = 'ok'; msg.textContent = 'Сохранено';
  } catch (e) { msg.className = 'err'; msg.textContent = e.message; }
};

const testPlatform = async (platform) => {
  const el = document.getElementById('testResult-' + platform);
  el.textContent = 'Проверка...';
  try {
    const res = await api('/api/social/test', { method: 'POST', body: JSON.stringify({ platform }) });
    el.textContent = res.ok ? '✅ ' + (res.note || 'Подключено') : '❌ ' + res.error;
  } catch (e) { el.textContent = '❌ ' + e.message; }
};

init();
</script>
</body>
</html>`;

module.exports = { buildHTML };
