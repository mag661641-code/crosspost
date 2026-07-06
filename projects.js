// projects.js — независимый список проектов Crosspost.
// Не связан с проектами Click (ЯБ): свой файл, свои сессии, свой процесс.
// Пароли те же самые (для удобства входа тем же пользователям), но
// проверяются полностью отдельным кодом — никаких общих модулей с click/.

const crypto = require('crypto');

const hashPassword = (password, salt) => crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
const verifyPassword = (password, salt, expectedHash) => hashPassword(password, salt) === expectedHash;

const SALT = 'crosspost-salt-v1-2026';
const _hash = (pw) => hashPassword(pw, SALT);

const PROJECTS = [
  { id: 'SMU', name: 'СМУ', fullName: 'Стальметгрупп', color: '#3b82f6', icon: '🏗', passwordHash: _hash('1501') },
  { id: 'IMP', name: 'ИМП', fullName: 'Инметпром', color: '#10b981', icon: '🔩', passwordHash: _hash('2205') },
  { id: 'MPE', name: 'МПЭ', fullName: 'МетПромЭнерго', color: '#f59e0b', icon: '⚡', passwordHash: _hash('1101') },
];

// ─── СЕССИИ ─────────────────────────────────────────────────────
const sessions = new Map(); // sessionId -> { projectId, createdAt, lastSeen }
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 дней

const createSession = (projectId) => {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { projectId, createdAt: Date.now(), lastSeen: Date.now() });
  return sid;
};
const validateSession = (sid) => {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL) { sessions.delete(sid); return null; }
  s.lastSeen = Date.now();
  return s.projectId;
};
const destroySession = (sid) => { sessions.delete(sid); };

const listProjectsPublic = () => PROJECTS.map(p => ({ id: p.id, name: p.name, fullName: p.fullName, color: p.color, icon: p.icon }));
const getProject = (projectId) => PROJECTS.find(p => p.id === projectId) || null;
const getProjectPublic = (projectId) => {
  const p = getProject(projectId);
  if (!p) return null;
  return { id: p.id, name: p.name, fullName: p.fullName, color: p.color, icon: p.icon };
};

const loginProject = (projectId, password) => {
  const p = getProject(projectId);
  if (!p) return { error: 'Проект не найден' };
  if (!verifyPassword(password || '', SALT, p.passwordHash)) return { error: 'Неверный пароль' };
  const sid = createSession(p.id);
  return { ok: true, sessionId: sid, project: { id: p.id, name: p.name, fullName: p.fullName } };
};

const projectDir = (projectId) => projectId.replace(/[^A-Za-z0-9_-]/g, '_');

module.exports = {
  listProjectsPublic, getProject, getProjectPublic,
  loginProject, validateSession, destroySession, projectDir,
};
