"""
playwright_worker.py — постоянный фоновый поток для работы с Playwright (sync API) из Streamlit.

Почему это нужно: Streamlit выполняет каждую перерисовку страницы в НОВОМ потоке
(это не то же самое, что "поток сессии" — он не гарантированно один и тот же между
перерисовками). Playwright sync API привязывает браузер к конкретному потоку через
greenlet — если вызвать метод из другого потока, чем тот, где был запущен браузер,
падает `greenlet.error: cannot switch to a different thread`.

Решение: держим один настоящий, никогда не завершающийся поток (создаётся один раз,
хранится в st.session_state) — все операции с браузером (открыть страницу, кликнуть,
заполнить поле) отправляются в этот поток через очередь команд и ждут результата.
Сам объект-обёртку (Worker) можно спокойно хранить/читать из любого потока — трогать
из чужого потока нельзя только то, что происходит ВНУТРИ него (сам браузер/страница).
"""

from __future__ import annotations

import queue
import threading
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class _Job:
    func: Callable
    args: tuple
    kwargs: dict
    result_q: "queue.Queue[tuple[bool, Any]]" = field(default_factory=queue.Queue)


class PlaywrightWorker:
    def __init__(self):
        self._jobs: "queue.Queue[_Job | None]" = queue.Queue()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        while True:
            job = self._jobs.get()
            if job is None:
                break
            try:
                result = job.func(*job.args, **job.kwargs)
                job.result_q.put((True, result))
            except Exception as e:  # noqa: BLE001 — пробрасываем в вызывающий поток как есть
                job.result_q.put((False, e))

    def call(self, func: Callable, *args, **kwargs) -> Any:
        """Выполняет func(*args, **kwargs) в фоновом потоке воркера, ждёт и возвращает результат."""
        job = _Job(func, args, kwargs)
        self._jobs.put(job)
        ok, value = job.result_q.get()
        if not ok:
            raise value
        return value

    def stop(self):
        self._jobs.put(None)
