// Хранилище: обычные JSON-файлы. Без базы, без миграций — можно копировать папку data/.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('data');
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

export async function loadGame(id) {
  try {
    const raw = await fs.readFile(fileFor(id), 'utf8');
    return JSON.parse(raw);
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

export function exportMarkdown(state) {
  const lines = [];
  lines.push(`# ${state.world.title} — хроника`);
  lines.push('');
  lines.push(`**Герой:** ${state.hero.name}, ${state.hero.archetype} · ${state.difficulty.name}`);
  lines.push(`**Мир:** ${state.world.genre} · ходов: ${state.scene.turn - 1}`);
  lines.push(`**Финал:** ${state.status === 'dead' ? 'смерть' : 'история не закончена'}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const entry of state.log || []) {
    lines.push(`### Ход ${entry.turn}`);
    lines.push('');
    if (entry.check) {
      lines.push(`> Бросок: ${entry.check.stat} · ${entry.check.formula} = **${entry.check.total}** против ${entry.check.dc} — ${entry.check.verdict}`);
      lines.push('');
    }
    lines.push(`**Действие:** ${entry.action}`);
    lines.push('');
    lines.push(entry.narration);
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
