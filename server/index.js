import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv } from './env.js';
loadEnv();

import { aiAvailable, aiConfig, aiStatus } from './ai.js';
import { sanitizeAction, noteCheatAttempt, runTurn, startNewGame, forkGame, compactStateMemory, engineStats, DEMO_MODE, rest, rewind, levelUp } from './engine.js';
import { publicState, levelChoices } from './state.js';
import { PRESETS, ARCHETYPES, TRAITS, BURDENS, DIFFICULTIES } from './worlds.js';
import { saveGame, loadGame, listGames, deleteGame, exportMarkdown, prune, importGame } from './store.js';
import { aiAudit } from './auditor.js';
import { memoryIndexSize, chronicle } from './memory.js';
import { DAILY_LIMIT, PORT, HOST, MAX_CREATES_PER_HOUR } from './config.js';

// В обычном запуске — папка public рядом с server/. В собранном .exe (SEA)
// путь приходит из LORIA_PUBLIC_DIR: лаунчер распаковывает встроенные файлы.
const HERE = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = process.env.LORIA_PUBLIC_DIR
  ? path.resolve(process.env.LORIA_PUBLIC_DIR)
  : path.resolve(HERE, '..', 'public');

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

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN'
};

const locks = new Set();
const lastTurnAt = new Map();
const MIN_TURN_GAP_MS = Number(process.env.LORIA_MIN_TURN_GAP_MS ?? 700);
const startedAt = Date.now();
const createdByIp = new Map();

// ---------- утилиты ----------

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function creationAllowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const bucket = createdByIp.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < 3600_000);
  if (MAX_CREATES_PER_HOUR > 0 && fresh.length >= MAX_CREATES_PER_HOUR) {
    createdByIp.set(ip, fresh);
    return false;
  }
  fresh.push(now);
  createdByIp.set(ip, fresh);
  if (createdByIp.size > 5000) createdByIp.clear();
  return true;
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

