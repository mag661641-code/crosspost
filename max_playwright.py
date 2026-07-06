"""
max_playwright.py — вход и публикация в мессенджере Макс через Playwright (headless).
Тот же подход, что и в vk_playwright.py/ok_playwright.py/dzen_playwright.py: скриншот
вместо окна, ввод — обычными полями Streamlit, вызовы через playwright_worker.py.

Реальный флоу входа (проверено вживую, 06.07.2026):
  1. max.ru → кнопка "Открыть веб-версию" → web.max.ru (по умолчанию QR-код) →
     ссылка "Войти по номеру телефона".
  2. Телефон вводится в input[type="text"] (набираем через клавиатуру, не .fill() —
     как и у Яндекс ID, маска ломается иначе), кнопка "Войти".
  3. После этого сайт показывает капчу «Проверяем, что вы не робот» — это отдельный
     iframe (src содержит "not_robot_captcha", хостится на id.vk.ru). Чекбокс
     "Я не робот" внутри фрейма — кликается через frame_locator и проходит (не заблокирован
     для headless в этом случае, проверено вживую).
  4. После капчи — экран из 6 отдельных полей для кода из SMS
     (input[type="text"][inputmode="numeric"], без maxlength) — по одной цифре в каждое.
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

BASE_URL = "https://max.ru"
WEB_URL = "https://web.max.ru"


def session_path(project_id: str) -> Path:
    d = Path(__file__).parent / "users-data" / project_id / "session"
    d.mkdir(parents=True, exist_ok=True)
    return d / "max_storage_state.json"


class MaxLoginFlow:
    def __init__(self, project_id: str):
        self.project_id = project_id
        self._playwright = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None

    def start(self) -> bytes:
        """Открывает Макс, переходит на веб-версию и на форму входа по телефону. Возвращает скриншот."""
        ensure_chromium_installed()
        self._playwright = sync_playwright().start()
        self.browser = self._playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900})
        self.page = self.context.new_page()
        self.page.goto(BASE_URL, wait_until="domcontentloaded")
        self.page.wait_for_timeout(1500)
        self.page.click("text=Открыть веб-версию")
        self.page.wait_for_timeout(2000)
        self.page.click("text=Войти по номеру телефона")
        self.page.wait_for_timeout(1200)
        return self.page.screenshot(full_page=True)

    def submit_phone(self, phone: str) -> bytes:
        """
        Вводит телефон (через клавиатуру — .fill() ломает маску), жмёт «Войти».
        Дальше сайт обычно показывает капчу «Я не робот» — пробуем пройти её сразу же
        (best-effort, не критично, если капчи не будет или она в другом виде).
        """
        digits = "".join(ch for ch in phone if ch.isdigit())
        if digits.startswith("7") or digits.startswith("8"):
            digits = digits[1:]
        self.page.click('input[type="text"]')
        self.page.keyboard.type(digits, delay=40)
        self.page.wait_for_timeout(500)
        self.page.click('button:has-text("Войти")')
        self.page.wait_for_timeout(2000)

        try:
            frame = self.page.frame_locator('iframe[src*="not_robot_captcha"]')
            frame.locator("text=Я не робот").click(timeout=5000)
            self.page.wait_for_timeout(2500)
        except Exception:
            pass  # капчи не было или она другого вида — просто показываем текущий экран

        return self.page.screenshot(full_page=True)

    def submit_code(self, code: str) -> bytes:
        """Вводит код из SMS — 6 отдельных полей по одной цифре в каждое."""
        boxes = self.page.locator('input[type="text"][inputmode="numeric"]')
        count = boxes.count()
        if count > 0 and count >= len(code):
            for i, digit in enumerate(code):
                boxes.nth(i).fill(digit)
        else:
            # Запасной вариант — вдруг один общий инпут
            single_candidates = ['input[inputmode="numeric"]', 'input[type="tel"]', 'input[name="code"]']
            for sel in single_candidates:
                if self.page.locator(sel).count() == 1:
                    self.page.fill(sel, code)
                    break
        self.page.wait_for_timeout(2500)
        return self.page.screenshot(full_page=True)

    def request_new_code(self) -> bytes:
        """Жмёт «Получить новый код» — на случай, если старый код устарел/не пришёл."""
        self.page.click("text=Получить новый код")
        self.page.wait_for_timeout(2000)
        return self.page.screenshot(full_page=True)

    def is_logged_in(self) -> bool:
        self.page.goto(WEB_URL, wait_until="domcontentloaded")
        self.page.wait_for_timeout(1500)
        # После входа веб-версия показывает список чатов на том же домене, без формы входа.
        return self.page.locator('text=Войти по номеру телефона').count() == 0 and \
            self.page.locator('text=Войдите в MAX по QR-коду').count() == 0

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


def publish_post(project_id: str, text: str, image_paths: list[str]) -> dict:
    """
    Публикует сообщение в Максе (личный чат/канал), используя сохранённую сессию.
    Полностью headless. TODO selector: точный чат/канал и селекторы поля ввода —
    ЗАГЛУШКА (как и в max_automation.js), нужна проверка вживую.
    """
    path = session_path(project_id)
    if not path.exists():
        return {"ok": False, "error": "Нет сохранённой сессии Макса — сначала войдите через «Войти в аккаунт»"}

    ensure_chromium_installed()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(storage_state=str(path), viewport={"width": 1280, "height": 900})
        page = context.new_page()
        try:
            page.goto(WEB_URL, wait_until="domcontentloaded")
            page.wait_for_timeout(1500)

            page.click('[data-testid="message-input"]')
            page.fill('[data-testid="message-input"]', text)

            for img_path in (image_paths or [])[:1]:
                page.set_input_files('input[type="file"]', img_path)
                page.wait_for_timeout(1500)

            page.keyboard.press("Enter")
            page.wait_for_timeout(2000)

            context.storage_state(path=str(path))
            return {"ok": True, "status": "Опубликовано"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        finally:
            browser.close()
