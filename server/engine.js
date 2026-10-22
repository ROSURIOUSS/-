// Игровой движок: один на веб и на Telegram. Транспорт сюда не заглядывает.

import { aiAvailable, askJson, AIError } from './ai.js';
import { buildSystemPrompt, buildTurnPrompt, buildOpeningPrompt, buildCompactionPrompt } from './prompts.js';
import { retrieve, rememberTurn } from './memory.js';
import { createGame, serverRoll, applyDeltas, gameOver, makeId, restHero, awardExperience, applyLevelUp, levelChoices } from './state.js';
import { saveGame } from './store.js';
import { localAudit, aiAudit } from './auditor.js';
import { demoOpening, demoTurn } from './demo.js';
import { DAILY_LIMIT, ENABLE_AI_AUDIT, demoMode } from './config.js';

export const DEMO_MODE = demoMode(aiAvailable());

let turnsServed = 0;
export function engineStats() {
  return { turnsServed };
}

// ---------- служебное ----------

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function resetUsageIfNeeded(state) {
  if (!state.usage || state.usage.date !== todayKey()) {
    state.usage = { date: todayKey(), requests: 0, promptTokens: 0, completionTokens: 0 };
  }
  return state.usage;
}

export function usageCheck(state) {
  return resetUsageIfNeeded(state).requests < DAILY_LIMIT;
}

export function bumpUsage(state, usage, ok = true) {
  resetUsageIfNeeded(state);
  if (ok) state.usage.requests += 1;
  if (usage) {
    state.usage.promptTokens += Number(usage.prompt_tokens || 0);
    state.usage.completionTokens += Number(usage.completion_tokens || 0);
  }
}

const CHEAT_RE =
  /(у меня (уже )?(есть|было|появилось)[^.!?]{0,24}\d{2,}|я (уже )?(бессмерт|всемогущ|неуязвим)|я (выдаю|добавляю) себе|установить себе (золот|уровень)|\+\s*\d{2,}\s*(золот|монет|hp|хп|уровень)|god ?mode|\/give|\/setlevel|\/spawn|чит-код)/i;

export function sanitizeAction(raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: 'Пустое действие' };
  if (text.length > 600) text = text.slice(0, 600);
  return { text, cheat: CHEAT_RE.test(text) };
}

export function noteCheatAttempt(state, action) {
  state.audit.push({
    turn: state.scene.turn,
    at: Date.now(),
    kind: 'validator',
    severity: 'soft',
    message: `Валидатор действий: попытка выпросить преимущество («${String(action).slice(0, 80)}») не признаётся миром.`
  });
}

/** Проверка и нормализация ответа модели. */
export function normalizePlan(data, { minNarration = 120 } = {}) {
  if (!data || typeof data !== 'object') return null;
  const narration = String(data.narration || '').trim();
  if (narration.length < minNarration) return null;
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
    options.push(['Осмотреться внимательнее', 'Действовать прямо', 'Отступить и подумать'][options.length] || 'Продолжить');
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

function mergeUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    prompt_tokens: Number(a.prompt_tokens || 0) + Number(b.prompt_tokens || 0),
    completion_tokens: Number(a.completion_tokens || 0) + Number(b.completion_tokens || 0)
  };
}

/** Запрос сцены с одной попыткой починки, если модель вернула не JSON. */
async function askScene({ system, user, temperature = 0.95, maxTokens = 1400, minNarration }) {
  const first = await askJson({ system, user, temperature, maxTokens });
  let plan = normalizePlan(first.data, { minNarration });
  if (plan) {
    return { plan, usage: first.usage, model: first.model, repaired: false };
  }

  const strict = `${system}

ВАЖНО: предыдущий ответ не удалось разобрать. Верни ТОЛЬКО валидный JSON-объект по схеме, без markdown, без пояснений, без текста вокруг. Поле narration — не короче 90 слов.`;
  const second = await askJson({
    system: strict,
    user: `${user}

(Предыдущий ответ не соответствовал формату. Строго JSON.)`,
    temperature: Math.max(0.4, temperature - 0.35),
    maxTokens
  });
  plan = normalizePlan(second.data, { minNarration });
  return {
    plan,
    usage: mergeUsage(first.usage, second.usage),
    model: second.model,
    repaired: true
  };
}

function progress(state, entry) {
  state.log.push(entry);
  if (state.log.length > 200) state.log = state.log.slice(-200);
}

// ---------- сцены ----------

