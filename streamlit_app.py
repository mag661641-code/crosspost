"""
streamlit_app.py — интерфейс Crosspost на Streamlit.

Ничего не публикует сам: вся логика (Puppeteer, куки, вход в соцсети,
публикация) остаётся в Node-сервере crosspost/app.js (localhost:3900).
Этот файл — просто фронт поверх тех же /api/* эндпоинтов.

Запуск: streamlit run streamlit_app.py
Node-сервер (crosspost/app.js) должен быть запущен отдельно (START.bat).
"""

import time
from datetime import datetime

import requests
import streamlit as st

st.set_page_config(page_title="Crosspost", page_icon="📤", layout="centered")

# Адрес Node-сервера и пароли проектов — из .streamlit/secrets.toml (см. secrets.toml.example).
API_BASE = st.secrets.get("API_BASE", "http://localhost:3900")
PROJECT_PASSWORDS = st.secrets.get("project_passwords", {})


# ── HTTP-сессия с сохранением куки между перерисовками страницы ──
def get_session() -> requests.Session:
    if "http_session" not in st.session_state:
        st.session_state.http_session = requests.Session()
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
def show_login():
    st.title("📤 Crosspost")
    try:
        projects = api_get("/api/projects/list")["projects"]
    except requests.exceptions.ConnectionError:
        st.error(
            "Не удаётся подключиться к серверу Crosspost (localhost:3900). "
            "Убедитесь, что запущен crosspost/START.bat."
        )
        return

    project_id = st.session_state.get("selected_project_id")

    cols = st.columns(len(projects))
    for col, p in zip(cols, projects):
        with col:
            if st.button(f"{p['icon']} {p['name']}", key=f"proj-{p['id']}", use_container_width=True):
                st.session_state.selected_project_id = p["id"]
                st.rerun()

    if project_id:
        with st.form("login_form"):
            password = st.text_input("Пароль", type="password")
            submitted = st.form_submit_button("Войти")
        if submitted:
            # Быстрая проверка по секретам Streamlit — без похода на сервер, для мгновенной
            # обратной связи. Окончательное решение всё равно за Node-сервером ниже: именно
            # он создаёт сессию (куку), которой пользуются все остальные запросы.
            if PROJECT_PASSWORDS and password != PROJECT_PASSWORDS.get(project_id):
                st.error("Неверный пароль")
                return
            try:
                res = api_post("/api/projects/login", {"projectId": project_id, "password": password})
                st.session_state.current_project = res["project"]
                st.rerun()
            except RuntimeError as e:
                st.error(str(e))


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
PLATFORM_FIELDS = {
    "telegram": [("botToken", "Bot Token"), ("chatId", "Chat ID")],
    "vk": [("groupUrl", "Ссылка на группу/страницу")],
    "ok": [("groupUrl", "Ссылка на группу")],
    "dzen": [("login", "Логин"), ("password", "Пароль"), ("groupUrl", "Ссылка на редактор канала")],
    "max": [],
}
PLATFORM_NAMES = {"telegram": "Telegram", "vk": "VK", "ok": "Одноклассники", "dzen": "Дзен", "max": "Макс"}
LOGIN_BUTTON_PLATFORMS = {"vk", "ok", "dzen", "max"}
PLATFORM_HINTS = {
    "ok": "Одноклассники входят так же, как ВК — по номеру телефона и коду из SMS, без отдельного пароля. "
          "Нажмите «Войти в аккаунт», введите номер телефона и код из SMS в открывшемся окне на сервере. "
          "После этого вход запомнится.",
    "vk": "Нажмите «Войти в аккаунт», введите номер телефона и код из SMS в открывшемся окне на сервере. "
          "Вход нужен только один раз — дальше запомнится.",
    "dzen": "Нажмите «Войти в аккаунт» и войдите логином и паролем от Дзена в открывшемся окне на сервере — "
            "вход запомнится, поля ниже можно не заполнять. Логин/Пароль в форме — запасной вариант: "
            "если сессия слетит, приложение само перезайдёт этими данными без открытия окна.",
    "max": "Нажмите «Войти в аккаунт», введите номер телефона и код из SMS в открывшемся окне на сервере. "
           "Вход нужен только один раз — дальше запомнится.",
}


def tab_social():
    try:
        config = api_get("/api/social/config")["config"]
    except RuntimeError as e:
        st.error(str(e))
        return

    updated_config = {}
    for platform, fields in PLATFORM_FIELDS.items():
        with st.container(border=True):
            header_cols = st.columns([3, 1, 1] if platform in LOGIN_BUTTON_PLATFORMS else [3, 1])
            header_cols[0].markdown(f"**{PLATFORM_NAMES[platform]}**")

            if header_cols[1].button("Проверить поля", key=f"test-{platform}"):
                try:
                    res = api_post("/api/social/test", {"platform": platform})
                    st.session_state[f"test-result-{platform}"] = (
                        "✅ " + (res.get("note") or "Подключено") if res.get("ok") else "❌ " + res.get("error", "")
                    )
                except RuntimeError as e:
                    st.session_state[f"test-result-{platform}"] = "❌ " + str(e)

            if platform in LOGIN_BUTTON_PLATFORMS:
                already_logged_in = False
                try:
                    already_logged_in = api_get(f"/api/social/status?platform={platform}").get("loggedIn", False)
                except RuntimeError:
                    pass
                login_label = "✓ Уже вошли" if already_logged_in else "Войти в аккаунт"
                if header_cols[2].button(login_label, key=f"login-{platform}", disabled=already_logged_in):
                    try:
                        res = api_post("/api/social/login", {"platform": platform})
                        st.session_state[f"test-result-{platform}"] = "🪟 " + res.get("note", "")
                    except RuntimeError as e:
                        st.session_state[f"test-result-{platform}"] = "❌ " + str(e)

            if platform in PLATFORM_HINTS:
                st.caption(PLATFORM_HINTS[platform])

            values = config.get(platform, {})
            new_values = {}
            for key, label in fields:
                new_values[key] = st.text_input(
                    label, value=values.get(key, ""), key=f"{platform}-{key}",
                    type="password" if key == "password" else "default",
                )
            updated_config[platform] = new_values

            if f"test-result-{platform}" in st.session_state:
                st.caption(st.session_state[f"test-result-{platform}"])

    if st.button("Сохранить", type="primary"):
        try:
            api_post("/api/social/config", {"config": updated_config})
            st.success("Сохранено")
        except RuntimeError as e:
            st.error(str(e))


# ── ГЛАВНЫЙ ЭКРАН ──
def show_main(project):
    col1, col2 = st.columns([4, 1])
    with col1:
        st.markdown(f"### {project['fullName']} ({project['name']})")
    with col2:
        if st.button("Выйти"):
            api_post("/api/auth/logout")
            for key in list(st.session_state.keys()):
                del st.session_state[key]
            st.rerun()

    tab1, tab2, tab3 = st.tabs(["Новый пост", "Очередь", "Соцсети"])
    with tab1:
        tab_compose()
    with tab2:
        tab_queue()
    with tab3:
        tab_social()


# ── ТОЧКА ВХОДА ──
def main():
    try:
        state = api_get("/api/auth/state")
    except requests.exceptions.ConnectionError:
        st.title("📤 Crosspost")
        st.error(
            "Не удаётся подключиться к серверу Crosspost (localhost:3900). "
            "Убедитесь, что запущен crosspost/START.bat."
        )
        return

    if state.get("currentProjectId"):
        show_main(state["project"])
    else:
        show_login()


main()
