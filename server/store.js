// Хранилище: обычные JSON-файлы. Без базы, без миграций — можно копировать папку data/.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { makeId } from './state.js';
import { ARCHETYPES, arcForWorld } from './worlds.js';

// Папку сохранений можно увести наружу: .exe кладёт их рядом с собой или в AppData.
const ROOT = path.resolve(process.env.LORIA_DATA_DIR || 'data');
const GAMES = path.join(ROOT, 'games');

async function ensure() {
  await fs.mkdir(GAMES, { recursive: true });
}

function fileFor(id) {
  if (!/^[a-z0-9]{6,24}$/.test(id)) throw new Error('Некорректный id игры');
  return path.join(GAMES, `${id}.json`);
}

export async function saveGame(state) {
  await ensure();
  const file = fileFor(state.id);
  const tmp = `${file}.${process.pid}.tmp`;
  state.updatedAt = Date.now();
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, file);
  return state;
}

/** Аккуратно доводит старые сохранения до текущей схемы. */
export function migrate(state) {
  if (!state || typeof state !== 'object') return state;
  state.hero = state.hero || {};
  const hero = state.hero;
  if (!Number.isFinite(hero.boosts)) hero.boosts = 1;
  if (!Number.isFinite(hero.maxBoosts)) hero.maxBoosts = 1;
  if (!Number.isFinite(hero.level)) hero.level = 1;
  if (!Number.isFinite(hero.xp)) hero.xp = 0;
  if (typeof hero.pendingLevel !== 'boolean') hero.pendingLevel = false;
  if (!Array.isArray(hero.conditions)) hero.conditions = [];
  if (!Array.isArray(hero.items)) hero.items = [];
  if (!hero.portrait) {
    // Берём портрет из каталога архетипов: новые классы не требуют правок миграции.
    hero.portrait = ARCHETYPES.find((a) => a.id === hero.archetypeId)?.portrait || null;
  }
  state.memory = state.memory || { facts: [], chunks: [], npcs: [], quests: [], beats: [] };
  for (const key of ['facts', 'chunks', 'npcs', 'quests', 'beats']) {
    if (!Array.isArray(state.memory[key])) state.memory[key] = [];
  }
  state.audit = Array.isArray(state.audit) ? state.audit : [];
  state.log = Array.isArray(state.log) ? state.log : [];
  state.flags = state.flags && typeof state.flags === 'object' ? state.flags : {};
  state.stats = state.stats || { checks: 0, successes: 0, failures: 0, crits: 0, fumbles: 0, deaths: 0, drained: 0 };
  state.scene = state.scene || { location: 'Начало пути', time: 'неизвестно', weather: '', turn: 1, tension: 1 };
  // Сюжетная линия: старые сохранения получают арку своего мира с нуля.
  if (!state.arc || !Array.isArray(state.arc.steps) || !state.arc.steps.length) {
    const arc = arcForWorld(state.world);
    state.arc = { title: arc.title, steps: arc.steps, step: 0, advancedAt: state.scene.turn || 1, complete: false };
  }
  if (state.status === 'finished' && !state.finale) {
    state.finale = { text: '', epitaph: '', at: state.updatedAt || Date.now(), demo: true, model: null };
  }
  if (!Array.isArray(state.places)) state.places = [state.scene.location].filter(Boolean);
  return state;
}

export async function loadGame(id) {
  try {
    const raw = await fs.readFile(fileFor(id), 'utf8');
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function deleteGame(id) {
  try {
    await fs.unlink(fileFor(id));
    return true;
  } catch {
    return false;
  }
}

export async function listGames(limit = 40) {
  await ensure();
  const files = await fs.readdir(GAMES);
  const games = [];
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(GAMES, name), 'utf8');
      const s = JSON.parse(raw);
      games.push({
        id: s.id,
        title: s.world?.title,
        genre: s.world?.genre,
        art: s.world?.art,
        accent: s.world?.accent,
        heroName: s.hero?.name,
        archetype: s.hero?.archetype,
        turn: s.scene?.turn || 1,
        status: s.status,
        difficulty: s.difficulty?.name,
        worldId: s.world?.id,
        level: s.hero?.level || 1,
        quests: (s.memory?.quests || []).filter((q) => q.status === 'active').length,
        arcTitle: s.arc?.title || '',
        arcStep: Number(s.arc?.step) || 0,
        arcTotal: Array.isArray(s.arc?.steps) ? s.arc.steps.length : 0,
        updatedAt: s.updatedAt || s.createdAt,
        hp: `${s.hero?.hp}/${s.hero?.maxHp}`
      });
    } catch {
      /* пропускаем битый файл */
    }
  }
  games.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return games.slice(0, limit);
}

