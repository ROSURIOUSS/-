// Настройки, которые можно менять прямо в приложении (ключ OpenRouter, модель).
// Лежат в data/settings.json рядом с сохранениями: один игрок, один компьютер.
import fs from 'node:fs';
import path from 'node:path';

export function settingsFile() {
  return path.resolve(process.env.LORIA_DATA_DIR || 'data', 'settings.json');
}

export function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveSettings(patch) {
  const next = { ...readSettings(), ...patch, updatedAt: Date.now() };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

/**
 * Ключ и модель, сохранённые в приложении, главнее .env: так игрок может
 * исправить ключ, не редактируя файлы. Вызывается при старте сервера.
 */
export function applySettings() {
  const s = readSettings();
  if (typeof s.apiKey === 'string' && s.apiKey.trim()) process.env.OPENROUTER_API_KEY = s.apiKey.trim();
  if (typeof s.model === 'string' && s.model.trim()) process.env.LORIA_MODEL = s.model.trim();
  return s;
}

export function maskedKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 14) return `${value.slice(0, 4)}…`;
  return `${value.slice(0, 10)}…${value.slice(-4)}`;
}
