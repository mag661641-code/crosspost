"""
streamlit_app.py — интерфейс Crosspost на Streamlit.

Ничего не публикует сам: вся логика (Puppeteer, куки, вход в соцсети,
публикация) остаётся в Node-сервере crosspost/app.js (localhost:3900).
Этот файл — просто фронт поверх тех же /api/* эндпоинтов.

Запуск: streamlit run streamlit_app.py
Node-сервер (crosspost/app.js) должен быть запущен отдельно (START.bat).
"""

import hashlib
import time
from datetime import datetime

import requests
import streamlit as st

import vk_playwright
import ok_playwright
import dzen_playwright
import max_playwright
from playwright_worker import PlaywrightWorker

# Тот же список/хэши, что в projects.js (Node) — 1:1 перенос, чтобы экран
# логина не зависел от Node-сервера (на Streamlit Cloud его нет и не будет).
_SALT = "crosspost-salt-v1-2026"


def _hash(password: str) -> str:
    return hashlib.pbkdf2_hmac("sha512", password.encode(), _SALT.encode(), 100_000, dklen=64).hex()


PROJECTS = [
    {"id": "SMU", "name": "СМУ", "fullName": "Стальметгрупп", "icon": "🏗", "passwordHash": _hash("1501")},
    {"id": "IMP", "name": "ИМП", "fullName": "Инметпром", "icon": "🔩", "passwordHash": _hash("2205")},
    {"id": "MPE", "name": "МПЭ", "fullName": "МетПромЭнерго", "icon": "⚡", "passwordHash": _hash("1101")},
]


def get_playwright_worker(key: str) -> PlaywrightWorker:
    """
    Постоянный фоновый поток для Playwright — Streamlit выполняет каждую перерисовку
    в новом потоке, а sync-Playwright требует одного и того же потока на всё время
    жизни браузера (см. playwright_worker.py). Поэтому воркер создаётся один раз
    и живёт в session_state, а не создаётся заново при каждом клике. Отдельный
    воркер на площадку (vk/ok/...), чтобы браузеры разных площадок не мешали друг другу.
    """
    state_key = f"pw_worker_{key}"
    if state_key not in st.session_state:
        st.session_state[state_key] = PlaywrightWorker()
    return st.session_state[state_key]

st.set_page_config(page_title="Crosspost", page_icon="📤", layout="centered")

# Адрес Node-сервера — из .streamlit/secrets.toml (см. secrets.toml.example).
# Нужен только вкладкам "Новый пост"/"Очередь"/"Соцсети"; логин и Playwright-вкладки
# от него не зависят (см. show_login/get_playwright_worker выше).
API_BASE = st.secrets.get("API_BASE", "http://localhost:3900")


# ── HTTP-сессия с сохранением куки между перерисовками страницы ──
def get_session() -> requests.Session:
    if "http_session" not in st.session_state:
        session = requests.Session()
        # На этом компьютере задан системный прокси (HTTP_PROXY/HTTPS_PROXY), который
        # requests подхватывает даже для localhost — из-за него запросы к Node-серверу
        # падали с "Service Unavailable". Node всегда локальный, прокси тут не нужен.
        session.trust_env = False
        st.session_state.http_session = session
    return st.session_state.http_session


def api(method: str, path: str, **kwargs):
    session = get_session()
    res = session.request(method, API_BASE + path, timeout=30, **kwargs)
    try:
        data = res.json()
    except ValueError:
        data = {}
    if not res.ok:
        raise RuntimeError(data.get("error", res.reason))
    return data


def api_get(path: str):
    return api("GET", path)


def api_post(path: str, json=None):
    return api("POST", path, json=json or {})


