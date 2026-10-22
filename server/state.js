// Состояние игры: герой, сцена, память, аудит.
// Всё, что меняет цифры, проходит через аудитора state.js — модель только предлагает.

import { DIFFICULTIES, detectSystem, getPreset, makeCustomWorld, ARCHETYPES, TRAITS, BURDENS } from './worlds.js';
import { STATS, guessStat, rollCheck, resolveCheck, systemInfo, actionDifficulty } from './dice.js';

export function makeId(len = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export function makeHero({ name, archetypeId, traitId, burdenId, custom }) {
  const archetype = ARCHETYPES.find((a) => a.id === archetypeId) || ARCHETYPES[0];
  const trait = TRAITS.find((t) => t.id === traitId) || TRAITS[1];
  const burden = BURDENS.find((b) => b.id === burdenId) || BURDENS[0];
  const stats = { ...archetype.stats };
  for (const s of STATS) {
    if (Number.isFinite(custom?.stats?.[s])) stats[s] = clamp(Math.round(custom.stats[s]), 1, 9);
  }
  const maxHp = 10 + stats.Сила + stats.Воля + (burden.id === 'scar' ? -2 : 0);
  return {
    name: str(name, 32) || 'Безымянный',
    archetype: archetype.name,
    archetypeId: archetype.id,
    tagline: archetype.tagline,
    trait: { ...trait },
    burden: { ...burden },
    appearance: str(custom?.appearance, 240),
    bio: str(custom?.bio, 400) || archetype.hook,
    stats,
    hp: maxHp,
    maxHp,
    energy: 24,
    maxEnergy: 24,
    gold: 15,
    portrait: archetype.portrait,
    items: [...archetype.items],
    conditions: [],
    boosts: 1,
    maxBoosts: 1,
    xp: 0,
    level: 1,
    pendingLevel: false,
    alive: true
  };
}

export function createGame({ worldId, customWorld, hero: heroInput, difficulty = 'grim' }) {
  const world = customWorld
    ? makeCustomWorld({ ...customWorld, id: 'custom' })
    : getPreset(worldId) || getPreset('ash');
  const diff = DIFFICULTIES[difficulty] || DIFFICULTIES.grim;
  const hero = makeHero(heroInput || {});
  hero.maxHp = Math.max(4, hero.maxHp + diff.hpBonus);
  hero.hp = hero.maxHp;

  const system = detectSystem(world.rules);
  const now = Date.now();
  return {
    id: makeId(12),
    createdAt: now,
    updatedAt: now,
    seed: Math.floor(Math.random() * 1e9),
    version: 1,
    status: 'active',
    world: { ...world, system },
    difficulty: { id: diff.id, name: diff.name, desc: diff.desc },
    system,
    hero,
    places: [world.place || 'Начало пути'],
    scene: {
      location: world.place || 'Начало пути',
      time: 'неизвестно',
      weather: '',
      turn: 1,
      tension: 1,
      lastCheck: null
    },
    memory: { facts: [], chunks: [], npcs: [], quests: [], beats: [] },
    flags: {},
    stats: { checks: 0, successes: 0, failures: 0, crits: 0, fumbles: 0, deaths: 0, drained: 0 },
    log: [],
    audit: [],
    pendingOpening: true
  };
}

/** Собирает броско́к под основное рискованное действие хода. */
export function serverRoll(state, action, hint, { boost = false } = {}) {
  const system = state.world?.system || 'd20';
  const sys = systemInfo(system);
  const stat = STATS.includes(hint?.stat) ? hint.stat : guessStat(action, state.hero);
  const statValue = num(state.hero?.stats?.[stat], 4);
  const fatigue = (state.hero?.energy ?? 10) <= 5 || (state.hero?.conditions || []).includes('Истощён');
  let roll = rollCheck({ system, stat, statValue, fatigue });
  let boosted = false;
  if (boost && (state.hero.boosts || 0) > 0) {
    const second = rollCheck({ system, stat, statValue, fatigue });
    if (second.total > roll.total) {
      roll = { ...second, rerolledFrom: roll };
      boosted = true;
    } else {
      roll = { ...roll, rerolledFrom: second };
      boosted = true;
    }
    state.hero.boosts = Math.max(0, (state.hero.boosts || 0) - 1);
    hero_boost_spent(state);
  }
  const suggestedDc = hint?.dc;
  const dc = Number.isFinite(Number(suggestedDc))
    ? clamp(Math.round(Number(suggestedDc)), sys.dc.easy - 2, sys.dc.extreme + 2)
    : actionDifficulty(action, system);
  const resolution = resolveCheck(roll, dc);
  return { ...roll, ...resolution, boosted };
}

function hero_boost_spent(state) {
  state.audit.push({
    turn: state.scene.turn,
    at: Date.now(),
    kind: 'boost',
    severity: 'soft',
    message: 'Рывок: второй бросок, взят лучший результат. Ещё один рывок — после отдыха.'
  });
}

export const XP_PER_LEVEL = 10;

const LEVEL_CHOICES = {
  hp: { id: 'hp', name: '+2 к максимуму здоровья', apply: (hero) => { hero.maxHp += 2; hero.hp = Math.min(hero.maxHp, hero.hp + 2); } },
  energy: { id: 'energy', name: '+3 к максимуму энергии', apply: (hero) => { hero.maxEnergy += 3; hero.energy = Math.min(hero.maxEnergy, hero.energy + 3); } },
  boosts: { id: 'boosts', name: '+1 рывок за отдых', apply: (hero) => { hero.maxBoosts += 1; hero.boosts = hero.maxBoosts; } }
};

for (const stat of STATS) {
  LEVEL_CHOICES[`stat:${stat}`] = {
    id: `stat:${stat}`,
    name: `+1 ${stat}`,
    stat,
    apply: (hero) => { hero.stats[stat] = Math.min(9, hero.stats[stat] + 1); }
  };
}

export function levelChoices(hero) {
  return Object.values(LEVEL_CHOICES)
    .filter((c) => !c.stat || hero.stats[c.stat] < 9)
    .map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Опыт даётся за выживание, а не за победы: провал тоже учит, но меньше.
 * Критический провал опыта не даёт вовсе — мир запомнил, а ты нет.
 */
export function awardExperience(state, roll) {
  const hero = state.hero;
  if (!hero || !roll || state.status === 'dead') return { gained: 0 };
  let gained = 1;
  if (roll.success) gained += 1;
  if (roll.critical) gained += 2;
  if (roll.fumble) gained = 0;

  const tension = state.scene?.tension || 1;
  if (tension >= 4 && gained > 0) gained += 1;

  if (!gained) return { gained: 0 };

  hero.xp = (hero.xp || 0) + gained;
  let leveled = false;
  while (hero.xp >= XP_PER_LEVEL * (hero.level || 1) && (hero.level || 1) < 12) {
    hero.xp -= XP_PER_LEVEL * (hero.level || 1);
    hero.level = (hero.level || 1) + 1;
    hero.pendingLevel = true;
    leveled = true;
  }
  if (leveled) {
    state.audit.push({
      turn: state.scene.turn,
      at: Date.now(),
      kind: 'level',
      severity: 'soft',
      message: `Новый уровень ${hero.level}: герой выжил достаточно, чтобы стать сильнее. Выбери улучшение.`
    });
  }
  return { gained, leveled };
}

/** Улучшение при новом уровне. Список — только серверный, модель сюда не допускается. */
export function applyLevelUp(state, choiceId) {
  const hero = state.hero;
  if (!hero?.pendingLevel) return { error: 'Новый уровень ещё не получен.' };
  const choice = LEVEL_CHOICES[choiceId];
  if (!choice) return { error: 'Такого улучшения нет.' };
  if (choice.stat && hero.stats[choice.stat] >= 9) return { error: `${choice.stat} уже на максимуме.` };

  choice.apply(hero);
  hero.pendingLevel = false;
  hero.levelUps = (hero.levelUps || 0) + 1;
  state.audit.push({
    turn: state.scene.turn,
    at: Date.now(),
    kind: 'level',
    severity: 'soft',
    message: `Уровень ${hero.level}: ${choice.name}.`
  });
  state.updatedAt = Date.now();
  return { ok: true, choice: choice.name, hero };
}

/** Передышка: энергия в здоровье, без обращения к модели. */
export function restHero(state) {
  const hero = state.hero;
  if (state.status === 'dead') return { error: 'Герой мёртв.' };
  if (hero.energy < 6) return { error: 'Не хватает энергии даже на передышку.' };
  const fullHp = hero.hp >= hero.maxHp && hero.conditions.length === 0;
  const boostReady = (hero.boosts || 0) >= (hero.maxBoosts || 1);
  if (fullHp && boostReady) return { error: 'Герой в порядке, рывок готов. Передышка пока не нужна.' };

  const before = hero.hp;
  hero.energy = Math.max(0, hero.energy - 6);
  hero.hp = Math.min(hero.maxHp, hero.hp + 4);
  if (hero.conditions.includes('Истощён')) hero.conditions = hero.conditions.filter((c) => c !== 'Истощён');
  if (hero.hp > 8 && hero.conditions.includes('На волоске')) {
    hero.conditions = hero.conditions.filter((c) => c !== 'На волоске');
  }
  if (hero.boosts < hero.maxBoosts) hero.boosts = hero.maxBoosts;
  state.scene.turn += 1;
  state.audit.push({
    turn: state.scene.turn,
    at: Date.now(),
    kind: 'rest',
    severity: 'soft',
    message: `Передышка: HP ${before} → ${hero.hp}, энергия −6. Рывок восстановлен.`
  });
  state.updatedAt = Date.now();
  return { ok: true, hp: hero.hp, energy: hero.energy };
}

function pushAudit(state, entry) {
  state.audit.push({ turn: state.scene.turn, at: Date.now(), ...entry });
  if (state.audit.length > 200) state.audit = state.audit.slice(-200);
}

function applyConditions(hero, conditions) {
  if (!Array.isArray(conditions)) return;
  const next = [];
  for (const raw of conditions.slice(0, 10)) {
    const text = str(raw, 40);
    if (!text) continue;
    if (next.length >= 5) break;
    if (!next.includes(text)) next.push(text);
  }
  hero.conditions = next;
}

/**
 * Применяет предложения модели к состоянию — с жёсткими ограничениями.
 * Возвращает список сработавших ограничений для панели аудитора.
 */
export function applyDeltas(state, deltas = {}, options = {}) {
  const diff = DIFFICULTIES[state.difficulty?.id] || DIFFICULTIES.grim;
  const hero = state.hero;
  const before = { hp: hero.hp, energy: hero.energy, gold: hero.gold };
  const notes = [];
  const flagsBefore = { ...state.flags };

  // --- Здоровье ---
  if (Number.isFinite(Number(deltas.hp))) {
    const requested = Math.round(Number(deltas.hp));
    const capped = clamp(requested, -20, 4);
    if (capped !== requested) notes.push(`здоровье ${requested > 0 ? '+' : ''}${requested} → ${capped > 0 ? '+' : ''}${capped}: предел изменения за ход (от −20 до +4)`);
    hero.hp = clamp(hero.hp + capped, 0, hero.maxHp);
  }

  // --- Энергия ---
  const actionText = options.action || '';
  const movement = /(иду|бегу|спуска|поднима|путь|дорог|еду|лечу|плыв|пробира|переход|идти)/i.test(actionText);
  const resting = /(отдых|сплю|сон|привал|зализ|перевяз|сижу|жду|дышу|успока|перекус|ем |пью|кофе|чай)/i.test(actionText);
  let energyCost = options.free ? 0 : diff.energyCost + (movement ? 2 : 0);
  if (resting) energyCost -= 8;
  if (Number.isFinite(Number(deltas.energy))) {
    const requested = Math.round(Number(deltas.energy));
    if (requested > 0) {
      const capped = Math.min(requested, 8);
      if (capped !== requested) notes.push(`энергия +${requested} → +${capped}: восстановление ограничено`);
      hero.energy = clamp(hero.energy + capped, 0, hero.maxEnergy);
    } else {
      energyCost += clamp(-requested, 0, 4);
    }
  }
  // пассивное восстановление: даже в аду иногда дают выдохнуть
  hero.energy = clamp(hero.energy + (options.free ? 0 : 2) - energyCost, 0, hero.maxEnergy);
  state.stats.drained += Math.max(0, energyCost - 2);

  // --- Золото ---
  if (Number.isFinite(Number(deltas.gold))) {
    const requested = Math.round(Number(deltas.gold));
    const maxLoss = Math.min(hero.gold, 60);
    const capped = clamp(requested, -maxLoss, diff.goldLimit);
    if (capped !== requested) {
      notes.push(
        `золото ${requested > 0 ? '+' : ''}${requested} → ${capped > 0 ? '+' : ''}${capped}: лимит мира ${diff.goldLimit} за ход`
      );
    }
    hero.gold = clamp(hero.gold + capped, 0, 9999);
  }

  // --- Предметы ---
  if (Array.isArray(deltas.addItems)) {
    for (const raw of deltas.addItems.slice(0, 3)) {
      const item = str(raw, 60);
      if (!item) continue;
      if (hero.items.length >= 16) {
        notes.push('инвентарь переполнен: предмет отброшен');
        break;
      }
      if (!hero.items.some((i) => i.toLowerCase() === item.toLowerCase())) hero.items.push(item);
    }
  }
  if (Array.isArray(deltas.removeItems)) {
    for (const raw of deltas.removeItems.slice(0, 3)) {
      const item = str(raw, 60).toLowerCase();
      const idx = hero.items.findIndex((i) => i.toLowerCase() === item);
      if (idx === -1) {
        notes.push(`нечего убрать: «${raw}» нет в инвентаре`);
        continue;
      }
      hero.items.splice(idx, 1);
    }
  }

  // --- Состояния ---
  applyConditions(hero, deltas.conditions);

  // --- Мир ---
  if (deltas.location) {
    const next = str(deltas.location, 80);
    if (next && next !== state.scene.location) {
      state.places = Array.isArray(state.places) ? state.places : [];
      if (!state.places.includes(next)) {
        state.places.push(next);
        if (state.places.length > 24) state.places = state.places.slice(-24);
      }
    }
    state.scene.location = next;
  }
  if (deltas.time) state.scene.time = str(deltas.time, 40);
  if (deltas.weather) state.scene.weather = str(deltas.weather, 40);
  if (Number.isFinite(Number(deltas.tension))) {
    state.scene.tension = clamp(Math.round(Number(deltas.tension)), 0, 5);
  }

  // --- Флаги ---
  if (deltas.flags && typeof deltas.flags === 'object' && !Array.isArray(deltas.flags)) {
    for (const [key, value] of Object.entries(deltas.flags).slice(0, 12)) {
      const k = str(key, 36);
      if (!k) continue;
      const v = typeof value === 'object' ? JSON.stringify(value).slice(0, 120) : str(value, 120);
      if (Object.keys(state.flags).length >= 80 && !(k in state.flags)) {
        notes.push('лимит флагов мира достигнут');
        break;
      }
      state.flags[k] = v;
    }
  }

  // --- Квесты ---
  if (Array.isArray(deltas.quests)) {
    for (const q of deltas.quests.slice(0, 3)) {
      const title = str(q?.title, 90);
      if (!title) continue;
      const status = ['active', 'done', 'failed'].includes(q?.status) ? q.status : 'active';
      const existing = state.memory.quests.find((x) => x.title.toLowerCase() === title.toLowerCase());
      if (existing) {
        existing.status = status;
        if (q?.note) existing.note = str(q.note, 200);
        existing.updatedAt = state.scene.turn;
      } else if (state.memory.quests.length < 20) {
        state.memory.quests.push({
          title,
          status,
          note: str(q?.note, 200),
          openedAt: state.scene.turn,
          updatedAt: state.scene.turn
        });
      } else {
        notes.push('журнал заданий переполнен');
      }
    }
  }

  // --- Смерть и милосердие ---
  if (hero.hp <= 0 && hero.alive) {
    if (diff.mercy && !state.flags._mercyUsed) {
      hero.hp = 1;
      state.flags._mercyUsed = 'да';
      if (!hero.conditions.includes('На волоске')) hero.conditions.push('На волоске');
      notes.push('милосердие: смерть заменена состоянием «На волоске»');
    } else {
      hero.alive = false;
      hero.hp = 0;
      state.status = 'dead';
      state.stats.deaths += 1;
      state.scene.tension = 5;
    }
  }

  // --- Аудит ---
  const changes = [];
  if (hero.hp !== before.hp) changes.push(`HP ${before.hp} → ${hero.hp}`);
  if (hero.energy !== before.energy) changes.push(`энергия ${before.energy} → ${hero.energy}`);
  if (hero.gold !== before.gold) changes.push(`золото ${before.gold} → ${hero.gold}`);
  for (const flag of Object.keys(state.flags)) {
    if (!(flag in flagsBefore)) changes.push(`флаг: ${flag}`);
  }
  if (notes.length || changes.length) {
    pushAudit(state, {
      kind: notes.length ? 'limit' : 'apply',
      message: notes.length ? notes.join('; ') : changes.join(' · '),
      requested: deltas
    });
  }

  return { notes, changes };
}

export function heroSummary(hero) {
  const statLine = STATS.map((s) => `${s} ${hero.stats[s]}`).join(', ');
  return `${hero.name}, ${hero.archetype} (${statLine}). HP ${hero.hp}/${hero.maxHp}, энергия ${hero.energy}/${hero.maxEnergy}, золото ${hero.gold}. ` +
    `Черта: ${hero.trait.name}. Бремя: ${hero.burden.name}. Состояния: ${hero.conditions.join(', ') || 'нет'}. ` +
    `Инвентарь: ${hero.items.join(', ') || 'пусто'}.`;
}

/** Публичное представление состояния для клиента. */
export function publicState(state) {
  const { log, audit, snapshots, ...rest } = state;
  const full = Array.isArray(log) ? log : [];
  const from = Math.max(0, full.length - 60);
  return {
    ...rest,
    rewinds: Array.isArray(snapshots) ? snapshots.length : 0,
    // В браузер уходят последние 60 ходов, но старые можно догрузить по /turns.
    log: full.slice(-60),
    logTotal: full.length,
    logFrom: from,
    audit: (audit || []).slice(-40)
  };
}

export function gameOver(state, reason) {
  state.status = 'dead';
  state.hero.alive = false;
  state.hero.hp = 0;
  state.stats.deaths += 1;
  state.deathReason = str(reason, 400);
  state.updatedAt = Date.now();
  return state;
}
