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

from browser_setup import ensure_firefox_installed, launch_firefox

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

BASE_URL = "https://dzen.ru"

# Записаны через playwright codegen (07.07.2026) — тот же виджет Яндекс ID,
# что и в click/yb_playwright.py: телефон-экран → «Другой способ входа» →
# «Войти по логину» → общее поле логина/пароля/кода → 2 экрана-заглушки.
OTHER_METHOD_BUTTON = '[data-testid="split-add-user-more-button"]'
SWITCH_TO_LOGIN_OPTION = '[data-testid="menu-option-switchToLogin"]'
GENERIC_TEXT_FIELD = '[data-testid="text-field-input"]'
LOGIN_NEXT_BUTTON = '[data-testid="split-add-user-next-login"]'
PASSWORD_NEXT_BUTTON = '[data-testid="password-next"]'
EMAIL_CODE_NEXT_BUTTON = '[data-testid="challenges-email-code-next"]'
POST_LOGIN_SKIP_BUTTONS = [
    '[data-testid="webauthn-reg-later-button"]',
    '[data-testid="identification-promo-start-skip-btn"]',
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
        ensure_firefox_installed()
        self._playwright = sync_playwright().start()
        self.browser = launch_firefox(self._playwright)
        self.context = self.browser.new_context(viewport={"width": 1280, "height": 900})
        self.page = self.context.new_page()
        self.page.goto(BASE_URL, wait_until="domcontentloaded")
        self.page.wait_for_timeout(1500)
        self.page.click('[aria-label*="рофил"], [class*="profile"], [class*="Profile"]', timeout=5000)
        self.page.wait_for_timeout(1200)
        self.page.click("text=Войти через Яндекс ID")
        self.page.wait_for_timeout(1500)
        # Дальше — тот же виджет Яндекс ID, что и в click/yb_playwright.py:
        # закрываем баннер cookie (если есть) и переключаемся на вход по логину.
        self._dismiss_cookie_banner()
        self._switch_to_login_by_password()
        return self.page.screenshot(full_page=True)

    def _dismiss_cookie_banner(self):
        names = ["Allow all", "Принять все", "Accept all", "Разрешить все"]
        for _ in range(3):
            for frame in self.page.frames:
                for name in names:
                    try:
                        btn = frame.get_by_role("button", name=name, exact=True)
                        if btn.count() > 0:
                            btn.first.click(timeout=1500, force=True)
                            self.page.wait_for_timeout(400)
                            return
                    except Exception:
                        continue
            self.page.wait_for_timeout(500)

    def _switch_to_login_by_password(self):
        if self.page.locator(OTHER_METHOD_BUTTON).count() > 0:
            self.page.click(OTHER_METHOD_BUTTON)
            self.page.wait_for_timeout(600)
        if self.page.locator(SWITCH_TO_LOGIN_OPTION).count() > 0:
            self.page.click(SWITCH_TO_LOGIN_OPTION)
            self.page.wait_for_timeout(800)

    def _skip_post_login_prompts(self):
        for sel in POST_LOGIN_SKIP_BUTTONS:
            if self.page.locator(sel).count() > 0:
                self.page.click(sel)
                self.page.wait_for_timeout(800)

    def _submit_generic_field(self, value: str, next_button_selector: str):
        field = self.page.locator(f"{GENERIC_TEXT_FIELD}:visible").first
        field.click()
        field.fill("")
        field.type(value, delay=40)
        self._dismiss_cookie_banner()
        self.page.wait_for_timeout(400)
        field.press("Enter")
        self.page.wait_for_timeout(1200)
        if self.page.locator(next_button_selector).count() > 0:
            try:
                self.page.click(next_button_selector, timeout=3000)
            except Exception:
                pass
            self.page.wait_for_timeout(1200)
        _click_button_with_exact_text(self.page, "Next") or _click_button_with_exact_text(self.page, "Продолжить")
        self.page.wait_for_timeout(1500)

    def submit_phone(self, phone: str) -> bytes:
        """
        Резервный путь, если открылся именно телефонный экран. ВАЖНО: вводим
        через клавиатуру (page.keyboard.type), а не .fill() — иначе ломается
        маска номера/страна.
        """
        digits = "".join(ch for ch in phone if ch.isdigit())
        if digits.startswith("7") or digits.startswith("8"):
            digits = digits[1:]
        self.page.click('input[type="tel"]')
        self.page.keyboard.type(digits, delay=40)
        self.page.wait_for_timeout(500)
        if not _click_button_with_exact_text(self.page, "Log in") and not _click_button_with_exact_text(self.page, "Войти"):
            self.page.keyboard.press("Enter")
        self.page.wait_for_timeout(2500)
        return self.page.screenshot(full_page=True)

    def submit_login(self, login_value: str) -> bytes:
        self._submit_generic_field(login_value, LOGIN_NEXT_BUTTON)
        return self.page.screenshot(full_page=True)

    def submit_password(self, password: str) -> bytes:
        self._submit_generic_field(password, PASSWORD_NEXT_BUTTON)
        self._skip_post_login_prompts()
        return self.page.screenshot(full_page=True)

    def submit_code(self, code: str) -> bytes:
        """Код подтверждения с почты — то же общее поле + отдельная кнопка (как в Яндекс.Бизнесе)."""
        self._submit_generic_field(code, EMAIL_CODE_NEXT_BUTTON)
        self._skip_post_login_prompts()
        return self.page.screenshot(full_page=True)

    def is_logged_in(self) -> bool:
        """
        Не переходим на другую страницу, пока виден незавершённый шаг проверки
        (поле логина/пароля/кода) — иначе сам переход может обнулить проверку
        (см. такой же баг в click/yb_playwright.py). Проверяем прямо на месте:
        если виджет входа исчез — значит вход прошёл.
        """
        if self.page.locator(EMAIL_CODE_NEXT_BUTTON).count() > 0:
            return False
        if self.page.locator(f"{GENERIC_TEXT_FIELD}:visible").count() > 0:
            return False
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
    Публикует статью в Дзен (Студия), используя сохранённую сессию. Полностью headless.

    Реальный путь записан через playwright codegen (07.07.2026) на канале
    stalmetural: dzen.ru → значок профиля → «Студия» (открывается в НОВОЙ
    вкладке dzen.ru/profile/editor/{канал}) → кнопка «Добавить публикацию» →
    «Написать статью» → редактор на Draft.js: первый .public-DraftStyleDefault-block
    в блоке .zen-editor-block — заголовок, дальше идёт .public-DraftStyleDefault-block
    внутри .zen-editor-block — тело текста → кнопка «Опубликовать» (точный текст).
    """
    path = session_path(project_id)
    if not path.exists():
        return {"ok": False, "error": "Нет сохранённой сессии Дзена — сначала войдите через «Войти в аккаунт»"}

    ensure_firefox_installed()
    with sync_playwright() as p:
        browser = launch_firefox(p)
        context = browser.new_context(storage_state=str(path), viewport={"width": 1280, "height": 900})
        page = context.new_page()
        try:
            lines = (text or "").split("\n", 1)
            title = lines[0]
            body = lines[1] if len(lines) > 1 else ""

            # Прямой переход на /profile/editor даёт 404 — URL студии содержит
            # имя канала (/profile/editor/{канал}), которое мы не знаем заранее.
            # Вместо этого идём тем же путём, что и человек: значок профиля → «Студия»
            # (открывается в новой вкладке).
            page.goto(BASE_URL, wait_until="domcontentloaded")
            page.wait_for_timeout(2000)
            page.locator('[data-testid="profile-menu-wrapper"] button').first.click()
            page.wait_for_timeout(500)
            with context.expect_page() as popup_info:
                page.click('[data-testid="profile-menu-studio-button"]')
            studio = popup_info.value
            studio.wait_for_load_state("domcontentloaded")
            studio.wait_for_timeout(2000)

            # Возможный приветственный попап при первом открытии студии — не критично, если его нет.
            close_btn = studio.locator('[data-testid="close-button"]').first
            if close_btn.count() > 0:
                close_btn.click()
                studio.wait_for_timeout(500)

            if not _click_button_with_exact_text(studio, "Добавить публикацию"):
                return {"ok": False, "error": "Кнопка «Добавить публикацию» не найдена — проверьте, что канал открылся"}
            studio.wait_for_timeout(800)

            if not _click_button_with_exact_text(studio, "Написать статью"):
                return {"ok": False, "error": "Кнопка «Написать статью» не найдена"}
            studio.wait_for_timeout(1500)

            # Заголовок — первый блок редактора Draft.js.
            blocks = studio.locator(".zen-editor-block .public-DraftStyleDefault-block")
            blocks.first.click()
            studio.keyboard.type(title, delay=10)

            # Тело — следующий блок (Enter переходит в него, как обычный человек).
            if body.strip():
                studio.keyboard.press("Enter")
                studio.keyboard.type(body, delay=0)

            for img_path in (image_paths or [])[:1]:
                file_input = studio.locator('input[type="file"]').first
                if file_input.count() > 0:
                    file_input.set_input_files(img_path)
                    studio.wait_for_timeout(2000)

            studio.wait_for_timeout(1000)
            if not _click_button_with_exact_text(studio, "Опубликовать"):
                return {"ok": False, "error": "Кнопка «Опубликовать» не найдена"}
            studio.wait_for_timeout(2500)

            context.storage_state(path=str(path))
            return {"ok": True, "status": "Опубликовано"}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        finally:
            browser.close()