# ── ЭКРАН ЛОГИНА ──
# Полностью локальный (без Node) — те же id/пароли, что в projects.js.
# Это НЕ создаёт сессию на Node-сервере: вкладки "Новый пост"/"Очередь"/"Соцсети"
# (которые всё ещё ходят на localhost:3900) работают только если Node запущен
# локально — на Cloud они покажут ошибку подключения (см. show_main), а
# Playwright-вкладки (ВК/ОК/Дзен/Макс) работают независимо от Node.
def show_login():
    st.title("📤 Crosspost")

    project_id = st.session_state.get("selected_project_id")

    cols = st.columns(len(PROJECTS))
    for col, p in zip(cols, PROJECTS):
        with col:
            if st.button(f"{p['icon']} {p['name']}", key=f"proj-{p['id']}", use_container_width=True):
                st.session_state.selected_project_id = p["id"]
                st.rerun()

    if project_id:
        project = next(p for p in PROJECTS if p["id"] == project_id)
        with st.form("login_form"):
            password = st.text_input("Пароль", type="password")
            submitted = st.form_submit_button("Войти")
        if submitted:
            if _hash(password) != project["passwordHash"]:
                st.error("Неверный пароль")
                return
            st.session_state.current_project = {
                "id": project["id"], "name": project["name"], "fullName": project["fullName"],
            }
            st.rerun()


# ── ВКЛАДКА: НОВЫЙ ПОСТ ──
def tab_compose():
    text = st.text_area("Текст поста", placeholder="Текст... ссылки можно в формате [текст](url)", height=150)

    uploaded_files = st.file_uploader(
        "Картинки", type=["jpg", "jpeg", "png", "gif", "webp"], accept_multiple_files=True
    )
    image_paths = []
    if uploaded_files:
        for f in uploaded_files:
            files = {"file": (f.name, f.getvalue())}
            try:
                res = get_session().post(API_BASE + "/api/upload-image", files=files, timeout=30).json()
                if res.get("ok"):
                    image_paths.append(res["path"])
            except requests.exceptions.RequestException as e:
                st.error(f"Не удалось загрузить {f.name}: {e}")

    st.markdown("**Платформы**")
    platform_cols = st.columns(5)
    platform_labels = {
        "telegram": "Telegram",
        "vk": "VK",
        "ok": "Одноклассники",
        "dzen": "Дзен",
        "max": "Макс",
    }
    selected_platforms = []
    for col, (key, label) in zip(platform_cols, platform_labels.items()):
        with col:
            if st.checkbox(label, key=f"platform-{key}"):
                selected_platforms.append(key)

    dzen_pub_type = "post"
    if "dzen" in selected_platforms:
        dzen_pub_type = st.selectbox("Тип публикации в Дзен", ["post", "article"], format_func=lambda v: "Пост" if v == "post" else "Статья")

    scheduled_date = st.date_input("Запланировать на (необязательно)", value=None)
    scheduled_time_input = st.time_input("Время", value=None) if scheduled_date else None

    col1, col2 = st.columns(2)
    with col1:
        add_clicked = st.button("Добавить в очередь", use_container_width=True)
    with col2:
        publish_clicked = st.button("Опубликовать сейчас", type="primary", use_container_width=True)

    if add_clicked or publish_clicked:
        if not selected_platforms:
            st.error("Выберите хотя бы одну платформу")
            return

        if scheduled_date and scheduled_time_input:
            scheduled_dt = datetime.combine(scheduled_date, scheduled_time_input)
            scheduled_time_iso = scheduled_dt.isoformat()
        else:
            scheduled_time_iso = datetime.utcnow().isoformat()

        post = {
            "text": text,
            "imagePaths": image_paths,
            "platforms": selected_platforms,
            "dzenPubType": dzen_pub_type,
            "scheduledTime": scheduled_time_iso,
        }
        try:
            if add_clicked:
                api_post("/api/queue/add", post)
                st.success("Добавлено в очередь")
            else:
                with st.spinner("Публикуем..."):
                    res = api_post("/api/queue/publish-now", post)
                st.success("Готово")
                st.json(res["results"])
        except RuntimeError as e:
            st.error(str(e))


# ── ВКЛАДКА: ОЧЕРЕДЬ ──
STATUS_LABELS = {
    "pending": "🟡 ожидает",
    "published": "🟢 опубликовано",
    "failed": "🔴 ошибка",
    "cancelled": "⚪ отменено",
}


def tab_queue():
    if st.button("Обновить", key="refresh-queue"):
        st.rerun()

    try:
        items = api_get("/api/queue")["items"]
    except RuntimeError as e:
        st.error(str(e))
        return

    if not items:
        st.info("Очередь пуста")
        return

    for item in reversed(items):
        with st.container(border=True):
            st.write(item.get("text") or "*без текста*")
            scheduled = item.get("scheduledTime", "")
            st.caption(f"{', '.join(item['platforms'])} · {scheduled} · {STATUS_LABELS.get(item['status'], item['status'])}")
            if item["status"] == "pending":
                if st.button("Отменить", key=f"cancel-{item['id']}"):
                    api_post("/api/queue/cancel", {"id": item["id"]})
                    st.rerun()


