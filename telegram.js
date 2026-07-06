#!/usr/bin/env node
/**
 * telegram.js — публикация поста в Telegram через Bot API.
 * publishToPost({post, config}) — принимает объект поста и конфиг { botToken, chatId }.
 */

const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const API_BASE = 'https://api.telegram.org';

// Возвращает true/false — валидны ли botToken/chatId (используется /api/social/test).
const checkConnection = async ({ botToken, chatId }) => {
  const r = await axios.get(`${API_BASE}/bot${botToken}/getMe`, { timeout: 10000 });
  if (!r.data || !r.data.ok) throw new Error('Неверный botToken');
  if (chatId) {
    const chat = await axios.get(`${API_BASE}/bot${botToken}/getChat`, {
      params: { chat_id: chatId },
      timeout: 10000,
    });
    if (!chat.data || !chat.data.ok) throw new Error('Бот не может получить доступ к chatId (не добавлен в канал/чат?)');
  }
  return true;
};

/**
 * publishToTelegram({botToken, chatId}, {text, imagePaths})
 * imagePaths — массив абсолютных путей к локальным файлам изображений (до 10 шт).
 * Одно изображение → sendPhoto (caption). Несколько → sendMediaGroup.
 * Возвращает { ok: true, result } или { ok: false, error }.
 */
const publishToTelegram = async ({ botToken, chatId }, { text, imagePaths }) => {
  try {
    if (!botToken || !chatId) return { ok: false, error: 'Не указаны botToken/chatId' };
    const images = (imagePaths || []).slice(0, 10);

    if (images.length === 0) {
      const r = await axios.post(`${API_BASE}/bot${botToken}/sendMessage`, {
        chat_id: chatId,
        text: text || '',
        parse_mode: 'HTML',
      }, { timeout: 30000 });
      if (!r.data.ok) return { ok: false, error: r.data.description || 'Ошибка sendMessage' };
      return { ok: true, result: r.data.result };
    }

    if (images.length === 1) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', text || '');
      form.append('parse_mode', 'HTML');
      form.append('photo', fs.createReadStream(images[0]));
      const r = await axios.post(`${API_BASE}/bot${botToken}/sendPhoto`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 60000,
      });
      if (!r.data.ok) return { ok: false, error: r.data.description || 'Ошибка sendPhoto' };
      return { ok: true, result: r.data.result };
    }

    // Несколько изображений — sendMediaGroup, caption только на первом элементе
    const form = new FormData();
    form.append('chat_id', chatId);
    const media = images.map((_, i) => {
      const item = { type: 'photo', media: `attach://photo${i}` };
      if (i === 0) { item.caption = text || ''; item.parse_mode = 'HTML'; }
      return item;
    });
    form.append('media', JSON.stringify(media));
    images.forEach((imgPath, i) => form.append(`photo${i}`, fs.createReadStream(imgPath)));

    const r = await axios.post(`${API_BASE}/bot${botToken}/sendMediaGroup`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000,
    });
    if (!r.data.ok) return { ok: false, error: r.data.description || 'Ошибка sendMediaGroup' };
    return { ok: true, result: r.data.result };
  } catch (e) {
    const apiError = e.response && e.response.data && e.response.data.description;
    return { ok: false, error: apiError || e.message };
  }
};

module.exports = { publishToTelegram, checkConnection };