// ---------- API ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);

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
      turns: engineStats().turnsServed,
      worlds: PRESETS.length
    });
  }

  // Фокус уже открытого окна: лаунчер подменяет обработчик на живое окно.
  if (req.method === 'POST' && url.pathname === '/api/focus') {
    const handler = globalThis.__loriaFocus;
    if (typeof handler === 'function') {
      try {
        await handler();
        return json(res, 200, { ok: true });
      } catch {
        /* окно уже закрыто */
      }
    }
    return json(res, 200, { ok: false });
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
      ai: {
        available: aiAvailable() && !DEMO_MODE,
        demo: DEMO_MODE,
        dailyLimit: DAILY_LIMIT,
        lastFailure: aiStatus().lastFailure
      }
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
    if (!creationAllowed(req)) {
      return json(res, 429, { error: 'Слишком много новых историй за час. Дай миру передохнуть.' });
    }
    try {
      const { state, demo } = await startNewGame({
        worldId: body.worldId,
        customWorld: body.customWorld,
        hero: body.hero || {},
        difficulty: body.difficulty
      });
      return json(res, 200, { state: publicState(state), demo });
    } catch (err) {
      console.error('[create]', err);
      return json(res, 500, { error: 'Мир не открылся. Попробуй ещё раз.' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/import') {
    let body;
    try {
      body = await readBody(req, 2 * 1024 * 1024);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    if (!creationAllowed(req)) return json(res, 429, { error: 'Слишком много новых историй за час.' });
    try {
      const imported = await importGame(body?.state ?? body);
      return json(res, 200, { state: publicState(imported) });
    } catch (err) {
      return json(res, 400, { error: err?.message || 'Файл не похож на сохранение Лории' });
    }
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

  // Постраничная история: интерфейс показывает последние 60 ходов,
  // старые догружаются порциями, чтобы длинные партии не теряли начало.
  if (req.method === 'GET' && tail === 'turns') {
    const log = Array.isArray(state.log) ? state.log : [];
    const beforeRaw = Number(url.searchParams.get('before'));
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(60, Math.floor(limitRaw))) : 30;
    const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.min(log.length, Math.floor(beforeRaw)) : log.length;
    const from = Math.max(0, before - limit);
    return json(res, 200, {
      turns: log.slice(from, before),
      from,
      before,
      total: log.length,
      hasMore: from > 0
    });
  }

  if (req.method === 'GET' && tail === 'download') {
    const body = JSON.stringify(state, null, 2);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="loria-save-${state.id}.json"`,
      'Cache-Control': 'no-store'
    });
    return res.end(body);
  }

  if (req.method === 'GET' && tail === 'export') {
    const md = exportMarkdown(state);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
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
    if (sanitized.cheat) noteCheatAttempt(state, action);

    if (locks.has(id)) return json(res, 429, { error: 'Мастер ещё отвечает на предыдущий ход.' });
    const gap = Date.now() - (lastTurnAt.get(id) || 0);
    if (gap < MIN_TURN_GAP_MS) {
      return json(res, 429, { error: 'Слишком часто: мастер не успевает выдохнуть.' });
    }
    lastTurnAt.set(id, Date.now());
    locks.add(id);

    try {
      const wantsStream = String(req.headers.accept || '').includes('text/event-stream');
      if (!wantsStream) {
        const result = await runTurn(state, action, () => {}, { audit: Boolean(body.audit), boost: Boolean(body.boost) });
        return json(res, 200, {
          state: publicState(result.state),
          turn: result.turn,
          demo: result.demo,
          aiError: result.aiError,
          memoryIndex: memoryIndexSize(result.state)
        });
      }

      res.writeHead(200, {
        ...SECURITY_HEADERS,
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
        const result = await runTurn(state, action, (phase, data) => send('phase', { phase, ...data }), {
          audit: Boolean(body.audit),
          boost: Boolean(body.boost)
        });
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

  if (req.method === 'GET' && tail === 'levels') {
    return json(res, 200, { level: state.hero.level, xp: state.hero.xp, next: 10 * state.hero.level, choices: levelChoices(state.hero) });
  }

  if (req.method === 'POST' && tail === 'levelup') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    try {
      const result = await levelUp(state, String(body.choice || ''));
      return json(res, 200, { state: publicState(result.state), choice: result.choice, choices: result.choices });
    } catch (err) {
      return json(res, err.status === 400 ? 400 : 500, { error: err?.message || 'Улучшение не применилось' });
    }
  }

  if (req.method === 'POST' && tail === 'rewind') {
    try {
      const result = await rewind(state);
      return json(res, 200, { state: publicState(result.state), undoneTurn: result.undoneTurn, remaining: result.remaining });
    } catch (err) {
      return json(res, err.status === 400 ? 400 : 500, { error: err?.message || 'Отмена не удалась' });
    }
  }

  if (req.method === 'POST' && tail === 'rest') {
    if (state.status === 'dead') return json(res, 409, { error: 'История завершена.', dead: true });
    const result = await rest(state);
    if (result.error) return json(res, 400, { error: result.error });
    return json(res, 200, { state: publicState(result.state) });
  }

  if (req.method === 'POST' && tail === 'fork') {
    try {
      const copy = await forkGame(state);
      return json(res, 200, { state: publicState(copy) });
    } catch (err) {
      return json(res, 500, { error: err?.message || 'Не удалось создать ветку' });
    }
  }

  if (req.method === 'POST' && tail === 'compact') {
    try {
      const { state: updated, added } = await compactStateMemory(state);
      return json(res, 200, { state: publicState(updated), added, memoryIndex: memoryIndexSize(updated) });
    } catch (err) {
      return json(res, err.status === 400 ? 400 : err.status === 429 ? 429 : 502, {
        error: err?.message || 'Архивариус недоступен'
      });
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
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  } catch {
    try {
      const html = await fsp.readFile(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
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
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
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

export { server };