# ── ВКЛАДКА: СОЦСЕТИ ──
PLATFORM_NAMES = {"telegram": "Telegram", "vk": "VK", "ok": "Одноклассники", "dzen": "Дзен", "max": "Макс"}


_PLAYWRIGHT_LOGIN_TABS = {
    "vk": ("tab_vk_playwright", "ВК"),
    "ok": ("tab_ok_playwright", "ОК"),
    "dzen": ("tab_dzen_playwright", "Дзен"),
    "max": ("tab_max_playwright", "Макс"),
}


def tab_social(project_id: str):
    for platform in PLATFORM_NAMES:
        with st.container(border=True):
            st.markdown(f"**{PLATFORM_NAMES[platform]}**")

            # Вход через браузер (Playwright) — работает и без Node/VPS/VNC,
            # в т.ч. на Streamlit Cloud. Старые поля логина/пароля/токена и
            # кнопки "Проверить поля"/"Сохранить" убрали — они писали в
            # конфиг Node-сервера, которого на Cloud нет и не будет, так
            # что толку от них не было.
            if platform in _PLAYWRIGHT_LOGIN_TABS:
                fn_name, label = _PLAYWRIGHT_LOGIN_TABS[platform]
                with st.expander(f"Вход в {label}"):
                    globals()[fn_name](project_id)
            else:
                st.caption("Публикация в Telegram требует локального Node-сервера (app.js).")


# ── ГЛАВНЫЙ ЭКРАН ──
# ── ВКЛАДКА: ВК ЧЕРЕЗ PLAYWRIGHT (демо без Node/VPS/VNC) ──
# Браузер работает headless (без монитора). Для ввода телефона/SMS-кода вместо
# реального окна показываем скриншот страницы прямо в Streamlit, а сам ввод —
# через обычные текстовые поля. Шаги мастера хранятся в st.session_state,
# объект vk_playwright.VkLoginFlow живёт там же между перерисовками страницы.
def tab_vk_playwright(project_id: str):
    if vk_playwright.has_saved_session(project_id):
        st.success("✓ Сессия ВК уже сохранена — публикация будет работать без повторного входа.")
        if st.button("Войти заново (сбросить сессию)"):
            vk_playwright.session_path(project_id).unlink(missing_ok=True)
            st.rerun()
        st.divider()

    st.caption(
        "Вход в ВК через Playwright прямо здесь, без отдельного Node-сервера. "
        "Браузер работает в фоне (headless) — вместо окна показываем скриншот, ввод телефона/кода — обычными полями ниже."
    )

    worker = get_playwright_worker("vk")
    step = st.session_state.get("vk_pw_step", "idle")

    if step == "idle":
        if st.button("Начать вход в ВК", key="vk-pw-start"):
            with st.spinner("Открываю браузер и захожу на страницу входа ВК..."):
                flow = vk_playwright.VkLoginFlow(project_id)
                screenshot = worker.call(flow.start)
            st.session_state.vk_pw_flow = flow
            st.session_state.vk_pw_screenshot = screenshot
            st.session_state.vk_pw_step = "phone"
            st.rerun()

    elif step == "phone":
        st.image(st.session_state.vk_pw_screenshot, caption="Страница входа ВК (снимок)")
        phone = st.text_input("Номер телефона", key="vk-pw-phone")
        if st.button("Отправить", key="vk-pw-submit-phone") and phone:
            with st.spinner("Отправляю номер телефона..."):
                flow: vk_playwright.VkLoginFlow = st.session_state.vk_pw_flow
                screenshot = worker.call(flow.submit_phone, phone)
            st.session_state.vk_pw_screenshot = screenshot
            # Дальше ВК может попросить либо пароль, либо код (SMS или из Макса) —
            # смотрим на снимок и выбираем нужный вариант на следующем шаге.
            st.session_state.vk_pw_step = "next"
            st.rerun()

    elif step == "next":
        st.image(st.session_state.vk_pw_screenshot, caption="Посмотрите, что просит страница, и заполните нужное поле")
        col1, col2 = st.columns(2)
        with col1:
            st.markdown("**Если просит пароль**")
            password = st.text_input("Пароль", type="password", key="vk-pw-password")
            password_clicked = st.button("Войти по паролю", key="vk-pw-submit-password")
        with col2:
            st.markdown("**Если просит код (SMS или Макс)**")
            code = st.text_input("Код", key="vk-pw-code")
            code_clicked = st.button("Подтвердить код", key="vk-pw-submit-code")

        # Если ВК запросил подтверждение через приложение Макс (QR-код + кнопка "Подтвердить"
        # в самом приложении) — тут нечего вводить, просто ждём и проверяем статус по кнопке.
        st.caption("Если вместо пароля/кода экран просит подтвердить вход в приложении Макс — нажмите кнопку ниже после подтверждения там.")
        confirmed_elsewhere_clicked = st.button("Я подтвердил(а) в приложении — проверить", key="vk-pw-check-external")

        flow: vk_playwright.VkLoginFlow = st.session_state.vk_pw_flow
        screenshot = None
        if password_clicked and password:
            with st.spinner("Проверяю пароль..."):
                screenshot = worker.call(flow.submit_password, password)
        elif code_clicked and code:
            with st.spinner("Проверяю код..."):
                screenshot = worker.call(flow.submit_code, code)
        elif confirmed_elsewhere_clicked:
            screenshot = st.session_state.vk_pw_screenshot  # не меняем — просто перепроверим ниже

        if screenshot is not None:
            st.session_state.vk_pw_screenshot = screenshot
            with st.spinner("Проверяю, выполнен ли вход..."):
                logged_in = worker.call(flow.is_logged_in)
            if logged_in:
                worker.call(flow.save_session)
                worker.call(flow.close)
                for key in ("vk_pw_flow", "vk_pw_screenshot", "vk_pw_step"):
                    st.session_state.pop(key, None)
                st.success("Вход выполнен, сессия сохранена!")
            else:
                st.warning("Похоже, вход ещё не завершён — посмотрите на новый снимок ниже и, если нужно, введите следующее поле (например, если сначала спросили пароль, а теперь просят код).")
            st.rerun()


