#!/usr/bin/env node
/**
 * social-config.js — хранение токенов соцсетей на проект.
 * Файл users-data/{projectId}/social-config.json, по образцу projects-config.json (app.js).
 */

const fs = require('fs');
const path = require('path');

const emptyConfig = () => ({
  telegram: { botToken: '', chatId: '' },
  // ВК логинится вручную кнопкой «Войти в аккаунт» (телефон + SMS-код вводятся
  // прямо в открывшемся окне, храниться нигде не нужно) — публикация через
  // браузерную автоматизацию (API-режим убран, чтобы не путать).
  vk: { groupUrl: '' },
  // ОК логинится так же, как ВК — кнопкой «Войти в аккаунт» (телефон + SMS-код
  // в открывшемся окне, через «Войти через ВК») — публикация через браузерную автоматизацию.
  ok: { groupUrl: '' },
  // Дзен: логин/пароль используются для автоматического повторного входа,
  // groupUrl — ссылка на редактор канала, например https://dzen.ru/profile/editor/inmetprom
  dzen: { login: '', password: '', groupUrl: '' },
  // Макс (мессенджер МАХ) логинится вручную кнопкой «Войти в аккаунт» (телефон + SMS-код
  // в открывшемся окне) — хранить тут нечего, публикация идёт по сохранённой сессии.
  max: {},
});

const getSocialConfigPath = (projectBaseDir) => path.join(projectBaseDir, 'social-config.json');

const loadSocialConfig = (projectBaseDir) => {
  try {
    const fp = getSocialConfigPath(projectBaseDir);
    if (!fs.existsSync(fp)) return emptyConfig();
    const saved = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    // Мержим с пустой схемой — чтобы старые файлы с неполными полями не ломали UI
    const base = emptyConfig();
    for (const platform of Object.keys(base)) {
      if (saved[platform] && typeof saved[platform] === 'object') {
        Object.assign(base[platform], saved[platform]);
      }
    }
    return base;
  } catch {
    return emptyConfig();
  }
};

const saveSocialConfig = (projectBaseDir, data) => {
  const fp = getSocialConfigPath(projectBaseDir);
  const base = emptyConfig();
  for (const platform of Object.keys(base)) {
    if (data && data[platform] && typeof data[platform] === 'object') {
      Object.assign(base[platform], data[platform]);
    }
  }
  fs.writeFileSync(fp, JSON.stringify(base, null, 2), 'utf-8');
  return base;
};

module.exports = { emptyConfig, getSocialConfigPath, loadSocialConfig, saveSocialConfig };
