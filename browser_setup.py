"""
browser_setup.py — автоустановка браузера для Playwright на Streamlit Cloud.

На Cloud (и вообще в свежем окружении) браузер для Playwright заранее не
установлен — там нет шага "postinstall", который есть локально (npm install
и т.п. просто ставит зависимости из requirements.txt, а сам браузер нужно
скачать отдельно). Проверяем при первом запуске и ставим, если его нет.

Firefox, а не Chromium: в click/ headless Chromium стабильно падал
(TargetClosedError) на бесплатном тарифе Streamlit Cloud (~1ГБ RAM) —
похоже на нехватку памяти при рендере тяжёлых страниц. Firefox headless
заметно легче. Используем его и здесь по той же причине.
"""

import subprocess
import sys

from playwright.sync_api import sync_playwright

_chromium_checked = False
_firefox_checked = False


def ensure_chromium_installed():
    global _chromium_checked
    if _chromium_checked:
        return
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            browser.close()
    except Exception:
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=False)
    _chromium_checked = True


def ensure_firefox_installed():
    global _firefox_checked
    if _firefox_checked:
        return
    try:
        with sync_playwright() as p:
            browser = p.firefox.launch(headless=True)
            browser.close()
    except Exception:
        subprocess.run([sys.executable, "-m", "playwright", "install", "firefox"], check=False)
    _firefox_checked = True


def launch_firefox(p, headless: bool = True):
    return p.firefox.launch(headless=headless)