# ── ВКЛАДКА: ОК ЧЕРЕЗ PLAYWRIGHT (вход через VK ID) ──
# ОК позволяет войти через иконку «ВК» на форме входа — открывается всплывающее
# окно с тем же VK ID (телефон → пароль/код), что и в самостоятельном входе ВК.
# После успешного входа во всплывающем окне оно закрывается само, а вкладка ОК
# становится залогинена — свой пароль ОК заводить не нужно.
def tab_ok_playwright(project_id: str):
    if ok_playwright.has_saved_session(project_id):
        st.success("✓ Сессия ОК уже сохранена — публикация будет работать без повторного входа.")
        if st.button("Войти заново (сбросить сессию)", key="ok-pw-reset"):
            ok_playwright.session_path(project_id).unlink(missing_ok=True)
            st.rerun()
        st.divider()

    st.caption(
        "Вход в ОК через кнопку «Войти через VK ID» — открывается окно VK ID, "
        "телефон + пароль/код от аккаунта ВК. Браузер работает в фоне (headless), вместо "
        "окна показываем скриншот, ввод — обычными полями ниже."
    )

    worker = get_playwright_worker("ok")
    step = st.session_state.get("ok_pw_step", "idle")

    if step == "idle":
        if st.button("Начать вход в ОК через VK ID", key="ok-pw-start"):
            with st.spinner("Открываю браузер, захожу на ОК и открываю окно VK ID..."):
                flow = ok_playwright.OkViaVkLoginFlow(project_id)
                screenshot = worker.call(flow.start)
            st.session_state.ok_pw_flow = flow
            st.session_state.ok_pw_screenshot = screenshot
            st.session_state.ok_pw_step = "phone"
            st.rerun()

    elif step == "phone":
        st.image(st.session_state.ok_pw_screenshot, caption="Окно VK ID (снимок)")
        phone = st.text_input("Номер телефона (от аккаунта ВК)", key="ok-pw-phone")
        if st.button("Отправить", key="ok-pw-submit-phone") and phone:
            with st.spinner("Отправляю номер телефона..."):
                flow: ok_playwright.OkViaVkLoginFlow = st.session_state.ok_pw_flow
                screenshot = worker.call(flow.submit_phone, phone)
            st.session_state.ok_pw_screenshot = screenshot
            st.session_state.ok_pw_step = "next"
            st.rerun()

    elif step == "next":
        st.image(st.session_state.ok_pw_screenshot, caption="Посмотрите, что просит окно, и заполните нужное поле")
        col1, col2 = st.columns(2)
        with col1:
            st.markdown("**Если просит пароль**")
            password = st.text_input("Пароль (от ВК)", type="password", key="ok-pw-password")
            password_clicked = st.button("Войти по паролю", key="ok-pw-submit-password")
        with col2:
            st.markdown("**Если просит код (SMS или Макс)**")
            code = st.text_input("Код", key="ok-pw-code")
            code_clicked = st.button("Подтвердить код", key="ok-pw-submit-code")

        st.caption("Если вместо пароля/кода экран просит подтвердить вход в приложении Макс — нажмите кнопку ниже после подтверждения там.")
        confirmed_elsewhere_clicked = st.button("Я подтвердил(а) в приложении — проверить", key="ok-pw-check-external")

        flow: ok_playwright.OkViaVkLoginFlow = st.session_state.ok_pw_flow
        screenshot = None
        if password_clicked and password:
            with st.spinner("Проверяю пароль..."):
                screenshot = worker.call(flow.submit_password, password)
        elif code_clicked and code:
            with st.spinner("Проверяю код..."):
                screenshot = worker.call(flow.submit_code, code)
        elif confirmed_elsewhere_clicked:
            screenshot = st.session_state.ok_pw_screenshot

        if screenshot is not None:
            st.session_state.ok_pw_screenshot = screenshot
            with st.spinner("Проверяю, выполнен ли вход..."):
                logged_in = worker.call(flow.is_logged_in)
            if logged_in:
                worker.call(flow.save_session)
                worker.call(flow.close)
                for key in ("ok_pw_flow", "ok_pw_screenshot", "ok_pw_step"):
                    st.session_state.pop(key, None)
                st.success("Вход выполнен, сессия сохранена!")
            else:
                st.warning("Похоже, вход ещё не завершён — посмотрите на новый снимок ниже и, если нужно, введите следующее поле.")
            st.rerun()


