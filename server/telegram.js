// Telegram-бот на том же движке, что и веб. Длинный polling, без зависимостей.
// Запуск: TELEGRAM_BOT_TOKEN=... npm run bot
import fs from 'node:fs/promises';
import path from 'node:path';

import { TELEGRAM_TOKEN, HOSTED_URL } from './config.js';

const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
import { PRESETS, ARCHETYPES, DIFFICULTIES } from './worlds.js';
import { loadGame, exportMarkdown } from './store.js';
import { startNewGame, runTurn, sanitizeAction, noteCheatAttempt, DEMO_MODE } from './engine.js';
import { publicState } from './state.js';
import { aiAudit } from './auditor.js';
import { aiAvailable } from './ai.js';

const API = () => `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const SESSIONS_FILE = path.resolve('data', 'telegram.json');

const sessions = new Map();
const locks = new Set();
const cooldown = new Map();
let me = null;
let running = false;
let offset = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- транспорт ----------

async function tg(method, params = {}, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(method === 'getUpdates' ? 45000 : 25000)
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok) return data.result;
      if (data.error_code === 429 && attempt < retries) {
        const wait = Number(data?.parameters?.retry_after || 2) * 1000;
        await sleep(Math.min(wait, 8000));
        continue;
      }
      if (data.error_code >= 500 && attempt < retries) {
        await sleep(1200);
        continue;
      }
      if (data.description && !/message is not modified/i.test(data.description)) {
        console.error(`[tg] ${method}:`, data.description);
      }
      return null;
    } catch (err) {
      if (attempt >= retries) {
        console.error(`[tg] ${method} сеть:`, err?.message);
        return null;
      }
      await sleep(1000 + attempt * 1500);
    }
  }
}

async function send(chatId, html, keyboard) {
  return tg('sendMessage', {
    chat_id: chatId,
    text: html.slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
}

/** Фото с подписью; если Telegram не смог — отправляем текстом. */
async function sendPhoto(chatId, photoPath, caption, keyboard) {
  const photo = `${HOSTED_URL || ''}${photoPath}`;
  const ok = HOSTED_URL
    ? await tg('sendPhoto', {
        chat_id: chatId,
        photo,
        caption: caption.slice(0, 1024),
        parse_mode: 'HTML',
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
      })
    : null;
  if (ok) return ok;
  return send(chatId, caption, keyboard);
}

/** Длинный текст несколькими сообщениями (лимит Telegram — 4096 символов). */
async function sendLong(chatId, html, keyboard) {
  if (html.length <= 4000) return send(chatId, html, keyboard);
  const parts = [];
  let rest = html;
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf('\n\n', 3900);
    if (cut < 1500) cut = rest.lastIndexOf('. ', 3900);
    if (cut < 1500) cut = 3900;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  parts.push(rest);
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.length > 1 ? `\n\n<i>(${i + 1}/${parts.length})</i>` : '';
    last = await send(chatId, parts[i] + suffix, i === parts.length - 1 ? keyboard : undefined);
  }
  return last;
}

// ---------- сессии ----------

async function loadSessions() {
  try {
    const raw = await fs.readFile(SESSIONS_FILE, 'utf8');
    for (const [chatId, value] of Object.entries(JSON.parse(raw))) sessions.set(chatId, value);
  } catch {
    /* первый запуск */
  }
}

async function saveSessions() {
  try {
    await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true });
    const obj = Object.fromEntries(sessions.entries());
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('[tg] сессии не сохранены:', err?.message);
  }
}

function session(chatId) {
  const key = String(chatId);
  if (!sessions.has(key)) sessions.set(key, {});
  return sessions.get(key);
}

async function setSession(chatId, patch) {
  const s = session(chatId);
  Object.assign(s, patch);
  await saveSessions();
  return s;
}

// ---------- клавиатуры ----------

function worldsKeyboard() {
  const rows = [];
  for (let i = 0; i < PRESETS.length; i += 2) {
    rows.push(
      PRESETS.slice(i, i + 2).map((w) => ({ text: `${WORLD_ICONS[w.id] || '🌍'} ${w.title}`, callback_data: `w:${w.id}` }))
    );
  }
  rows.push([{ text: '❓ Как играть', callback_data: 'help' }]);
  return rows;
}

const WORLD_ICONS = { ash: '🔥', neon: '🌆', space: '🛰', noir: '🌧', forest: '🌲', waste: '🏜' };

function archetypesKeyboard(worldId) {
  const rows = [];
  for (let i = 0; i < ARCHETYPES.length; i += 2) {
    rows.push(
      ARCHETYPES.slice(i, i + 2).map((a) => ({ text: a.name, callback_data: `a:${worldId}:${a.id}` }))
    );
  }
  rows.push([{ text: '← Другой мир', callback_data: 'worlds' }]);
  return rows;
}

function levelKeyboard(choices) {
  const rows = [];
  for (let i = 0; i < choices.length; i += 2) {
    rows.push(choices.slice(i, i + 2).map((c) => ({ text: c.name, callback_data: `lvl:${c.id}` })));
  }
  rows.push([{ text: 'Позже', callback_data: 'lvl:skip' }]);
  return rows;
}

function optionsKeyboard(state) {
  const last = (state.log || []).slice(-1)[0];
  if (state.status === 'dead') {
    return [
      [{ text: '🕯 Новая история', callback_data: 'new' }, { text: '📜 Хроника', callback_data: 'export' }]
    ];
  }
  const rows = (last?.options || []).slice(0, 3).map((o, i) => [{ text: `${i + 1}. ${o}`.slice(0, 60), callback_data: `opt:${i}` }]);
  rows.push([
    { text: '👤 Герой', callback_data: 'hero' },
    { text: '⚡ Рывок', callback_data: 'boost' },
    { text: '📜 Хроника', callback_data: 'export' }
  ]);
  rows.push([
    { text: '↩️ Отменить ход', callback_data: 'rewind' },
    { text: '🛡 Аудит', callback_data: 'audit' },
    { text: '🗺 Другой мир', callback_data: 'new' }
  ]);
  return rows;
}

// ---------- текст ----------

function statLine(hero) {
  return `❤️ ${hero.hp}/${hero.maxHp} · ⚡ ${hero.energy}/${hero.maxEnergy} · 🪙 ${hero.gold}`;
}

function checkLine(check) {
  if (!check) return '';
  const mark = check.critical ? '✨' : check.fumble ? '💀' : check.success ? '✅' : '❌';
  const verdict = check.critical ? 'критический успех' : check.fumble ? 'критический провал' : check.verdict;
  return `🎲 <code>${esc(check.stat)} · ${esc(check.formula)} = ${check.total}</code> против ${check.dc} — ${mark} <b>${esc(verdict)}</b>`;
}

export function renderScene(state, turn) {
  const s = publicState(state);
  const entry = turn || (s.log || []).slice(-1)[0];
  const header =
    `${WORLD_ICONS[state.world.id] || '🌍'} <b>${esc(state.world.title)}</b>\n` +
    `<i>${esc(state.scene.location)}${state.scene.time ? ` · ${esc(state.scene.time)}` : ''} · ход ${Math.max(1, state.scene.turn - 1)}</i>`;
  const dice = entry?.check ? `\n${checkLine(entry.check)}` : '';
  const narration = esc(entry?.narration || '').replace(/\n{3,}/g, '\n\n');
  const limits = (entry?.limits || []).length
    ? `\n\n🩹 <i>Аудитор: ${esc(entry.limits.slice(0, 2).join('; '))}</i>`
    : '';
  const reserve = entry?.demo ? '\n\n<i>· резервный рассказчик ·</i>' : '';
  const xp = entry?.xp ? ` · ✦ +${entry.xp}` : '';
  const lvl = entry?.leveled ? ` · ✦ уровень ${state.hero.level}` : '';
  const stats = `\n\n${statLine(state.hero)}${xp}${lvl}${limits}${reserve}`;
  return `${header}${dice}\n\n${narration}${stats}`;
}

function heroText(state) {
  const h = state.hero;
  const stats = Object.entries(h.stats)
    .map(([k, v]) => `${k}: <b>${v}</b>`)
    .join(' · ');
  return (
    `👤 <b>${esc(h.name)}</b> — ${esc(h.archetype)}\n` +
    `<i>${esc(h.tagline || '')}</i>\n\n` +
    `${statLine(h)}\n${stats}\n\n` +
    `Черта: ${esc(h.trait.name)} — ${esc(h.trait.desc)}\n` +
    `Бремя: ${esc(h.burden.name)} — ${esc(h.burden.desc)}\n` +
    `Состояния: ${esc(h.conditions.join(', ') || 'нет')}\n\n` +
    `🎒 ${esc(h.items.join(', ') || 'пусто')}\n\n` +
    `Уровень ${h.level || 1} · опыт ${h.xp || 0}/${10 * (h.level || 1)}\n` +
    `Проверок: ${state.stats.checks} · успехов ${state.stats.successes} · критов ${state.stats.crits}`
  );
}

// ---------- сценарии ----------

async function beginWorld(chatId, worldId, userName) {
  const world = PRESETS.find((w) => w.id === worldId);
  if (!world) return send(chatId, 'Такого мира нет. /new — выбрать заново.');
  const caption =
    `🌍 <b>${esc(world.title)}</b>\n<i>${esc(world.genre)}</i>\n\n${esc(world.pitch)}\n\n` +
    `🎲 ${esc((world.rules.match(/СИСТЕМА:\s*([a-z0-9%]+)/i)?.[1] || 'd20').toUpperCase())} · ` +
    `правила мира мастер соблюдает буквально.\n\nКто ты в этом мире?`;
  await sendPhoto(chatId, world.art, caption, archetypesKeyboard(worldId));
}

async function createGame(chatId, worldId, archetypeId, userName) {
  if (locks.has(`new:${chatId}`)) return;
  locks.add(`new:${chatId}`);
  const archetype = ARCHETYPES.find((a) => a.id === archetypeId) || ARCHETYPES[0];
  try {
    const status = await send(chatId, '🕯 <i>Мастер раскладывает карты...</i>');
    const { state, demo } = await startNewGame({
      worldId,
      hero: {
        name: String(userName || 'Безымянный').slice(0, 24),
        archetypeId: archetype.id,
        traitId: 'cold',
        burdenId: 'debt'
      },
      difficulty: 'grim'
    });
    await setSession(chatId, { gameId: state.id, mode: 'play', worldId: null });
    const text = renderScene(state);
    if (status?.message_id) {
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: (demo ? '🛠 <i>Модель не ответила — сцену написал резервный рассказчик.</i>\n\n' : '') + text.slice(0, 4096),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: optionsKeyboard(state) }
      });
    } else {
      await sendLong(chatId, text, optionsKeyboard(state));
    }
    await send(chatId, 'Можно нажимать кнопки или писать действие словами — «подкрадываюсь к двери».', [
      [{ text: '📖 Как играть', callback_data: 'help' }]
    ]);
  } catch (err) {
    console.error('[bot] create:', err);
    await send(chatId, 'Мир не открылся. Попробуй ещё раз: /new');
  } finally {
    locks.delete(`new:${chatId}`);
  }
}

async function handleVoice(chatId, msg) {
  const fileId = msg.voice?.file_id;
  if (!fileId) return;
  const s = session(chatId);
  const state = s.gameId ? await loadGame(s.gameId) : null;
  if (!state) return send(chatId, 'Сначала выбери мир.', worldsKeyboard());

  let recognized = '';
  try {
    const res = await fetch(`${API()}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const data = await res.json();
    const filePath = data?.result?.file_path;
    if (!filePath) throw new Error('нет пути к файлу');
    const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
    if (!fileRes.ok) throw new Error(`файл не скачался: ${fileRes.status}`);
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(await fileRes.arrayBuffer())], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', process.env.LORIA_STT_MODEL || 'openai/whisper-1');
    const stt = await fetch(`${OPENROUTER_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: form
    });
    const json = await stt.json().catch(() => ({}));
    recognized = String(json.text || json?.choices?.[0]?.message?.content || '').trim();
    if (!stt.ok) throw new Error(json?.error?.message || `STT ${stt.status}`);
  } catch (err) {
    console.error('[bot] voice:', err?.message);
    return send(chatId, '🎙 Голос не разобрать. Напиши действие текстом — это надёжнее.');
  }
  if (!recognized) return send(chatId, '🎙 Не расслышал. Попробуй ещё раз или напиши текстом.');
  await send(chatId, `🎙 <i>«${esc(recognized.slice(0, 300))}»</i>`);
  return makeTurn(chatId, recognized);
}

async function makeTurn(chatId, action) {
  const s = session(chatId);
  const boost = Boolean(s.boostArmed);
  const state = s.gameId ? await loadGame(s.gameId) : null;
  if (!state) return send(chatId, 'Истории пока нет. /new — начать.');
  if (state.status === 'dead') {
    return send(chatId, 'История уже закончена. /new — начать новую.', optionsKeyboard(state));
  }
  if (locks.has(chatId)) return send(chatId, 'Мастер ещё дописывает предыдущий ход.');
  locks.add(chatId);
  try {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
    const sanitized = sanitizeAction(action);
    if (sanitized.error) return send(chatId, 'Опиши действие словами.');
    if (sanitized.cheat) noteCheatAttempt(state, sanitized.text);

    const result = await runTurn(state, sanitized.text, () => {}, { boost });
    if (boost) await setSession(chatId, { boostArmed: false });
    const text = renderScene(result.state, result.turn);
    if (result.demo && !DEMO_MODE) {
      await send(chatId, '🛠 <i>Модель не ответила — сцену написал резервный рассказчик.</i>');
    }
    if (text.length > 4096) {
      await sendLong(chatId, text, optionsKeyboard(result.state));
    } else {
      await send(chatId, text, optionsKeyboard(result.state));
    }
    if (result.state.hero.pendingLevel) {
      const { levelChoices } = await import('./state.js');
      await send(chatId, '✦ <b>Новый уровень</b>\nВыжил — значит, стал крепче. Выбери улучшение.', levelKeyboard(levelChoices(result.state.hero)));
    }
  } catch (err) {
    console.error('[bot] turn:', err);
    await send(chatId, 'Мастер запнулся: ' + esc(err?.message || 'неизвестная ошибка') + '\nПопробуй ещё раз.');
  } finally {
    locks.delete(chatId);
  }
}

async function sendChronicle(chatId) {
  const s = session(chatId);
  const state = s.gameId ? await loadGame(s.gameId) : null;
  if (!state) return send(chatId, 'Пока нечего выгружать. /new');
  const md = exportMarkdown(state);
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', `Хроника: ${state.world.title}`);
    form.append('document', new Blob([md], { type: 'text/markdown' }), `loria-${state.id}.md`);
    const res = await fetch(`${API()}/sendDocument`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error('[bot] export:', err?.message);
    await send(chatId, 'Не удалось отправить файл. Хронику можно забрать на сайте' + (HOSTED_URL ? `: ${HOSTED_URL}` : '.'));
  }
}

async function runAudit(chatId) {
  const s = session(chatId);
  const state = s.gameId ? await loadGame(s.gameId) : null;
  if (!state) return send(chatId, 'Пока нечего проверять.');
  if (DEMO_MODE || !aiAvailable()) {
    return send(chatId, '🔎 Аудитор работает локально: серьёзных нарушений не найдено.');
  }
  const last = (state.log || []).slice(-1)[0];
  if (!last) return send(chatId, 'Пока нечего проверять.');
  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const result = await aiAudit(state, last);
    const violations = Array.isArray(result?.data?.violations) ? result.data.violations : [];
    if (!violations.length) return send(chatId, '🔎 Аудитор: нарушений правил не найдено.');
    const lines = violations.slice(0, 5).map((v) => `• ${esc(v.message)}`).join('\n');
    return send(chatId, `🔎 <b>Аудитор</b>\n${lines}`);
  } catch (err) {
    return send(chatId, 'Аудитор недоступен: ' + esc(err?.message || 'ошибка'));
  }
}

const HELP = `<b>Как играть</b>

1. Выбери мир и класс.
2. Отвечай кнопкой или пиши действие словами: «подкрадываюсь к двери и слушаю».
3. Каждое рискованное действие проверяется серверным броском. Мастер не может его отменить.
4. Смерть окончательна. Мир помнит твои клятвы и долги.

Можно говорить голосом: отправь голосовое, и мастер его разберёт.

Команды:
/hero — лист героя
/audit — проверить последний ход
/export — хроника в Markdown
/new — новая история
/help — эта шпаргалка`;

const START_HTML = `<b>Лория</b> 🕯
Текстовая RPG, где мастер не поддакивает.

Кубик кидает сервер, аудитор следит за цифрами, а мир помнит твои клятвы и долги.

Выбери мир:`;

// ---------- обработка ----------

export async function handleUpdate(update) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const data = String(cq.data || '');
    await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    if (!chatId) return;

    if (data === 'worlds') return send(chatId, START_HTML, worldsKeyboard());
    if (data === 'help') return send(chatId, HELP);
    if (data === 'new') return send(chatId, START_HTML, worldsKeyboard());
    if (data.startsWith('w:')) {
      return beginWorld(chatId, data.slice(2), cq.from?.first_name);
    }
    if (data.startsWith('a:')) {
      const [, worldId, archetypeId] = data.split(':');
      return createGame(chatId, worldId, archetypeId, cq.from?.first_name);
    }
    if (data.startsWith('lvl:')) {
      const s = session(chatId);
      const state = s.gameId ? await loadGame(s.gameId) : null;
      if (!state) return send(chatId, 'Истории пока нет. /new');
      const choice = data.slice(4);
      if (choice === 'skip') return send(chatId, 'Улучшение отложено. Вернуться можно кнопкой «Уровень» в листе героя.');
      const { levelUp } = await import('./engine.js');
      try {
        const result = await levelUp(state, choice);
        return send(chatId, `✦ <b>Уровень ${result.state.hero.level}</b>\nУлучшение: ${esc(result.choice)}.\n\n${heroText(result.state)}`);
      } catch (err) {
        return send(chatId, '✦ ' + esc(err?.message || 'Улучшение не применилось'));
      }
    }
    if (data === 'rewind') {
      const { rewind } = await import('./engine.js');
      const s = session(chatId);
      const state = s.gameId ? await loadGame(s.gameId) : null;
      if (!state) return send(chatId, 'Истории пока нет. /new');
      try {
        const result = await rewind(state);
        return send(
          chatId,
          `↩️ Ход ${result.undoneTurn} отменён.\n\n${renderScene(result.state)}`.slice(0, 4096),
          optionsKeyboard(result.state)
        );
      } catch (err) {
        return send(chatId, '↩️ ' + esc(err?.message || 'Отмена не удалась'));
      }
    }
    if (data === 'hero' || data === 'audit' || data === 'export' || data === 'boost') {
      const s = session(chatId);
      const state = s.gameId ? await loadGame(s.gameId) : null;
      if (!state) return send(chatId, 'Истории пока нет. /new');
      if (data === 'hero') return send(chatId, heroText(state));
      if (data === 'audit') return runAudit(chatId);
      if (data === 'boost') {
        if (state.status === 'dead') return send(chatId, 'История закончена. /new');
        const ready = state.hero.boosts > 0;
        if (!ready) return send(chatId, '⚡ Рывок израсходован. Восстановится после передышки — на сайте это кнопка «Передышка».');
        const nowArmed = !s.boostArmed;
        await setSession(chatId, { boostArmed: nowArmed });
        return send(
          chatId,
          nowArmed
            ? '⚡ <b>Рывок заряжен</b>\nСледующее действие сервер бросит дважды и возьмёт лучший результат. Осталось: 1.'
            : '⚡ Рывок снят. Следующее действие пройдёт с обычным броском.'
        );
      }
      return sendChronicle(chatId);
    }
    if (data.startsWith('opt:')) {
      const s = session(chatId);
      const state = s.gameId ? await loadGame(s.gameId) : null;
      if (!state) return send(chatId, 'Истории пока нет. /new');
      const index = Number(data.slice(4));
      const last = (state.log || []).slice(-1)[0];
      const option = last?.options?.[index];
      if (!option) return send(chatId, 'Этот вариант уже недоступен. Продолжай словами.');
      return makeTurn(chatId, option);
    }
    return;
  }

  const msg = update.message;
  if (!msg) return;
  if (msg.voice) {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return send(chatId, 'Лория ведёт историю один на один.');
    const now = Date.now();
    const lastAt = cooldown.get(chatId) || 0;
    if (now - lastAt < 1500) return;
    cooldown.set(chatId, now);
    return handleVoice(chatId, msg);
  }
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = String(msg.text).trim();
  const fromName = msg.from?.first_name || msg.from?.username || 'Безымянный';

  if (msg.chat.type !== 'private') {
    return send(chatId, 'Лория ведёт историю один на один. Напиши мне в личку.');
  }

  if (text === '/start' || text === '/new' || text === '/restart') {
    if (text !== '/start') await setSession(chatId, { gameId: null, mode: 'new' });
    return send(chatId, START_HTML, worldsKeyboard());
  }
  if (text === '/help') return send(chatId, HELP);
  if (text === '/hero') {
    const s = session(chatId);
    const state = s.gameId ? await loadGame(s.gameId) : null;
    if (!state) return send(chatId, 'Истории пока нет. /new');
    return send(chatId, heroText(state));
  }
  if (text === '/audit') return runAudit(chatId);
  if (text === '/export') return sendChronicle(chatId);

  if (text.startsWith('/')) {
    return send(chatId, 'Не знаю такой команды. /help — что я умею.');
  }

  const s = session(chatId);
  const state = s.gameId ? await loadGame(s.gameId) : null;
  if (!state) {
    return send(chatId, 'Сначала выбери мир.', worldsKeyboard());
  }

  const now = Date.now();
  const lastAt = cooldown.get(chatId) || 0;
  if (now - lastAt < 1500) return send(chatId, 'Не так быстро. Мастер ещё не договорил.');
  cooldown.set(chatId, now);

  return makeTurn(chatId, text);
}

// ---------- запуск ----------

export async function startBot() {
  if (!TELEGRAM_TOKEN) {
    console.error('[bot] TELEGRAM_BOT_TOKEN не задан. Добавь токен от @BotFather в .env');
    process.exit(1);
  }
  await loadSessions();
  me = await tg('getMe');
  if (!me) {
    console.error('[bot] Не удалось подключиться. Проверь токен и интернет.');
    process.exit(1);
  }
  console.log('');
  console.log(`  ЛОРИЯ · Telegram-бот @${me.username}`);
  console.log(`  ИИ: ${DEMO_MODE ? 'резервный режим' : aiAvailable() ? 'модель подключена' : 'нет ключа'}`);
  console.log('');

  await tg('deleteWebhook', { drop_pending_updates: false });
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Новая история' },
      { command: 'hero', description: 'Лист героя' },
      { command: 'audit', description: 'Проверить последний ход' },
      { command: 'export', description: 'Хроника в Markdown' },
      { command: 'help', description: 'Как играть' }
    ]
  });

  running = true;
  while (running) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, { retries: 0 });
      if (Array.isArray(updates)) {
        for (const update of updates) {
          offset = update.update_id + 1;
          handleUpdate(update).catch((err) => console.error('[bot] update:', err));
        }
      } else {
        await sleep(3000);
      }
    } catch (err) {
      console.error('[bot] polling:', err?.message);
      await sleep(3000);
    }
  }
}

export function stopBot() {
  running = false;
}

const isMain = process.argv[1] && process.argv[1].endsWith('telegram.js');
if (isMain) {
  startBot().catch((err) => {
    console.error('[bot] fatal:', err);
    process.exit(1);
  });
  process.on('SIGINT', () => {
    stopBot();
    console.log('\n  Бот остановлен.');
    process.exit(0);
  });
}
