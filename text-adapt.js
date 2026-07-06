#!/usr/bin/env node
/**
 * text-adapt.js — авто-адаптация текста поста под требования каждой площадки.
 *
 * Единый синтаксис ввода (пишете один раз в тексте поста для соцсетей):
 *   [текст ссылки](https://example.com)
 *
 * Что происходит на выходе, по площадкам:
 *   Telegram — ПОЛНАЯ поддержка анкоров: <a href="...">текст</a> (parse_mode HTML).
 *              Заодно экранирует случайные &, <, > в остальном тексте — без этого
 *              Telegram может отклонить сообщение как "can't parse entities".
 *   VK (API) — экспериментальная разметка ссылок VK: [url|текст]. ⚠️ Не проверено
 *              вживую на реальной стене — если VK не отрисует это как анкор для
 *              внешних доменов, переключитесь на площадку ниже (VK-браузер тоже
 *              использует "текст: url", это безопасный вариант).
 *   Всё остальное (ВК-браузер, ОК, Дзен, Макс) — анкорный текст платформой не
 *              поддерживается: [текст](url) превращается в "текст: url", сама
 *              ссылка остаётся кликабельной как обычный URL-текст.
 *
 * Ручная донастройка: если авто-адаптация не подошла для конкретной площадки —
 * просто отредактируйте исходный текст (уберите/поменяйте разметку [текст](url))
 * и посмотрите превью на странице «Публикация» перед отправкой.
 */

const ANCHOR_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// Telegram: [текст](url) -> <a href="url">текст</a>; весь остальной текст экранируется.
const adaptForTelegram = (text) => {
  let result = '';
  let lastIndex = 0;
  let m;
  const re = new RegExp(ANCHOR_RE);
  while ((m = re.exec(text)) !== null) {
    result += escapeHtml(text.slice(lastIndex, m.index));
    result += `<a href="${escapeHtml(m[2])}">${escapeHtml(m[1])}</a>`;
    lastIndex = m.index + m[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
};

// VK API: [текст](url) -> [url|текст] (официальная разметка ссылок VK для message).
const adaptForVk = (text) => String(text).replace(new RegExp(ANCHOR_RE), (_, label, url) => `[${url}|${label}]`);

// Площадки без поддержки анкоров: [текст](url) -> "текст: url".
const adaptPlain = (text) => String(text).replace(new RegExp(ANCHOR_RE), (_, label, url) => `${label}: ${url}`);

/**
 * adaptTextForPlatform(text, mode)
 * mode: 'telegram' | 'vk' | 'plain'
 */
const adaptTextForPlatform = (text, mode) => {
  const t = text || '';
  if (mode === 'telegram') return adaptForTelegram(t);
  if (mode === 'vk') return adaptForVk(t);
  return adaptPlain(t);
};

module.exports = { adaptTextForPlatform, adaptForTelegram, adaptForVk, adaptPlain, ANCHOR_RE };