# ── ВКЛАДКА: ДЗЕН ЧЕРЕЗ PLAYWRIGHT (вход через Яндекс ID) ──
# У Яндекс ID встречаются два разных экрана на первом шаге — по номеру телефона
# (консьюмерский UI) или по логину/e-mail (классическая форма passport.yandex.ru,
# как у бизнес-аккаунтов в publish.js) — показываем оба варианта, заполняется тот,
# что реально виден на снимке.
def tab_dzen_playwright(project_id: str):
    if dzen_playwright.has_saved_session(project_id):
        st.success("✓ Сессия Дзена уже сохранена — публикация будет работать без повторного входа.")
        if st.button("Войти заново (сбросить сессию)", key="dzen-pw-reset"):
            dzen_playwright.session_path(project_id).unlink(missing_ok=True)
            st.rerun()
        st.divider()

    st.caption(
        "Вход в Дзен через «Войти через Яндекс ID». Браузер работает в фоне (headless) — "
        "вместо окна показываем скриншот, ввод — обычными полями ниже."
    )

    worker = get_playwright_worker("dzen")
    step = st.session_state.get("dzen_pw_step", "idle")

    if step == "idle":
        if st.button("Начать вход в Дзен", key="dzen-pw-start"):
            with st.spinner("Открываю браузер и захожу на страницу входа Дзена..."):
                flow = dzen_playwright.DzenLoginFlow(project_id)
                screenshot = worker.call(flow.start)
            st.session_state.dzen_pw_flow = flow
            st.session_state.dzen_pw_screenshot = screenshot
            st.session_state.dzen_pw_step = "first"
            st.rerun()

    elif step == "first":
        st.image(st.session_state.dzen_pw_screenshot, caption="Посмотрите, что просит страница, и заполните нужное поле")
        col1, col2 = st.columns(2)
        with col1:
            st.markdown("**Если просит телефон**")
            phone = st.text_input("Номер телефона", key="dzen-pw-phone")
            phone_clicked = st.button("Отправить телефон", key="dzen-pw-submit-phone")
        with col2:
            st.markdown("**Если просит логин/e-mail**")
            login_value = st.text_input("Логин или e-mail", key="dzen-pw-login")
            login_clicked = st.button("Отправить логин", key="dzen-pw-submit-login")

        flow: dzen_playwright.DzenLoginFlow = st.session_state.dzen_pw_flow
        screenshot = None
        if phone_clicked and phone:
            with st.spinner("Отправляю номер телефона..."):
                screenshot = worker.call(flow.submit_phone, phone)
        elif login_clicked and login_value:
            with st.spinner("Отправляю логин..."):
                screenshot = worker.call(flow.submit_login, login_value)

        if screenshot is not None:
            st.session_state.dzen_pw_screenshot = screenshot
            st.session_state.dzen_pw_step = "next"
            st.rerun()

    elif step == "next":
        st.image(st.session_state.dzen_pw_screenshot, caption="Посмотрите, что просит страница, и заполните нужное поле")
        col1, col2 = st.columns(2)
        with col1:
            st.markdown("**Если просит пароль**")
            password = st.text_input("Пароль", type="password", key="dzen-pw-password")
            password_clicked = st.button("Войти по паролю", key="dzen-pw-submit-password")
        with col2:
            st.markdown("**Если просит код (SMS или Макс)**")
            code = st.text_input("Код", key="dzen-pw-code")
            code_clicked = st.button("Подтвердить код", key="dzen-pw-submit-code")

        st.caption("Если экран просит подтвердить вход в приложении (Макс/Яндекс) — нажмите кнопку ниже после подтверждения там.")
        confirmed_elsewhere_clicked = st.button("Я подтвердил(а) в приложении — проверить", key="dzen-pw-check-external")

        flow: dzen_playwright.DzenLoginFlow = st.session_state.dzen_pw_flow
        screenshot = None
        if password_clicked and password:
            with st.spinner("Проверяю пароль..."):
                screenshot = worker.call(flow.submit_password, password)
        elif code_clicked and code:
            with st.spinner("Проверяю код..."):
                screenshot = worker.call(flow.submit_code, code)
        elif confirmed_elsewhere_clicked:
            screenshot = st.session_state.dzen_pw_screenshot

        if screenshot is not None:
            st.session_state.dzen_pw_screenshot = screenshot
            with st.spinner("Проверяю, выполнен ли вход..."):
                logged_in = worker.call(flow.is_logged_in)
            if logged_in:
                worker.call(flow.save_session)
                worker.call(flow.close)
                for key in ("dzen_pw_flow", "dzen_pw_screenshot", "dzen_pw_step"):
                    st.session_state.pop(key, None)
                st.success("Вход выполнен, сессия сохранена!")
            else:
                st.warning("Похоже, вход ещё не завершён — посмотрите на новый снимок ниже и, если нужно, введите следующее поле.")
            st.rerun()


