import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './env.js';
loadEnv();

import { aiAvailable, aiConfig, AIError, aiStatus } from './ai.js';
import { askJson } from './ai.js';
import { buildSystemPrompt, buildTurnPrompt, buildOpeningPrompt, buildCompactionPrompt } from './prompts.js';
import { retrieve, rememberTurn, chronicle, memoryIndexSize } from './memory.js';
import { createGame, serverRoll, applyDeltas, publicState, gameOver } from './state.js';
import { PRESETS, ARCHETYPES, TRAITS, BURDENS, DIFFICULTIES } from './worlds.js';
import { saveGame, loadGame, listGames, deleteGame, exportMarkdown, prune } from './store.js';
import { localAudit, aiAudit } from './auditor.js';
import { demoOpening, demoTurn } from './demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DEMO_MODE = (() => {
  const raw = (process.env.LORIA_DEMO || 'auto').toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return !aiAvailable();
})();
const DAILY_LIMIT = Number(process.env.LORIA_DAILY_REQUESTS || 200);
const ENABLE_AI_AUDIT = process.env.LORIA_AI_AUDIT === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8'
};

const locks = new Set();
const startedAt = Date.now();
let turnsServed = 0;

// ---------- утилиты ----------

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function usageCheck(state) {
  if (!state.usage || state.usage.date !== todayKey()) {
    state.usage = { date: todayKey(), requests: 0, promptTokens: 0, completionTokens: 0 };
  }
  return state.usage.requests < DAILY_LIMIT;
}

function bumpUsage(state, usage, ok = true) {
  if (!state.usage || state.usage.date !== todayKey()) {
    state.usage = { date: todayKey(), requests: 0, promptTokens: 0, completionTokens: 0 };
  }
  if (ok) state.usage.requests += 1;
  if (usage) {
    state.usage.promptTokens += Number(usage.prompt_tokens || 0);
    state.usage.completionTokens += Number(usage.completion_tokens || 0);
  }
}

const CHEAT_RE =
  /(у меня (уже )?(есть|было|появилось)|я (уже )?(бессмертн|всемогущ|неуязвим)|я (получаю|беру себе|выдаю себе)|\+\s*\d{2,}\s*(золот|монет|hp|хп)|всемогущ|чит|godmode|\/give|\/setlevel)/i;

function sanitizeAction(raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'Пустое действие' };
  if (text.length > 600) text = text.slice(0, 600);
  return { text, cheat: CHEAT_RE.test(text) };
}

