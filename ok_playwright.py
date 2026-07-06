"""
ok_playwright.py — вход и публикация в Одноклассники через Playwright (headless).
Тот же подход, что и в vk_playwright.py: скриншот вместо окна, ввод — обычными
полями Streamlit. См. playwright_worker.py — вызовы методов идут через постоянный
фоновый поток, иначе Playwright (sync API) падает при вызове из другого потока
(так у Streamlit, который выполняет каждую перерисовку в новом потоке).

Реальный флоу входа ОК (проверено вживую, 06.07.2026):
  1. ok.ru → сразу форма входа (без QR по умолчанию, в отличие от VK).
  2. Логин/телефон — input[name="st.email"], пароль — input[name="st.password"].
  3. Кнопка "Войти" — именно та, что внутри формы с полем пароля (на странице
     есть ещё формы поиска с похожими полями/кнопками — сработали именно
     на них с первой попытки, см. комментарий в submit_credentials).
  4. Если логин/пароль неверны — ОК показывает текст ошибки прямо на странице,
     остаёмся на том же экране (не падает, не бросает исключение).
  5. Двухфакторная проверка (код) при первом входе с нового устройства пока
     не проверена вживую — see submit_code() (TODO selector, как и у VK/ОК
     в Node-версии).
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page

from browser_setup import ensure_chromium_installed

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

BASE_URL = "https://ok.ru"


def session_path(project_id: str) -> Path:
    d = Path(__file__).parent / "users-data" / project_id / "session"
    d.mkdir(parents=True, exist_ok=True)
    return d / "ok_storage_state.json"


class OkLoginFlow:
    def __init__(self, project_id: str):
        self.project_id = project_id
        self._playwright = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None

    def start(self) -> bytes:
        """Открывает браузер, идёт на главную ОК (там сразу форма входа). Возвращает скриншот."""
        ensure_chromium_installed()
        self._playwright = sync_playwright().start()
        self.browser = self._playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900})
        self.page = self.context.new_page()
        self.page.goto(BASE_URL, wait_until="domcontentloaded")
        self.page.wait_for_timeout(1500)
        return self.page.screenshot(full_page=True)

    def submit_credentials(self, login_value: str, password: str) -> bytes:
        """
        Вводит логин (телефон/email) и пароль, жмёт «Войти» именно в форме входа
        (на странице есть похожие поля в других формах — важно кликать кнопку
        внутри той же формы, что и поле пароля, иначе промахивается).
        """
        self.page.fill('input[name="st.email"]', login_value)
        self.page.fill('input[name="st.password"]', password)
        form = self.page.locator('input[name="st.password"]').locator("xpath=ancestor::form[1]")
        form.locator('button:has-text("Войти")').click()
        self.page.wait_for_timeout(2500)
        return self.page.screenshot(full_page=True)

    def submit_code(self, code: str) -> bytes:
        """
        Вводит код подтверждения, если ОК его запросил (двухфакторная проверка
        при входе с нового устройства). TODO selector: не проверено вживую —
        те же варианты полей, что и у VK.
        """
        single_field_candidates = [
            'input[inputmode="numeric"]',
            'input[type="tel"]',
            'input[name="code"]',
        ]
        for sel in single_field_candidates:
            if self.page.locator(sel).count() == 1:
                self.page.fill(sel, code)
                self.page.wait_for_timeout(2500)
                return self.page.screenshot(full_page=True)

        digit_boxes = self.page.locator('input[maxlength="1"]')
        if digit_boxes.count() >= len(code):
            for i, digit in enumerate(code):
                digit_boxes.nth(i).fill(digit)
            self.page.wait_for_timeout(2500)
            return self.page.screenshot(full_page=True)

        self.page.wait_for_timeout(500)
        return self.page.screenshot(full_page=True)

    def is_logged_in(self) -> bool:
        self.page.goto(f"{BASE_URL}/profile", wait_until="domcontentloaded")
        self.page.wait_for_timeout(1000)
        return not (
            "/dk?st.cmd=" in self.page.url or "login" in self.page.url
        )

    def save_session(self) -> Path:
        path = session_path(self.project_id)
        self.context.storage_state(path=str(path))
        return path

    def close(self):
        try:
            if self.browser:
                self.browser.close()
        finally:
            if self._playwright:
                self._playwright.stop()


class OkViaVkLoginFlow:
    """
    Вход в ОК через кнопку «Войти через VK ID» (иконка ВК на форме входа ОК).
    Проверено вживую (06.07.2026): клик по `a.social-icon-button.__vk_id` открывает
    ВСПЛЫВАЮЩЕЕ ОКНО (popup) с id.vk.com — та же форма, что и в vk_playwright.py
    (телефон → пароль или код), только кнопка называется "Продолжить", а не "Войти".
    После успешного входа во всплывающем окне оно закрывается само, а основная
    вкладка ОК становится залогинена.
    """

    def __init__(self, project_id: str):
        self.project_id = project_id
        self._playwright = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None  # основная вкладка ОК
        self.popup: Page | None = None  # всплывающее окно VK ID

    def start(self) -> bytes:
        """Открывает ОК, жмёт иконку «Войти через VK ID» — открывается попап. Возвращает его скриншот."""
        ensure_chromium_installed()
        self._playwright = sync_playwright().start()
        self.browser = self._playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900})
        self.page = self.context.new_page()
        self.page.goto(BASE_URL, wait_until="domcontentloaded")
        self.page.wait_for_timeout(1500)

        with self.page.expect_popup(timeout=15000) as popup_info:
            self.page.click("a.social-icon-button.__vk_id")
        self.popup = popup_info.value
        self.popup.wait_for_load_state("domcontentloaded")
        self.popup.wait_for_timeout(1200)
        return self.popup.screenshot(full_page=True)

    def submit_phone(self, phone: str) -> bytes:
        self.popup.fill('input[name="login"][type="tel"]', phone)
        self.popup.click('button:has-text("Продолжить")')
        self.popup.wait_for_timeout(2500)
        return self.popup.screenshot(full_page=True)

    def submit_password(self, password: str) -> bytes:
        self.popup.fill('input[name="password"]', password)
        self.popup.click('button:has-text("Продолжить")')
        self.popup.wait_for_timeout(2500)
        if self.popup.is_closed():
            # Попап закрылся сам — вход прошёл, возвращаем снимок основной вкладки ОК.
            self.page.wait_for_timeout(1000)
            return self.page.screenshot(full_page=True)
        return self.popup.screenshot(full_page=True)

    def request_sms_instead(self) -> bytes:
        self.popup.click("text=Забыли или не установили пароль?")
        self.popup.wait_for_timeout(1200)
        try:
            self.popup.click("text=Нет, восстановить пароль", timeout=4000)
            self.popup.wait_for_timeout(1000)
        except Exception:
            pass
        self.popup.click('button:has-text("Отправить код")')
        self.popup.wait_for_timeout(2000)
        return self.popup.screenshot(full_page=True)

    def submit_code(self, code: str) -> bytes:
        single_field_candidates = [
            'input[inputmode="numeric"]',
            'input[type="tel"]',
            'input[name="code"]',
        ]
        for sel in single_field_candidates:
            if self.popup.locator(sel).count() == 1:
                self.popup.fill(sel, code)
                self.popup.wait_for_timeout(2500)
                break
        else:
            digit_boxes = self.popup.locator('input[maxlength="1"]')
            if digit_boxes.count() >= len(code):
                for i, digit in enumerate(code):
                    digit_boxes.nth(i).fill(digit)
                self.popup.wait_for_timeout(2500)

        if self.popup.is_closed():
            self.page.wait_for_timeout(1000)
            return self.page.screenshot(full_page=True)
        return self.popup.screenshot(full_page=True)

    def is_logged_in(self) -> bool:
        self.page.goto(f"{BASE_URL}/profile", wait_until="domcontentloaded")
        self.page.wait_for_timeout(1000)
        return not ("/dk?st.cmd=" in self.page.url or "login" in self.page.url)

    def save_session(self) -> Path:
        path = session_path(self.project_id)
        self.context.storage_state(path=str(path))
        return path

    def close(self):
        try:
            if self.browser:
                self.browser.close()
        finally:
            if self._playwright:
                self._playwright.stop()


def has_saved_session(project_id: str) -> bool:
    path = session_path(project_id)
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return bool(data.get("cookies"))
    except (json.JSONDecodeError, OSError):
        return False


def publish_post(project_id: str, text: str, image_paths: list[str], group_url: str | None) -> dict:
    """
    Публикует пост, используя сохранённую сессию. Полностью headless.

    TODO selector: селекторы поля поста/кнопки публикации — ЗАГЛУШКА (как и в
    ok_automation.js), нужна проверка вживую на реальной группе.
    """
    path = session_path(project_id)
    if not path.exists():
        return {"ok": False, "error": "Нет сохранённой сессии ОК — сначала войдите через «Войти в аккаунт»"}

    ensure_chromium_installed()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(storage_state=str(path), viewport={"width": 1280, "height": 900})
        page = context.new_page()
        try:
            page.goto(group_url or f"{BASE_URL}/profile", wait_until="domcontentloaded")

            page.click('a.pf-head_itx_a')
            page.wait_for_timeout(1500)
            page.click('.js-posting-itx[contenteditable="true"]')
            page.fill('.js-posting-itx[contenteditable="true"]', text)

            for img_path in (image_paths or [])[:1]:  # ОК разрешает 1 картинку на пост
                page.set_input_files('input[type="file"]', img_path)
                page.wait_for_timeout(1500)

            page.click('button:has-text("Опубликовать")')
            page.wait_for_timeout(2000)

            context.storage_state(path=str(path))
            return {"ok": True, "status": "Опубликовано"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        finally:
            browser.close()