# ── ВКЛАДКА: МАКС ЧЕРЕЗ PLAYWRIGHT ──
# У Макса самый простой флоу: телефон → капча «Я не робот» (проходит автоматически
# внутри submit_phone) → код из SMS в 6 отдельных полях. Без пароля вообще.
def tab_max_playwright(project_id: str):
    if max_playwright.has_saved_session(project_id):
        st.success("✓ Сессия Макса уже сохранена — публикация будет работать без повторного входа.")
        if st.button("Войти заново (сбросить сессию)", key="max-pw-reset"):
            max_playwright.session_path(project_id).unlink(missing_ok=True)
            st.rerun()
        st.divider()

    st.caption(
        "Вход в Макс через Playwright прямо здесь. Браузер работает в фоне (headless) — "
        "вместо окна показываем скриншот, ввод телефона/кода — обычными полями ниже."
    )

    worker = get_playwright_worker("max")
    step = st.session_state.get("max_pw_step", "idle")

    if step == "idle":
        if st.button("Начать вход в Макс", key="max-pw-start"):
            with st.spinner("Открываю браузер и захожу на страницу входа Макса..."):
                flow = max_playwright.MaxLoginFlow(project_id)
                screenshot = worker.call(flow.start)
            st.session_state.max_pw_flow = flow
            st.session_state.max_pw_screenshot = screenshot
            st.session_state.max_pw_step = "phone"
            st.rerun()

    elif step == "phone":
        st.image(st.session_state.max_pw_screenshot, caption="Страница входа Макса (снимок)")
        phone = st.text_input("Номер телефона", key="max-pw-phone")
        if st.button("Отправить", key="max-pw-submit-phone") and phone:
            with st.spinner("Отправляю номер телефона и прохожу проверку «не робот»..."):
                flow: max_playwright.MaxLoginFlow = st.session_state.max_pw_flow
                screenshot = worker.call(flow.submit_phone, phone)
            st.session_state.max_pw_screenshot = screenshot
            st.session_state.max_pw_step = "code"
            st.rerun()

    elif step == "code":
        st.image(st.session_state.max_pw_screenshot, caption="Введите код из SMS")
        code = st.text_input("Код из SMS", key="max-pw-code")
        col1, col2 = st.columns(2)
        with col1:
            confirm_clicked = st.button("Подтвердить", key="max-pw-submit-code")
        with col2:
            new_code_clicked = st.button("Получить новый код", key="max-pw-new-code")

        flow: max_playwright.MaxLoginFlow = st.session_state.max_pw_flow

        if new_code_clicked:
            with st.spinner("Запрашиваю новый код..."):
                st.session_state.max_pw_screenshot = worker.call(flow.request_new_code)
            st.rerun()

        if confirm_clicked and code:
            with st.spinner("Проверяю код..."):
                screenshot = worker.call(flow.submit_code, code)
            st.session_state.max_pw_screenshot = screenshot
            with st.spinner("Проверяю, выполнен ли вход..."):
                logged_in = worker.call(flow.is_logged_in)
            if logged_in:
                worker.call(flow.save_session)
                worker.call(flow.close)
                for key in ("max_pw_flow", "max_pw_screenshot", "max_pw_step"):
                    st.session_state.pop(key, None)
                st.success("Вход выполнен, сессия сохранена!")
            else:
                st.warning("Похоже, вход ещё не завершён — проверьте код и попробуйте ещё раз, либо посмотрите на снимок выше.")
            st.rerun()