/** Уборка: старше 21 дня и больше 300 игр — удаляем самые старые. */
export async function prune() {
  try {
    const files = (await fs.readdir(GAMES)).filter((f) => f.endsWith('.json'));
    const entries = [];
    for (const name of files) {
      const full = path.join(GAMES, name);
      const stat = fsSync.statSync(full);
      entries.push({ full, mtime: stat.mtimeMs });
    }
    const cutoff = Date.now() - 21 * 24 * 3600 * 1000;
    entries.sort((a, b) => b.mtime - a.mtime);
    for (let i = 0; i < entries.length; i++) {
      if (i >= 300 || entries[i].mtime < cutoff) {
        try {
          fsSync.unlinkSync(entries[i].full);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

const REQUIRED = ['hero', 'world', 'scene'];

/** Импорт сохранения: проверяем форму и выдаём новый id. */
export async function importGame(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Это не JSON-файл сохранения');
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Пустой файл');
  for (const key of REQUIRED) {
    if (!parsed[key] || typeof parsed[key] !== 'object') throw new Error(`В файле нет раздела «${key}»`);
  }
  if (!parsed.hero.name && !parsed.hero.archetypeId) throw new Error('В файле нет героя');
  const state = migrate(structuredClone(parsed));
  state.id = makeId(12);
  state.createdAt = state.createdAt || Date.now();
  state.updatedAt = Date.now();
  state.importedAt = Date.now();
  state.importedFrom = parsed.id || null;
  state.snapshots = [];
  state.status = state.hero.hp > 0 ? 'active' : 'dead';
  state.hero.alive = state.hero.hp > 0;
  state.audit = state.audit || [];
  state.audit.push({
    turn: state.scene?.turn || 1,
    at: Date.now(),
    kind: 'import',
    severity: 'soft',
    message: `История импортирована из файла${parsed.id ? ` (${parsed.id})` : ''}.`
  });
  await saveGame(state);
  return state;
}

export function exportMarkdown(state) {
  const lines = [];
  lines.push(`# ${state.world.title} — хроника`);
  lines.push('');
  lines.push(`**Герой:** ${state.hero.name}, ${state.hero.archetype} · ${state.difficulty.name}`);
  lines.push(`**Мир:** ${state.world.genre} · ходов: ${state.scene.turn - 1}`);
  const finaleKind = state.status === 'dead' ? 'смерть' : state.status === 'finished' ? 'финал' : 'история не закончена';
  lines.push(`**Финал:** ${finaleKind}`);
  if (state.arc?.title) {
    lines.push(`**Линия:** «${state.arc.title}» — шаг ${state.arc.step || 0} из ${state.arc.steps?.length || 0}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const [index, entry] of (state.log || []).entries()) {
    lines.push(`### Ход ${entry.turn}`);
    lines.push('');
    if (entry.check) {
      lines.push(`> Бросок: ${entry.check.stat} · ${entry.check.formula} = **${entry.check.total}** против ${entry.check.dc} — ${entry.check.verdict}`);
      lines.push('');
    } else if (index > 0) {
      lines.push('> Без броска: действие не требовало проверки.');
      lines.push('');
    }
    lines.push(`**Действие:** ${entry.action}`);
    lines.push('');
    lines.push(entry.narration);
    lines.push('');
  }
  if (state.status === 'finished' && state.finale?.text) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Финал');
    lines.push('');
    if (state.finale.epitaph) {
      lines.push(`> ${state.finale.epitaph}`);
      lines.push('');
    }
    lines.push(state.finale.text);
    lines.push('');
  }
  if (state.memory?.facts?.length) {
    lines.push('---');
    lines.push('');
    lines.push('## Память мира');
    lines.push('');
    for (const f of state.memory.facts) lines.push(`- [ход ${f.turn}] ${f.text}${f.pinned ? ' _(незыблемо)_' : ''}`);
    lines.push('');
  }
  if (state.memory?.npcs?.length) {
    lines.push('## NPC');
    lines.push('');
    for (const n of state.memory.npcs) lines.push(`- **${n.name}** (отношение ${n.attitude}): ${n.note || '—'}`);
    lines.push('');
  }
  if (state.audit?.length) {
    lines.push('## Аудит');
    lines.push('');
    for (const a of state.audit) lines.push(`- [ход ${a.turn}] ${a.message}`);
  }
  return lines.join('\n');
}