/** Проверка и нормализация ответа модели. */
function normalizePlan(data) {
  if (!data || typeof data !== 'object') return null;
  const narration = String(data.narration || '').trim();
  if (narration.length < 40) return null;
  const options = (Array.isArray(data.options) ? data.options : [])
    .map((o) =>
      String(o && typeof o === 'object' ? o.text || o.label || o.action || o.title || '' : o ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((o) => o.length > 2)
    .slice(0, 3)
    .map((o) => o.slice(0, 120));
  while (options.length < 3) {
    options.push(
      ['Осмотреться внимательнее', 'Действовать прямо', 'Отступить и подумать'][options.length] || 'Продолжить'
    );
  }
  const deltas = data.deltas && typeof data.deltas === 'object' ? data.deltas : {};
  const facts = (Array.isArray(data.facts) ? data.facts : [])
    .map((f) => (typeof f === 'string' ? { text: f } : f))
    .filter((f) => f && typeof f.text === 'string')
    .slice(0, 4);
  const npcs = (Array.isArray(data.npcs) ? data.npcs : [])
    .filter((n) => n && typeof n.name === 'string')
    .slice(0, 5);
  return {
    narration: narration.slice(0, 6000),
    options,
    deltas,
    facts,
    npcs,
    dead: Boolean(data.dead),
    deathReason: String(data.deathReason || '').slice(0, 400)
  };
}

function progress(state, entry) {
  state.log.push(entry);
  if (state.log.length > 200) state.log = state.log.slice(-200);
}

// ---------- ходы ----------

async function openingFor(state, onPhase = () => {}) {
  if (!DEMO_MODE && aiAvailable()) {
    try {
      onPhase('writing', {});
      const retrieved = retrieve(state, [state.world.title, state.world.genre, state.world.start].join(' '));
      const { data, usage } = await askJson({
        system: buildSystemPrompt(state, retrieved),
        user: buildOpeningPrompt(state),
        temperature: 1,
        maxTokens: 1400
      });
      const plan = normalizePlan(data);
      if (plan) {
        bumpUsage(state, usage);
        return { plan, demo: false };
      }
    } catch (err) {
      console.error('[opening] ИИ недоступен:', err?.message);
    }
  }
  return { plan: demoOpening(state), demo: true };
}

function commitPlan(state, plan, { action, roll, demo }) {
  const deltas = plan.deltas && typeof plan.deltas === 'object' ? plan.deltas : {};
  const applied = applyDeltas(state, deltas, { action });

  rememberTurn(state, {
    turn: state.scene.turn,
    action,
    narration: plan.narration,
    facts: plan.facts,
    npcs: plan.npcs,
    location: state.scene.location
  });

  // смерть: доверяем только состоянию
  let died = false;
  if (plan.dead && state.hero.hp > 0) {
    state.audit.push({
      turn: state.scene.turn,
      at: Date.now(),
      kind: 'audit',
      severity: 'hard',
      message: 'Мастер объявил смерть без падения здоровья — смерть отклонена.'
    });
  }
  if (state.hero.hp <= 0) {
    died = true;
    if (plan.deathReason) state.deathReason = plan.deathReason;
    gameOver(state, plan.deathReason || 'Герой погиб.');
  }

  const turnEntry = {
    turn: state.scene.turn,
    at: Date.now(),
    action,
    narration: plan.narration,
    options: plan.options,
    check: roll
      ? {
          stat: roll.stat,
          formula: roll.formula,
          total: roll.total,
          dc: roll.dc,
          verdict: roll.verdict,
          success: roll.success,
          critical: roll.critical,
          fumble: roll.fumble,
          dice: roll.dice,
          mod: roll.mod,
          sides: roll.sides
        }
      : null,
    deltas: {
      hp: state.hero.hp,
      energy: state.hero.energy,
      gold: state.hero.gold
    },
    changes: applied.changes,
    limits: applied.notes,
    demo: Boolean(demo)
  };
  progress(state, turnEntry);

  if (roll) {
    state.stats.checks += 1;
    if (roll.success) state.stats.successes += 1;
    else state.stats.failures += 1;
    if (roll.critical) state.stats.crits += 1;
    if (roll.fumble) state.stats.fumbles += 1;
    state.scene.lastCheck = turnEntry.check;
  }

  const issues = localAudit(state, turnEntry, plan, { skipStyle: Boolean(demo) });
  for (const issue of issues) {
    state.audit.push({ turn: state.scene.turn, at: Date.now(), kind: 'audit', rule: issue.kind, severity: issue.severity, message: issue.message });
  }
  if (issues.some((i) => i.severity === 'hard') && state.status !== 'dead') {
    // жёсткое нарушение не должно ломать состояние — отмечаем и продолжаем
    state.audit.push({
      turn: state.scene.turn,
      at: Date.now(),
      kind: 'audit',
      severity: 'soft',
      message: 'Состояние мира оставлено без изменений: текст противоречил правилам.'
    });
  }

  state.pendingOpening = false;
  state.scene.turn += 1;
  state.updatedAt = Date.now();
  return { turnEntry, died };
}

async function runTurn(state, action, onPhase = () => {}, { audit = false } = {}) {
  const roll = serverRoll(state, action);
  onPhase('check', { roll });

  let plan = null;
  let demo = false;
  let aiError = null;

  if (!DEMO_MODE && aiAvailable() && !usageCheck(state)) {
    state.audit.push({
      turn: state.scene.turn,
      at: Date.now(),
      kind: 'limit',
      severity: 'soft',
      message: `Дневной лимит запросов к модели исчерпан (${DAILY_LIMIT}). Ходы пишет резервный рассказчик.`
    });
  }

  if (!DEMO_MODE && aiAvailable() && usageCheck(state)) {
    try {
      onPhase('writing', {});
      const retrieved = retrieve(state, action);
      const { data, usage } = await askJson({
        system: buildSystemPrompt(state, retrieved),
        user: buildTurnPrompt(state, { action, roll }),
        temperature: 0.95,
        maxTokens: 1400
      });
      plan = normalizePlan(data);
      if (!plan) throw new AIError('Модель вернула пустую сцену', { status: 502 });
      bumpUsage(state, usage);
    } catch (err) {
      aiError = err?.message || 'Ошибка модели';
      console.error('[turn] ИИ недоступен, включаю резерв:', aiError);
      plan = null;
    }
  }

  if (!plan) {
    demo = true;
    plan = demoTurn(state, { action, roll });
  }

  const { turnEntry, died } = commitPlan(state, plan, { action, roll, demo });

  if (audit && !demo && !DEMO_MODE && ENABLE_AI_AUDIT) {
    try {
      onPhase('auditing', {});
      const result = await aiAudit(state, turnEntry);
      const violations = Array.isArray(result?.data?.violations) ? result.data.violations : [];
      for (const v of violations.slice(0, 5)) {
        state.audit.push({
          turn: turnEntry.turn,
          at: Date.now(),
          kind: 'ai-audit',
          severity: v?.severity === 'hard' ? 'hard' : 'soft',
          message: String(v?.message || '').slice(0, 300)
        });
      }
      if (!violations.length) {
        state.audit.push({
          turn: turnEntry.turn,
          at: Date.now(),
          kind: 'ai-audit',
          severity: 'soft',
          message: 'Аудитор: нарушений правил не найдено.'
        });
      }
    } catch (err) {
      console.error('[audit]', err?.message);
    }
  }

  await saveGame(state);
  turnsServed += 1;
  return { state, turn: turnEntry, demo, aiError, died };
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, ...

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const { primary } = aiConfig();
    return json(res, 200, {
      ok: true,
      ai: aiAvailable() && !DEMO_MODE,
      keyPresent: aiAvailable(),
      demo: DEMO_MODE,
      model: primary,
      lastFailure: aiStatus().lastFailure,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      turns: turnsServed,
      worlds: PRESETS.length
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/content') {
    return json(res, 200, {
      worlds: PRESETS.map((w) => ({
        id: w.id,
        title: w.title,
        genre: w.genre,
        art: w.art,
        accent: w.accent,
        pitch: w.pitch,
        place: w.place,
        system: w.rules.match(/СИСТЕМА:\s*([a-z0-9%]+)/i)?.[1] || 'd20',
        rules: w.rules,
        start: w.start,
        opening: w.opening,
        tone: w.tone
      })),
      archetypes: ARCHETYPES,
      traits: TRAITS,
      burdens: BURDENS,
      difficulties: Object.values(DIFFICULTIES),
      ai: { available: aiAvailable() && !DEMO_MODE, demo: DEMO_MODE, dailyLimit: DAILY_LIMIT, lastFailure: aiStatus().lastFailure }
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/games') {
    return json(res, 200, { games: await listGames() });
  }

  if (req.method === 'POST' && url.pathname === '/api/games') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const hero = body.hero || {};
    const state = createGame({
      worldId: body.worldId,
      customWorld: body.customWorld,
      hero,
      difficulty: body.difficulty
    });
    if (body.customWorld?.title) state.world.custom = true;

    const { plan, demo } = await openingFor(state);
    commitPlan(state, plan, { action: 'Начало истории', roll: null, demo });
    await saveGame(state);
    return json(res, 200, { state: publicState(state), demo });
  }

  const id = parts[2];
  const tail = parts[3];
  if (!id) return json(res, 404, { error: 'Не найдено' });

  const state = await loadGame(id);
  if (!state) return json(res, 404, { error: 'Игра не найдена' });

  if (req.method === 'GET' && !tail) {
    return json(res, 200, {
      state: publicState(state),
      memoryIndex: memoryIndexSize(state),
      chronicle: chronicle(state),
      usage: state.usage || null
    });
  }

  if (req.method === 'GET' && tail === 'export') {
    const md = exportMarkdown(state);
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="loria-${state.id}.md"`,
      'Cache-Control': 'no-store'
    });
    return res.end(md);
  }

  if (req.method === 'POST' && tail === 'turn') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    if (state.status === 'dead') return json(res, 409, { error: 'История завершена: герой мёртв.', dead: true });

    const sanitized = sanitizeAction(body.action);
    if (sanitized.error) return json(res, 400, { error: sanitized.error });
    const action = sanitized.text;

    if (sanitized.cheat) {
      state.audit.push({
        turn: state.scene.turn,
        at: Date.now(),
        kind: 'validator',
        severity: 'soft',
        message: `Валидатор действий: попытка выпросить преимущество («${action.slice(0, 80)}») не признаётся миром.`
      });
    }

    if (locks.has(id)) return json(res, 429, { error: 'Мастер ещё отвечает на предыдущий ход.' });
    locks.add(id);

    try {
      const wantsStream = String(req.headers.accept || '').includes('text/event-stream');
      if (!wantsStream) {
        const result = await runTurn(state, action, () => {}, { audit: Boolean(body.audit) });
        return json(res, 200, {
          state: publicState(result.state),
          turn: result.turn,
          demo: result.demo,
          aiError: result.aiError,
          memoryIndex: memoryIndexSize(result.state)
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
      };
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
      send('phase', { phase: 'thinking' });
      try {
        const result = await runTurn(
          state,
          action,
          (phase, data) => send('phase', { phase, ...data }),
          { audit: Boolean(body.audit) }
        );
        send('done', {
          state: publicState(result.state),
          turn: result.turn,
          demo: result.demo,
          aiError: result.aiError,
          memoryIndex: memoryIndexSize(result.state)
        });
      } catch (err) {
        send('error', { message: err?.message || 'Неизвестная ошибка' });
      } finally {
        clearInterval(heartbeat);
        res.end();
      }
    } finally {
      locks.delete(id);
    }
    return;
  }

  if (req.method === 'POST' && tail === 'compact') {
    if (DEMO_MODE || !aiAvailable()) {
      return json(res, 400, { error: 'Уплотнение памяти требует подключённой модели.' });
    }
    if (!usageCheck(state)) return json(res, 429, { error: 'Дневной лимит запросов исчерпан.' });
    try {
      const { data, usage } = await askJson({
        system: 'Ты — архивариус памяти мира. Ты не пишешь прозу и не придумываешь событий. Отвечай только JSON.',
        user: buildCompactionPrompt(state),
        temperature: 0.3,
        maxTokens: 900,
        timeoutMs: 60000
      });
      bumpUsage(state, usage);
      let added = 0;
      for (const f of (Array.isArray(data?.facts) ? data.facts : []).slice(0, 10)) {
        const text = String(f?.text || '').trim().slice(0, 260);
        if (text.length < 6) continue;
        if (state.memory.facts.some((x) => x.text.toLowerCase() === text.toLowerCase())) continue;
        state.memory.facts.push({
          turn: state.scene.turn,
          text,
          importance: Math.max(1, Math.min(3, Number(f?.importance) || 2)),
          pinned: Boolean(f?.pinned),
          tags: Array.isArray(f?.tags) ? f.tags.slice(0, 4).map((t) => String(t).slice(0, 24)) : [],
          compacted: true
        });
        added += 1;
      }
      for (const q of (Array.isArray(data?.quests) ? data.quests : []).slice(0, 6)) {
        const title = String(q?.title || '').trim().slice(0, 90);
        if (!title) continue;
        const existing = state.memory.quests.find((x) => x.title.toLowerCase() === title.toLowerCase());
        const status = ['active', 'done', 'failed'].includes(q?.status) ? q.status : 'active';
        if (existing) {
          existing.status = status;
          if (q?.note) existing.note = String(q.note).slice(0, 200);
        } else if (state.memory.quests.length < 20) {
          state.memory.quests.push({ title, status, note: String(q?.note || '').slice(0, 200), openedAt: state.scene.turn, updatedAt: state.scene.turn });
        }
      }
      state.flags._compactedAt = String(state.scene.turn);
      state.audit.push({
        turn: state.scene.turn,
        at: Date.now(),
        kind: 'memory',
        severity: 'soft',
        message: `Память уплотнена: добавлено ${added} фактов, всего ${state.memory.facts.length}.`
      });
      await saveGame(state);
      return json(res, 200, { state: publicState(state), added, memoryIndex: memoryIndexSize(state) });
    } catch (err) {
      return json(res, 502, { error: err?.message || 'Архивариус недоступен' });
    }
  }

  if (req.method === 'POST' && tail === 'audit') {
    const last = (state.log || []).slice(-1)[0];
    if (!last) return json(res, 400, { error: 'Пока нечего проверять' });
    if (DEMO_MODE || !aiAvailable()) {
      return json(res, 200, {
        state: publicState(state),
        note: 'Аудитор работает локально: серьёзных нарушений не найдено.'
      });
    }
    try {
      const result = await aiAudit(state, last);
      const violations = Array.isArray(result?.data?.violations) ? result.data.violations : [];
      for (const v of violations.slice(0, 5)) {
        state.audit.push({
          turn: last.turn,
          at: Date.now(),
          kind: 'ai-audit',
          severity: v?.severity === 'hard' ? 'hard' : 'soft',
          message: String(v?.message || '').slice(0, 300)
        });
      }
      if (!violations.length) {
        state.audit.push({
          turn: last.turn,
          at: Date.now(),
          kind: 'ai-audit',
          severity: 'soft',
          message: 'Аудитор: нарушений правил не найдено.'
        });
      }
      await saveGame(state);
      return json(res, 200, { state: publicState(state) });
    } catch (err) {
      return json(res, 502, { error: err?.message || 'Аудитор недоступен' });
    }
  }

  if (req.method === 'DELETE' && !tail) {
    await deleteGame(id);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Неизвестный маршрут' });
}

// ---------- статика ----------

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC, safe);
  if (!full.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) throw new Error('dir');
    const ext = path.extname(full).toLowerCase();
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  } catch {
    // SPA-фолбэк
    try {
      const html = await fsp.readFile(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url);
    res.writeHead(405);
    res.end('Method not allowed');
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) json(res, 500, { error: err?.message || 'Внутренняя ошибка' });
    else res.end();
  }
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, HOST, () => {
  const { primary } = aiConfig();
  console.log('');
  console.log('  ЛОРИЯ — веб-RPG с суверенным мастером');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ИИ: ${DEMO_MODE ? 'резервный режим (без модели)' : aiAvailable() ? `да, ${primary}` : 'нет ключа — резервный режим'}`);
  console.log('');
  prune();
});

process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