def show_main(project):
    col1, col2 = st.columns([4, 1])
    with col1:
        st.markdown(f"### {project['fullName']} ({project['name']})")
    with col2:
        if st.button("Выйти"):
            try:
                api_post("/api/auth/logout")
            except requests.exceptions.ConnectionError:
                pass  # Node недоступен (например, на Cloud) — локальный выход всё равно работает
            for key in list(st.session_state.keys()):
                del st.session_state[key]
            st.rerun()

    # ВАЖНО: не используем st.tabs() — на Streamlit Cloud его CSS/JS иногда не
    # отрисовывается корректно, и содержимое всех вкладок выводится подряд на
    # одну страницу без переключения (обнаружено и исправлено в click/).
    # Радио-кнопки не зависят от этого — рендерится только один раздел.
    section = st.radio(
        "Раздел",
        ["Новый пост", "Очередь", "Соцсети"],
        horizontal=True, label_visibility="collapsed", key="main-section",
    )
    st.divider()
    if section in ("Новый пост", "Очередь"):
        # Эти вкладки ходят на Node-бэкенд (app.js, localhost:3900) — на
        # Streamlit Cloud его нет и не будет (там нет Node), поэтому ловим
        # ошибку явно вместо падения всего приложения.
        try:
            if section == "Новый пост":
                tab_compose()
            else:
                tab_queue()
        except Exception as e:  # noqa: BLE001
            st.error(f"Недоступно без локального Node-сервера (app.js): {type(e).__name__}: {e}")
    else:
        # "Соцсети" не требует Node целиком — вход в ВК/ОК/Дзен/Макс идёт
        # через Playwright прямо здесь (см. tab_social), без Node-сервера.
        tab_social(project["id"])


# ── ТОЧКА ВХОДА ──
# Раньше здесь был поход на Node (/api/auth/state) ДО show_login() — на
# Streamlit Cloud (где Node нет и не будет) это блокировало вообще всё,
# даже показ формы логина. current_project теперь хранится только в
# st.session_state (см. show_login) — без обращения к Node.
def main():
    if st.session_state.get("current_project"):
        show_main(st.session_state["current_project"])
    else:
        show_login()


main()
