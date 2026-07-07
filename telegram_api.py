"""
telegram_api.py — публикация в Telegram напрямую через Bot API.

В отличие от ВК/ОК/Дзен/Макс, Telegram не требует входа через браузер —
публикация делается обычным HTTP-запросом к api.telegram.org с токеном
бота. Поэтому здесь нет ни Playwright, ни Node — только requests.
"""

from pathlib import Path
import json

import requests

API_BASE = "https://api.telegram.org"


def config_path(project_id: str) -> Path:
    d = Path(__file__).parent / "users-data" / project_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "telegram_config.json"


def load_config(project_id: str) -> dict:
    path = config_path(project_id)
    if not path.exists():
        return {"botToken": "", "chatId": ""}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"botToken": "", "chatId": ""}


def save_config(project_id: str, bot_token: str, chat_id: str) -> None:
    config_path(project_id).write_text(
        json.dumps({"botToken": bot_token, "chatId": chat_id}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _api_call(bot_token: str, method: str, **kwargs) -> dict:
    try:
        res = requests.post(f"{API_BASE}/bot{bot_token}/{method}", timeout=30, **kwargs)
        data = res.json()
    except requests.exceptions.RequestException as e:
        return {"ok": False, "error": str(e)}
    if not data.get("ok"):
        return {"ok": False, "error": data.get("description", "Неизвестная ошибка Telegram API")}
    return {"ok": True, "result": data.get("result")}


def send_text(bot_token: str, chat_id: str, text: str) -> dict:
    return _api_call(bot_token, "sendMessage", data={"chat_id": chat_id, "text": text})


def send_photo(bot_token: str, chat_id: str, image_path: str, caption: str = "") -> dict:
    with open(image_path, "rb") as f:
        return _api_call(
            bot_token, "sendPhoto",
            data={"chat_id": chat_id, "caption": caption},
            files={"photo": f},
        )


def publish_post(project_id: str, text: str, image_paths: list[str]) -> dict:
    """Единая точка публикации — как publish_post() у остальных площадок."""
    config = load_config(project_id)
    bot_token, chat_id = config.get("botToken", ""), config.get("chatId", "")
    if not bot_token or not chat_id:
        return {"ok": False, "error": "Не заполнены Bot Token / Chat ID"}

    if image_paths:
        result = send_photo(bot_token, chat_id, image_paths[0], caption=text or "")
    else:
        result = send_text(bot_token, chat_id, text or "")

    if not result.get("ok"):
        return {"ok": False, "error": result.get("error", "Ошибка публикации")}
    return {"ok": True, "status": "Опубликовано"}
