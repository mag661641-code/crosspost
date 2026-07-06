"""
vk_playwright.py — вход и публикация в VK через Playwright (headless), без Node/Puppeteer/VNC.

Идея: браузер работает в headless-режиме (без монитора — подходит для Streamlit Cloud).
Для входа человеку всё равно нужно "увидеть" страницу — вместо реального окна мы делаем
скриншот и показываем его в Streamlit, а ввод (телефон/пароль/код) идёт через обычные
текстовые поля Streamlit. После успешного входа сессия (cookies) сохраняется в файл
(storage_state) — при следующих запусках вход не нужен.

Реальный флоу входа ВК (проверено вживую, 06.07.2026):
  1. vk.com/login → по умолчанию QR-код, жмём "Войти другим способом" → форма телефона.
  2. Вводим телефон (input[name="login"][type="tel"]) → "Войти" → ведёт на id.vk.com.
  3. Там сначала просят ПАРОЛЬ (input[name="password"]) — если он есть у аккаунта.
     - Если пароль известен: вводим, жмём "Продолжить" → готово (или ещё один шаг проверки).
     - Если пароля нет/не помним: жмём "Забыли или не установили пароль?" →
       во всплывающем окне жмём "Нет, восстановить пароль" → попадаем на форму
       восстановления с уже подставленным телефоном → жмём "Отправить код" →
       ВК шлёт SMS. Точный селектор поля для самого кода не проверен вживую
       (нужен реальный номер с SMS) — помечено TODO ниже, поправить по первому
       реальному прогону, как и остальные TODO-селекторы в vk_automation.js.

Ограничение Streamlit Cloud: файловая система не постоянна между перезапусками
контейнера — после входа стоит сохранить содержимое storage_state.json во внешнее
хранилище (секреты/облако), а не полагаться только на локальный диск.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright, Browser, BrowserContext, Page

from browser_setup import ensure_chromium_installed

# На Windows Streamlit (через Tornado) переключает asyncio на SelectorEventLoop,
# а Playwright для запуска браузера как отдельного процесса требует ProactorEventLoop
# (только он поддерживает subprocess_exec) — без этого падает с NotImplementedError.
# Переключаем политику явно перед стартом Playwright.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

BASE_URL = "https://vk.com"


def session_path(project_id: str) -> Path:
    d = Path(__file__).parent / "users-data" / project_id / "session"
    d.mkdir(parents=True, exist_ok=True)
    return d / "vk_storage_state.json"


class VkLoginFlow:
    """
    Пошаговый вход в VK, управляемый снаружи (из Streamlit) — один шаг за один
    вызов метода, между вызовами объект живёт в st.session_state текущей сессии.
    """

    def __init__(self, project_id: str):
        self.project_id = project_id
        self._playwright = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None

    def start(self) -> bytes:
        """Открывает браузер, идёт на форму входа по телефону. Возвращает скриншот."""
        ensure_chromium_installed()
        self._playwright = sync_playwright().start()
        self.browser = self._playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900})
        self.page = self.context.new_page()
        self.page.goto(f"{BASE_URL}/login", wait_until="networkidle")
        self.page.wait_for_timeout(800)
        # По умолчанию VK показывает вход по QR — переключаемся на телефон/пароль.
        try:
            self.page.click("text=Войти другим способом", timeout=5000)
            self.page.wait_for_timeout(800)
        except Exception:
            pass  # если кнопки нет — вероятно, уже нужная форма
        return self.page.screenshot(full_page=True)

    def submit_phone(self, phone: str) -> bytes:
        """Вводит телефон, жмёт "Войти". Обычно ведёт на экран запроса пароля."""
        self.page.fill('input[name="login"][type="tel"]', phone)
        self.page.click('button:has-text("Войти")')
        self.page.wait_for_timeout(2500)
        return self.page.screenshot(full_page=True)

    def submit_password(self, password: str) -> bytes:
        """Вводит пароль от VK ID (если он у аккаунта есть)."""
        self.page.fill('input[name="password"]', password)
        self.page.click('button:has-text("Продолжить")')
        self.page.wait_for_timeout(2500)
        return self.page.screenshot(full_page=True)

    def request_sms_instead(self) -> bytes:
        """
        Альтернативная ветка: если пароля нет/не помним — идём по пути восстановления
        через SMS-код вместо пароля.
        """
        self.page.click("text=Забыли или не установили пароль?")
        self.page.wait_for_timeout(1200)
        try:
            self.page.click("text=Нет, восстановить пароль", timeout=4000)
            self.page.wait_for_timeout(1000)
        except Exception:
            pass
        self.page.click('button:has-text("Отправить код")')
        self.page.wait_for_timeout(2000)
        return self.page.screenshot(full_page=True)

    def submit_code(self, code: str) -> bytes:
        """
        Вводит код подтверждения (SMS или из Макса). TODO selector: точнее будет
        проверено по мере реальных прогонов — здесь несколько распространённых
        вариантов на выбор:
          1) одно поле ввода кода целиком (numeric/tel/name="code"),
          2) несколько полей по одной цифре в каждом (частый паттерн для кодов).
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

        # Вариант с несколькими полями по одной цифре — заполняем по порядку.
        digit_boxes = self.page.locator('input[maxlength="1"]')
        if digit_boxes.count() >= len(code):
            for i, digit in enumerate(code):
                digit_boxes.nth(i).fill(digit)
            self.page.wait_for_timeout(2500)
            return self.page.screenshot(full_page=True)

        self.page.wait_for_timeout(500)
        return self.page.screenshot(full_page=True)

    def is_logged_in(self) -> bool:
        self.page.goto(f"{BASE_URL}/feed", wait_until="domcontentloaded")
        return "login" not in self.page.url and "id.vk.com" not in self.page.url

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
    Публикует пост на стену группы/страницы, используя сохранённую сессию.
    Полностью headless, без участия человека. Требует has_saved_session() == True.

    TODO selector: селекторы поля поста/кнопки публикации ниже — ЗАГЛУШКА (как и в
    vk_automation.js), нужна проверка вживую на реальной стене группы.
    """
    path = session_path(project_id)
    if not path.exists():
        return {"ok": False, "error": "Нет сохранённой сессии VK — сначала войдите через «Войти в аккаунт»"}

    ensure_chromium_installed()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(storage_state=str(path), viewport={"width": 1280, "height": 900})
        page = context.new_page()
        try:
            page.goto(group_url or f"{BASE_URL}/feed", wait_until="domcontentloaded")

            page.click('[data-testid="post-input"]')
            page.fill('[data-testid="post-input"]', text)

            for img_path in (image_paths or [])[:10]:
                page.set_input_files('input[type="file"]', img_path)
                page.wait_for_timeout(1500)

            page.click('button:has-text("Опубликовать")')
            page.wait_for_timeout(2000)

            context.storage_state(path=str(path))  # обновляем сессию (куки могли обновиться)
            return {"ok": True, "status": "Опубликовано"}
        except Exception as e:  # noqa: BLE001 — единая точка возврата ошибки в UI
            return {"ok": False, "error": str(e)}
        finally:
            browser.close()
