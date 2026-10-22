// Конфигурация, общая для веба и Telegram-бота.
import { loadEnv } from './env.js';

// .env читается до первого обращения к process.env в любом модуле.
loadEnv();

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '0.0.0.0';

export const HOSTED_URL = process.env.LORIA_PUBLIC_URL || '';

export function demoMode(aiAvailable) {
  const raw = (process.env.LORIA_DEMO || 'auto').toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return !aiAvailable;
}

export const DAILY_LIMIT = Number(process.env.LORIA_DAILY_REQUESTS || 200);
export const ENABLE_AI_AUDIT = process.env.LORIA_AI_AUDIT === '1';
export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ENABLED = Boolean(TELEGRAM_TOKEN);
export const ADMIN_CHAT_ID = process.env.LORIA_ADMIN_CHAT_ID || '';
// Публичная регистрация: если ноль — создавать истории может кто угодно (локальный режим).
export const MAX_CREATES_PER_HOUR = Number(process.env.LORIA_MAX_CREATES_PER_HOUR || 40);
