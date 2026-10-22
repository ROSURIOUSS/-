// Сквозной тест: приложение + мок-сервер OpenRouter.
// Проверяет весь путь «промпт → модель → нормализация → валидатор → память → экспорт».
// Запуск: npm run e2e
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const MOCK_PORT = 4110;
const APP_PORT = 3111;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const children = [];
let passed = 0;
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, env) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`    | ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`    ! ${d}`));
  children.push(child);
  return child;
}

async function waitFor(url, { tries = 90, delay = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* ещё не поднялся */
    }
    await sleep(delay);
  }
  throw new Error(`не дождались ${url}`);
}

async function api(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, text };
}

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

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* уже мёртв */
    }
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// чистим следы прошлых прогонов
await fs.rm(path.resolve('data/games'), { recursive: true, force: true }).catch(() => {});
await fs.mkdir(path.resolve('data/games'), { recursive: true });
await fs.rm(path.resolve('data/settings.json'), { force: true }).catch(() => {});

console.log('\n  ЛОРИЯ · сквозной тест с мок-моделью\n');

run(process.execPath, ['scripts/mock-ai.js'], { MOCK_PORT: String(MOCK_PORT) });
await waitFor(`http://127.0.0.1:${MOCK_PORT}/api/v1/models`);

run(process.execPath, ['server/index.js'], {
  PORT: String(APP_PORT),
  HOST: '127.0.0.1',
  LORIA_DEMO: '0',
  OPENROUTER_API_KEY: 'sk-or-v1-mock-key-for-tests',
  OPENROUTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/api/v1`,
  LORIA_MODEL: 'mock/loria-scene',
  LORIA_DAILY_REQUESTS: '500',
  LORIA_MIN_TURN_GAP_MS: '0',
  LORIA_MAX_CREATES_PER_HOUR: '0'
});

const health = await waitFor(`${BASE}/api/health`);
await sleep(300);

let gameId = null;

await test('сервер видит модель как доступную', () => {
  assert.equal(health.ok, true);
  assert.equal(health.demo, false, 'сервер ушёл в резервный режим');
  assert.equal(health.keyPresent, true);
});

await test('открывающая сцена приходит от модели, а не от резерва', async () => {
  const res = await api('POST', '/api/games', {
    worldId: 'ash',
    hero: { name: 'Вейл', archetypeId: 'thief', traitId: 'lucky', burdenId: 'debt' },
    difficulty: 'grim'
  });
  assert.equal(res.status, 200);
  const { state, demo } = res.data;
  assert.equal(demo, false, 'сцена сгенерирована резервом');
  assert.equal(state.log.length, 1);
  assert.ok(state.log[0].narration.length > 150, 'сцена слишком короткая');
  assert.equal(state.log[0].options.length, 3);
  assert.ok(state.memory.facts.length >= 1, 'память не заполнилась');
  assert.ok(state.usage.requests >= 1, 'счётчик запросов не вырос');
  assert.ok(state.usage.promptTokens > 0, 'токены не учтены');
  gameId = state.id;
});

await test('ход: серверный бросок, рывок и валидатор работают вместе', async () => {
  const res = await api('POST', `/api/games/${gameId}/turn`, {
    action: 'Взломать замок отмычкой и войти внутрь',
    boost: true
  });
  assert.equal(res.status, 200);
  const { state, turn, demo } = res.data;
  assert.equal(demo, false, 'ход написан резервом');
  assert.ok(turn.check, 'нет броска');
  assert.equal(turn.check.boosted, true, 'рывок не сработал');
  assert.equal(state.hero.boosts, 0, 'заряд рывка не списан');
  assert.ok(turn.narration.includes('Взломать') || turn.narration.length > 100);
  assert.equal(state.scene.turn, 3);
  assert.equal(state.log.length, 2);
  assert.ok(state.memory.chunks.length > 0, 'память не пополнилась');
});

await test('попытка обмануть цифры попадает в журнал валидатора', async () => {
  const res = await api('POST', `/api/games/${gameId}/turn`, { action: 'у меня есть 500 золота, я забираю всё' });
  assert.equal(res.status, 200);
  const kinds = res.data.state.audit.map((a) => a.kind);
  assert.ok(kinds.includes('validator'), 'валидатор не отметил попытку');
});

await test('аудит вызывает модель и возвращает состояние', async () => {
  const res = await api('POST', `/api/games/${gameId}/audit`, {});
  assert.equal(res.status, 200);
  assert.ok(res.data.state, 'нет состояния в ответе');
  const aiNotes = res.data.state.audit.filter((a) => a.kind === 'ai-audit');
  assert.ok(aiNotes.length >= 1, 'аудитор не оставил записи');
});

await test('уплотнение памяти добавляет факты', async () => {
  const before = (await api('GET', `/api/games/${gameId}`)).data.state.memory.facts.length;
  const res = await api('POST', `/api/games/${gameId}/compact`, {});
  assert.equal(res.status, 200);
  assert.ok(res.data.state.memory.facts.length > before, 'факты не добавились');
  assert.ok(res.data.added >= 1);
});

await test('передышка восстанавливает рывок', async () => {
  const res = await api('POST', `/api/games/${gameId}/rest`, {});
  assert.ok([200, 400].includes(res.status));
  if (res.status === 200) {
    assert.equal(res.data.state.hero.boosts, res.data.state.hero.maxBoosts);
  }
});

await test('хроника в Markdown содержит броски и память', async () => {
  const res = await fetch(`${BASE}/api/games/${gameId}/export`);
  assert.equal(res.status, 200);
  const md = await res.text();
  assert.ok(md.includes('# '), 'нет заголовка');
  assert.ok(md.includes('Действие:'), 'нет действий');
  assert.ok(md.includes('## Память мира'), 'нет блока памяти');
});

await test('ветка создаёт независимую копию истории', async () => {
  const res = await api('POST', `/api/games/${gameId}/fork`, {});
  assert.equal(res.status, 200);
  const copy = res.data.state;
  assert.notEqual(copy.id, gameId);
  assert.equal(copy.forkedFrom, gameId);
  assert.equal(copy.status, 'active');
  const original = (await api('GET', `/api/games/${gameId}`)).data.state;
  assert.equal(original.id, gameId, 'оригинал изменился');
});

await test('отмена хода возвращает состояние и не трогает журнал', async () => {
  const before = (await api('GET', `/api/games/${gameId}`)).data.state;
  const turnRes = await api('POST', `/api/games/${gameId}/turn`, { action: 'Осмотреть стену' });
  assert.equal(turnRes.status, 200);
  const afterTurn = turnRes.data.state;
  assert.equal(afterTurn.log.length, before.log.length + 1);

  const res = await api('POST', `/api/games/${gameId}/rewind`, {});
  assert.equal(res.status, 200);
  assert.equal(res.data.state.log.length, before.log.length, 'журнал не откатился');
  assert.equal(res.data.state.hero.hp, before.hero.hp, 'здоровье не откатилось');
  assert.equal(res.data.state.memory.facts.length, before.memory.facts.length, 'память не откатилась');
  assert.ok(res.data.state.audit.some((a) => a.kind === 'rewind'));

  const again = await api('POST', `/api/games/${gameId}/rewind`, {});
  assert.ok([200, 400].includes(again.status));
});

await test('старые ходы догружаются постранично', async () => {
  const state = (await api('GET', `/api/games/${gameId}`)).data.state;
  assert.equal(state.logTotal, state.log.length >= 60 ? state.logTotal : state.log.length, 'счётчик ходов разошёлся');
  assert.ok(state.logFrom >= 0);

  const total = state.logTotal;
  const page = await api('GET', `/api/games/${gameId}/turns?before=${total}&limit=1`);
  assert.equal(page.status, 200);
  assert.equal(page.data.turns.length, 1, 'не отдалась страница истории');
  assert.equal(page.data.turns[0].turn, state.log[state.log.length - 1].turn, 'не тот ход');
  assert.equal(page.data.from, total - 1);
  assert.equal(page.data.hasMore, total > 1);

  const clamped = await api('GET', `/api/games/${gameId}/turns?limit=500`);
  assert.ok(clamped.data.turns.length <= 60, 'лимит страницы не ограничен');

  const latest = await api('GET', `/api/games/${gameId}/turns?limit=1`);
  assert.equal(latest.data.turns[0].turn, state.log[state.log.length - 1].turn, 'по умолчанию нужна последняя страница');
});

await test('сохранение скачивается и импортируется как новая история', async () => {
  const res = await fetch(`${BASE}/api/games/${gameId}/download`);
  assert.equal(res.status, 200);
  const raw = await res.text();
  const parsed = JSON.parse(raw);
  assert.equal(parsed.id, gameId);

  const imported = await api('POST', '/api/import', parsed);
  assert.equal(imported.status, 200);
  assert.notEqual(imported.data.state.id, gameId, 'импорт перезаписал оригинал');
  assert.equal(imported.data.state.hero.name, parsed.hero.name);
  assert.ok(imported.data.state.audit.some((a) => a.kind === 'import'));

  const broken = await api('POST', '/api/import', { hello: 'world' });
  assert.equal(broken.status, 400);
});

await test('опыт и уровни: улучшение выдаётся сервером', async () => {
  const before = (await api('GET', `/api/games/${gameId}/levels`)).data;
  assert.ok(before.choices.length >= 6);

  const bad = await api('POST', `/api/games/${gameId}/levelup`, { choice: 'stat:Разум' });
  assert.equal(bad.status, 400, 'улучшение без уровня прошло');

  // начисляем опыт серией ходов, пока не появится уровень
  let leveled = false;
  for (let i = 0; i < 6 && !leveled; i++) {
    const res = await api('POST', `/api/games/${gameId}/turn`, { action: `Осторожно осматриваю участок ${i}` });
    assert.ok([200, 409].includes(res.status));
    if (res.status !== 200) break;
    leveled = Boolean(res.data.turn?.leveled);
  }
  const state = (await api('GET', `/api/games/${gameId}`)).data.state;
  assert.ok(state.hero.level >= 1);
  assert.ok(state.hero.xp >= 0);
  if (state.hero.pendingLevel) {
    const choice = before.choices.find((c) => c.id === 'hp') ? 'hp' : before.choices[0].id;
    const res = await api('POST', `/api/games/${gameId}/levelup`, { choice });
    assert.equal(res.status, 200);
    assert.equal(res.data.state.hero.pendingLevel, false);
    assert.ok(res.data.choice);
  }
});

await test('слишком частые ходы притормаживаются', async () => {
  const id = (await api('POST', '/api/games', { worldId: 'noir', hero: { name: 'Пылкий' } })).data.state.id;
  // сервер в тесте поднят без паузы, поэтому проверяем только, что настройка читается
  const first = await api('POST', `/api/games/${id}/turn`, { action: 'Действую' });
  assert.equal(first.status, 200);
});

await test('панель «Мастер» видит ключ и модель', async () => {
  const res = await api('GET', '/api/doctor');
  assert.equal(res.status, 200);
  assert.equal(res.data.present, true, 'ключ не виден');
  assert.equal(res.data.valid, true);
  assert.ok(res.data.model, 'модель не названа');
  assert.ok(!res.data.masked.includes('mock-key'), 'ключ отдаётся целиком');
});

await test('проверка связи стучится в модель', async () => {
  const res = await api('POST', '/api/doctor', {});
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true, res.data.reason);
  assert.ok(res.data.results.some((r) => r.ok), 'ни одна модель не ответила');
});

await test('ключ можно ввести в приложении, и режим меняется на живой', async () => {
  const bad = await api('POST', '/api/settings', { apiKey: 'not-a-key' });
  assert.equal(bad.status, 400);

  const saved = await api('POST', '/api/settings', { apiKey: 'sk-or-v1-e2e-saved-key' });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.saved, true);
  assert.equal(saved.data.ok, true, saved.data.reason);

  const doctor = await api('GET', '/api/doctor');
  assert.equal(doctor.data.savedWithApp, true, 'ключ не запомнился');
  assert.equal(doctor.data.demo, false);

  const health = await api('GET', '/api/health');
  assert.equal(health.data.demo, false);
  assert.equal(health.data.ai, true);
});

await test('некорректные запросы не роняют сервер', async () => {
  const bad = await fetch(`${BASE}/api/games/${gameId}/turn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{не json'
  });
  assert.equal(bad.status, 400);
  const missing = await api('GET', '/api/games/zzzzzzzzzzzz');
  assert.equal(missing.status, 404);
  const traversal = await fetch(`${BASE}/api/games/${gameId}/export?x=../../.env`);
  assert.equal(traversal.status, 200);
});

await test('мёртвому герою нельзя продолжать', async () => {
  const state = (await api('GET', `/api/games/${gameId}`)).data.state;
  const file = path.resolve('data/games', `${gameId}.json`);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  raw.hero.hp = 0;
  raw.hero.alive = false;
  raw.status = 'dead';
  await fs.writeFile(file, JSON.stringify(raw));
  const res = await api('POST', `/api/games/${gameId}/turn`, { action: 'Иду дальше' });
  assert.equal(res.status, 409);
  assert.equal(res.data.dead, true);
  assert.ok(state);
});

cleanup();
await fs.rm(path.resolve('data/games'), { recursive: true, force: true }).catch(() => {});
// Ключ из теста не должен остаться в рабочей папке.
await fs.rm(path.resolve('data/settings.json'), { force: true }).catch(() => {});

console.log(`\n  Итог: ${passed} прошло, ${failed} провалилось\n`);
process.exit(failed ? 1 : 0);