export async function openingFor(state, onPhase = () => {}) {
  if (!DEMO_MODE && aiAvailable()) {
    try {
      onPhase('writing', {});
      const retrieved = retrieve(state, [state.world.title, state.world.genre, state.world.start].join(' '));
      const { plan, usage } = await askScene({
        system: buildSystemPrompt(state, retrieved),
        user: buildOpeningPrompt(state),
        temperature: 1,
        maxTokens: 1500,
        minNarration: 180
      });
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

export function commitPlan(state, plan, { action, roll, demo }) {
  const deltas = plan.deltas && typeof plan.deltas === 'object' ? plan.deltas : {};
  const applied = applyDeltas(state, deltas, { action, free: action === 'Начало истории' });

  rememberTurn(state, {
    turn: state.scene.turn,
    action,
    narration: plan.narration,
    facts: plan.facts,
    npcs: plan.npcs,
    location: state.scene.location
  });

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
          sides: roll.sides,
          boosted: Boolean(roll.boosted),
          rerolledFrom: roll.rerolledFrom
            ? { formula: roll.rerolledFrom.formula, total: roll.rerolledFrom.total }
            : null
        }
      : null,
    deltas: { hp: state.hero.hp, energy: state.hero.energy, gold: state.hero.gold },
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
    const xp = awardExperience(state, roll);
    if (xp.gained) {
      turnEntry.xp = xp.gained;
      turnEntry.leveled = Boolean(xp.leveled);
    }
  }

  const issues = localAudit(state, turnEntry, plan, { skipStyle: Boolean(demo) });
  for (const issue of issues) {
    state.audit.push({
      turn: state.scene.turn,
      at: Date.now(),
      kind: 'audit',
      rule: issue.kind,
      severity: issue.severity,
      message: issue.message
    });
  }

  state.pendingOpening = false;
  state.scene.turn += 1;
  state.updatedAt = Date.now();
  return { turnEntry, died };
}

export async function runTurn(state, action, onPhase = () => {}, { audit = false, boost = false } = {}) {
  pushSnapshot(state);
  const roll = serverRoll(state, action, undefined, { boost });
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
      const { plan: generated, usage } = await askScene({
        system: buildSystemPrompt(state, retrieved),
        user: buildTurnPrompt(state, { action, roll }),
        temperature: 0.95,
        maxTokens: 1500,
        minNarration: 120
      });
      plan = generated;
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

  const { turnEntry } = commitPlan(state, plan, { action, roll, demo });

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
  return { state, turn: turnEntry, demo, aiError };
}

const MAX_SNAPSHOTS = 2;

/** Снимок состояния до хода — для отмены. Храним только то, что меняет ход. */
export function pushSnapshot(state) {
  const snap = {
    at: Date.now(),
    turn: state.scene.turn,
    hero: structuredClone(state.hero),
    scene: structuredClone(state.scene),
    flags: structuredClone(state.flags),
    stats: structuredClone(state.stats),
    memory: structuredClone(state.memory),
    logLength: (state.log || []).length,
    auditLength: (state.audit || []).length
  };
  state.snapshots = [snap, ...(state.snapshots || [])].slice(0, MAX_SNAPSHOTS);
}

/** Отмена последнего хода. После смерти отмены нет — только ветка. */
export async function rewind(state) {
  const snapshot = (state.snapshots || [])[0];
  if (!snapshot) throw new AIError('Отменять пока нечего: это был первый ход.', { status: 400 });
  if (state.status === 'dead') {
    throw new AIError('После смерти ход не отменяется. Возьми ветку — она вернёт героя с полпути.', { status: 400 });
  }

  const undoneTurn = state.scene.turn;
  state.hero = snapshot.hero;
  state.scene = snapshot.scene;
  state.flags = snapshot.flags;
  state.stats = snapshot.stats;
  state.memory = snapshot.memory;
  state.log = (state.log || []).slice(0, snapshot.logLength);
  state.audit = (state.audit || []).slice(0, snapshot.auditLength);
  state.snapshots = (state.snapshots || []).slice(1);
  state.status = 'active';
  state.updatedAt = Date.now();
  state.audit.push({
    turn: state.scene.turn,
    at: Date.now(),
    kind: 'rewind',
    severity: 'soft',
    message: `Ход ${undoneTurn} отменён: состояние вернулось к началу сцены. Отмен осталось: ${state.snapshots.length}.`
  });
  await saveGame(state);
  return { state, undoneTurn, remaining: state.snapshots.length };
}

/** Новая игра: герой, мир, открывающая сцена. */
export async function startNewGame({ worldId, customWorld, hero, difficulty }, onPhase = () => {}) {
  const state = createGame({ worldId, customWorld, hero, difficulty });
  if (customWorld?.title) state.world.custom = true;
  state.origin = customWorld?.title ? 'web-custom' : 'web';
  const { plan, demo } = await openingFor(state, onPhase);
  commitPlan(state, plan, { action: 'Начало истории', roll: null, demo });
  await saveGame(state);
  return { state, demo };
}

/** Копия игры для «ветки» — пригодится, если игрок хочет отыграть заново. */
export async function forkGame(state) {
  const copy = JSON.parse(JSON.stringify(state));
  copy.id = makeId(12);
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  copy.forkedFrom = state.id;
  const last = (copy.log || []).slice(-1)[0];
  copy.status = 'active';
  copy.hero.alive = true;
  copy.hero.hp = Math.max(1, Math.round(copy.hero.maxHp * 0.6));
  copy.scene.turn += 1;
  copy.audit.push({
    turn: copy.scene.turn,
    at: Date.now(),
    kind: 'fork',
    severity: 'soft',
    message: `Ветка от истории ${state.id}: герой возвращается с полпути.`
  });
  if (last?.options?.length) copy.pendingOptions = last.options;
  await saveGame(copy);
  return copy;
}

/** Улучшение героя после нового уровня. */
export async function levelUp(state, choiceId) {
  const result = applyLevelUp(state, choiceId);
  if (result.error) throw new AIError(result.error, { status: 400 });
  await saveGame(state);
  return { state, choice: result.choice, choices: levelChoices(state.hero) };
}

/** Уплотнение памяти второй моделью. */
export async function compactStateMemory(state) {
  if (DEMO_MODE || !aiAvailable()) {
    throw new AIError('Уплотнение памяти требует подключённой модели.', { status: 400 });
  }
  if (!usageCheck(state)) throw new AIError('Дневной лимит запросов исчерпан.', { status: 429 });

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
      existing.updatedAt = state.scene.turn;
    } else if (state.memory.quests.length < 20) {
      state.memory.quests.push({
        title,
        status,
        note: String(q?.note || '').slice(0, 200),
        openedAt: state.scene.turn,
        updatedAt: state.scene.turn
      });
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
  return { state, added };
}

/** Передышка без запроса к модели. */
export async function rest(state) {
  const result = restHero(state);
  if (result.error) return result;
  await saveGame(state);
  return { state, ...result };
}

export { aiAudit };
