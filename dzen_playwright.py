"""
dzen_playwright.py — вход и публикация в Дзен через Playwright (headless), вход через Яндекс ID.
Тот же подход, что и в vk_playwright.py/ok_playwright.py: скриншот вместо окна, ввод —
обычными полями Streamlit, вызовы через playwright_worker.py (постоянный поток).

Реальный флоу входа (проверено вживую, 06.07.2026):
  1. dzen.ru → иконка профиля (справа сверху) → всплывающее меню "Войдите удобным
     способом" — там же есть отдельная кнопка "Войти через Яндекс ID" (кроме входа
     по телефону через VK ID, который используется по умолчанию).
  2. Клик "Войти через Яндекс ID" → переход на passport.yandex.ru — там ДВЕ разные
     формы, зависит от типа аккаунта:
       а) "Введите номер телефона" (Enter your phone number) — консьюмерский UI,
          подтверждено вживую: телефон вводится ЧЕРЕЗ КЛАВИАТУРУ (не .fill() —
          он ломает маску страны), кнопка "Log in" / "Войти".
       б) Логин+пароль (email/логин) — классическая форма passport.yandex.ru,
          такая же используется в publish.js (Яндекс.Бизнес!) — селекторы оттуда
          уже проверены вживую на реальных бизнес-аккаунтах, переиспользованы ниже.
     Далее (в обоих случаях) — пароль или код подтверждения, форма обычно похожая
     на ту же passport-форму (input[type="password"] и т.п.).
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

BASE_URL = "https://dzen.ru"

# Проверенные вживую селекторы Яндекс.Паспорта — те же, что в click/publish.js
# (используются там для входа в Яндекс.Бизнес на реальных бизнес-аккаунтах).
LOGIN_SELECTORS = [
    'input[name="login"]', 'input[data-t="field:input-login"]',
    '#passp-field-login', 'input[type="email"]',
    'input[autocomplete="username"]',
]
PASSWORD_SELECTORS = [
    'input[name="passwd"]', 'input[data-t="field:input-passwd"]',
    '#passp-field-passwd', 'input[type="password"]',
    'input[autocomplete="current-password"]',
]


def session_path(project_id: str) -> Path:
    d = Path(__file__).parent / "users-data" / project_id / "session"
    d.mkdir(parents=True, exist_ok=True)
    return d / "dzen_storage_state.json"


def _click_button_with_exact_text(page: Page, text: str) -> bool:
    """Из publish.js: ищем кнопку с ТОЧНЫМ текстом (не подстрокой) и кликаем по центру."""
    coords = page.evaluate(
        """(text) => {
            const buttons = document.querySelectorAll('button, [role="button"], [type="submit"]');
            for (const btn of buttons) {
                if (btn.textContent.trim() === text) {
                    const r = btn.getBoundingClientRect();
                    if (r.width > 30 && r.height > 15) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                }
            }
            return null;
        }""",
        text,
    )
    if coords:
        page.mouse.click(coords["x"], coords["y"])
        return True
    return False


class DzenLoginFlow:
    def __init__(self, project_id: str):
        self.project_id = project_id
        self._playwright = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None

    def start(self) -> bytes:
        """Открывает Дзен, жмёт иконку профиля → «Войти через Яндекс ID». Возвращает скриншот."""
        ensure_chromium_installed()
        self._playwright = sync_playwright().start()
        self.browser = self._playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900})
        self.page = self.context.new_page()
        self.page.goto(BASE_URL, wait_until="domcontentloaded")
        self.page.wait_for_timeout(1500)
        try:
            self.page.click("text=Понятно", timeout=2000)  # баннер cookie/контент, если есть
        except Exception:
            pass
        self.page.click('[aria-label*="рофил"], [class*="profile"], [class*="Profile"]', timeout=5000)
        self.page.wait_for_timeout(1200)
        self.page.click("text=Войти через Яндекс ID")
        self.page.wait_for_timeout(2000)
        return self.page.screenshot(full_page=True)

    def submit_phone(self, phone: str) -> bytes:
        """
        Консьюмерский UI Яндекс ID (телефон). ВАЖНО: вводим через клавиатуру
        (page.keyboard.type), а не .fill() — .fill() ломает маску номера и страну
        (проверено вживую — с .fill() получалась ошибка "Invalid phone number format").
        """
        digits = "".join(ch for ch in phone if ch.isdigit())
        if digits.startswith("7") or digits.startswith("8"):
            digits = digits[1:]  # код страны вводится отдельно, полем уже выбрана Россия (+7)
        self.page.click('input[type="tel"]')
        self.page.keyboard.type(digits, delay=40)
        self.page.wait_for_timeout(500)
        if not _click_button_with_exact_text(self.page, "Log in") and not _click_button_with_exact_text(self.page, "Войти"):
            self.page.keyboard.press("Enter")
        self.page.wait_for_timeout(2500)
        return self.page.screenshot(full_page=True)

    def submit_login(self, login_value: str) -> bytes:
        """Классическая форма passport.yandex.ru (логин/e-mail) — как в publish.js."""
        for sel in LOGIN_SELECTORS:
            if self.page.locator(sel).count() > 0:
                self.page.click(sel, click_count=3)
                self.page.keyboard.press("Backspace")
                self.page.type(sel, login_value, delay=60)
                break
        if not _click_button_with_exact_text(self.page, "Войти"):
            self.page.keyboard.press("Enter")
        self.page.wait_for_timeout(3000)
        return self.page.screenshot(full_page=True)

    def submit_password(self, password: str) -> bytes:
        for sel in PASSWORD_SELECTORS:
            if self.page.locator(sel).count() > 0:
                self.page.click(sel, click_count=3)
                self.page.type(sel, password, delay=60)
                break
        if not _click_button_with_exact_text(self.page, "Войти") and not _click_button_with_exact_text(self.page, "Log in"):
            self.page.keyboard.press("Enter")
        self.page.wait_for_timeout(3000)
        return self.page.screenshot(full_page=True)

    def submit_code(self, code: str) -> bytes:
        """Код подтверждения (SMS/приложение) — TODO selector, аналогично VK/ОК."""
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
        self.page.goto(f"{BASE_URL}/profile/editor", wait_until="domcontentloaded")
        self.page.wait_for_timeout(1000)
        url = self.page.url
        return "passport" not in url and "/auth" not in url and "pwl-yandex" not in url

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


def publish_post(project_id: str, text: str, image_paths: list[str], pub_type: str = "post") -> dict:
    """
    Публикует пост/статью в Дзен, используя сохранённую сессию. Полностью headless.
    TODO selector: селекторы редактора — ЗАГЛУШКА (как и в dzen_automation.js),
    нужна проверка вживую (кнопка "Опубликовать" пока не подтверждена).
    """
    path = session_path(project_id)
    if not path.exists():
        return {"ok": False, "error": "Нет сохранённой сессии Дзена — сначала войдите через «Войти в аккаунт»"}

    ensure_chromium_installed()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(storage_state=str(path), viewport={"width": 1280, "height": 900})
        page = context.new_page()
        try:
            page.goto(f"{BASE_URL}/profile/editor", wait_until="domcontentloaded")
            lines = (text or "").split("\n", 1)
            title = lines[0]
            body = lines[1] if len(lines) > 1 else ""

            page.fill('[data-testid="title-input"]', title)
            page.fill('[data-testid="body-input"]', body)

            for img_path in (image_paths or [])[:1]:
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
