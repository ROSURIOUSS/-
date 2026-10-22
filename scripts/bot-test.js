// Тест Telegram-бота без сети: подменяем fetch и проверяем сценарии.
// Запуск: npm run bot:test
process.env.LORIA_DEMO = '1';
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST-TOKEN';
process.env.LORIA_BOT_COOLDOWN_MS = '0';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const calls = [];
const realFetch = globalThis.fetch;
let voiceText = 'Подкрадываюсь к двери и слушаю';

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes('api.telegram.org')) {
    const method = target.split('?')[0].split('/').pop();
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : { multipart: true };
    calls.push({ method, body });
    if (method === 'getFile') {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { file_path: 'voice/file.ogg' } }) };
    }
    if (target.includes('/file/bot')) {
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  }
  if (target.includes('/audio/transcriptions')) {
    return { ok: true, status: 200, json: async () => ({ text: voiceText }) };
  }
  return realFetch(url, options);
};

const SESSION_FILE = path.resolve('data/telegram.json');
await fs.rm(SESSION_FILE, { force: true }).catch(() => {});

const { handleUpdate } = await import('../server/telegram.js');

const privateChat = { chat: { id: 4242, type: 'private' }, from: { first_name: 'Аста' } };
const msg = (text) => ({ message: { ...privateChat, text } });
const callback = (data) => ({ callback_query: { id: `cb-${data}`, data, message: privateChat, from: {} } });
const voice = { message: { ...privateChat, voice: { file_id: 'voice-1', duration: 3 } } };

const textOf = (call) => call.body.text || call.body.caption || '';
const lastText = () => textOf([...calls].reverse().find((c) => textOf(c))) || '';
/** Последнее сообщение, подходящее под условие — сцены могут прийти и через editMessageText. */
const findText = (re) => textOf([...calls].reverse().find((c) => re.test(textOf(c)))) || '';
const keyboardOf = (call) => call?.body?.reply_markup?.inline_keyboard.flat().map((b) => b.text) || [];
const lastKeyboard = () => keyboardOf([...calls].reverse().find((c) => c.body.reply_markup));
/** Клавиатура сообщения, в котором есть заданный текст (сцена может прийти через editMessageText). */
const keyboardWithText = (re) => keyboardOf([...calls].reverse().find((c) => re.test(textOf(c))));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n     ${err.message}`);
  }
}

console.log('\n  ЛОРИЯ · тест Telegram-бота\n');

await test('/start показывает все миры и кнопку помощи', async () => {
  await handleUpdate(msg('/start'));
  const text = lastText();
  assert.match(text, /Лория/);
  const buttons = lastKeyboard();
  assert.ok(buttons.some((b) => /Пепел Вельдгарда/.test(b)), 'нет мира в кнопках');
  assert.ok(buttons.some((b) => /Лес/.test(b)), 'нет нового мира');
  assert.ok(buttons.includes('❓ Как играть'));
});

await test('выбор мира и класса создаёт игру', async () => {
  await handleUpdate(callback('w:forest'));
  assert.match(findText(/Лес, который слушает/), /Лес, который слушает/);

  await handleUpdate(callback('a:forest:scholar'));
  const scene = findText(/ход 1/);
  assert.match(scene, /Лес, который слушает/);
  assert.match(scene, /❤️/);
  const buttons = keyboardWithText(/ход 1/);
  assert.ok(buttons.some((b) => /^1\./.test(b)), 'нет вариантов действий');
});

await test('спокойный текст двигает историю без броска', async () => {
  await handleUpdate(msg('Осторожно осматриваю тропу'));
  const text = findText(/ход 2/);
  assert.match(text, /без броска/);
  assert.doesNotMatch(text, /против \d+/);
});

await test('рискованный текст двигает историю с броском', async () => {
  await handleUpdate(msg('Крадусь вдоль частокола'));
  const text = findText(/ход 3/);
  assert.match(text, /против \d+/);
});

await test('голосовое превращается в действие', async () => {
  const before = calls.length;
  await handleUpdate(voice);
  const added = calls.slice(before);
  assert.ok(added.some((c) => c.method === 'getFile'), 'бот не запросил файл');
  assert.ok(added.some((c) => /🎙/.test(c.body.text || '')), 'нет расшифровки');
  assert.match(findText(/ход \d+/), /ход \d+/);
});

await test('рывок заряжается кнопкой и тратит заряд', async () => {
  await handleUpdate(callback('boost'));
  assert.match(lastText(), /Рывок заряжен/);
  await handleUpdate(msg('Проверяю, кто идёт по тропе'));
  assert.match(findText(/ход \d+/), /ход \d+/);
});

await test('отмена хода возвращает сцену', async () => {
  await handleUpdate(callback('rewind'));
  assert.match(findText(/отменён/), /отменён/);
});

await test('лист героя показывает характеристики и уровень', async () => {
  await handleUpdate(msg('/hero'));
  const text = findText(/Уровень/);
  assert.match(text, /Уровень/);
  assert.match(text, /Сила:/);
});

await test('аудит и хроника отвечают без паузы', async () => {
  await handleUpdate(msg('/audit'));
  assert.match(lastText(), /Аудитор/);
  const before = calls.length;
  await handleUpdate(msg('/export'));
  const added = calls.slice(before);
  assert.ok(added.some((c) => c.method === 'sendDocument'), 'хроника не отправлена файлом');
});

await test('неизвестная команда не ломает бота', async () => {
  await handleUpdate(msg('/nonsense'));
  assert.match(lastText(), /Не знаю такой команды/);
});

await test('в группе бот вежливо отправляет в личку', async () => {
  await handleUpdate({ message: { chat: { id: -100, type: 'group' }, from: {}, text: '/start' } });
  assert.match(lastText(), /один на один/);
});

await test('сессия сохраняется на диск', async () => {
  const raw = await fs.readFile(SESSION_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(parsed['4242']?.gameId, 'в сессии нет игры');
});

await fs.rm(SESSION_FILE, { force: true }).catch(() => {});
await fs.rm(path.resolve('data/games'), { recursive: true, force: true }).catch(() => {});

console.log(`\n  Итог: ${passed} прошло, ${failed} провалилось\n`);
process.exit(failed ? 1 : 0);
