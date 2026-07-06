"""
browser_setup.py — автоустановка Chromium для Playwright на Streamlit Cloud.

На Cloud (и вообще в свежем окружении) браузер для Playwright заранее не
установлен — там нет шага "postinstall", который есть локально (npm install
и т.п. просто ставит зависимости из requirements.txt, а сам браузер нужно
скачать отдельно). Проверяем при первом запуске и ставим, если его нет.
Тот же паттерн, что уже проверен и работает в click/yb_playwright.py.
"""

import subprocess
import sys

from playwright.sync_api import sync_playwright

_checked = False


def ensure_chromium_installed():
    global _checked
    if _checked:
        return
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            browser.close()
    except Exception:
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium"], check=False)
    _checked = True
