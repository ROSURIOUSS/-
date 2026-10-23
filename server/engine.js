// Игровой движок: один на веб и на Telegram. Транспорт сюда не заглядывает.

import { aiAvailable, askJson, AIError } from './ai.js';
import { buildSystemPrompt, buildTurnPrompt, buildOpeningPrompt, buildCompactionPrompt, buildFinalePrompt } from './prompts.js';
import { retrieve, rememberTurn } from './memory.js';
import {
  createGame,
  serverRoll,
  applyDeltas,
  gameOver,
  makeId,
  restHero,
  awardExperience,
  applyLevelUp,
  levelChoices,
  advanceArc,
  finishGame
} from './state.js';
import { actionNeedsRoll } from './dice.js';
import { saveGame } from './store.js';
import { localAudit, aiAudit } from './auditor.js';
import { demoOpening, demoTurn, demoFinale } from './demo.js';
import { DAILY_LIMIT, ENABLE_AI_AUDIT, demoMode } from './config.js';

// Сколько ходов линия может стоять на месте, прежде чем движок сдвинет её сам.
const ARC_STALL_TURNS = 8;

/**
 * Режим без модели. Пересчитывается на каждом шаге: ключ можно ввести
 * прямо в приложении, и игра сразу начнёт писать сцены мастером.
 */
export function isDemo() {
  return demoMode(aiAvailable());
}

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
  // Некоторые модели заворачивают сцену в {scene:…} / {result:…} — разворачиваем.
  const inner = [data.scene, data.result, data.response, data.data].find(
    (v) => v && typeof v === 'object' && typeof v.narration === 'string'
  );
  if (inner) data = inner;
  const narration = String(data.narration || '').trim();
  if (narration.length < minNarration) return null;
  const rawOptions = Array.isArray(data.options) ? data.options : Array.isArray(data.choices) ? data.choices : [];
  const options = rawOptions
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
  // Некоторые модели кладут просьбу о шаге рядом с deltas, а не внутрь.
  if (deltas.arc === undefined && data.arc !== undefined) deltas.arc = data.arc;
  return {
    narration: narration.slice(0, 6000),
    options,
    deltas,
    facts,
    npcs,
    dead: Boolean(data.dead),
    deathReason: String(data.deathReason || '').slice(0, 400),
    epitaph: String(data.epitaph || '').slice(0, 120)
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

/**
 * Похожа ли новая сцена на предыдущую. Модели любят начинать ход тем же
 * предложением, что и прошлый: это ломает ощущение живой истории.
 */
export function looksRepeated(prev, next) {
  const clean = (t) =>
    String(t || '')
      .toLowerCase()
      .replace(/[^а-яёa-z0-9 ]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = clean(prev);
  const b = clean(next);
  if (a.length < 40 || b.length < 40) return false;
  if (a.slice(0, 90) === b.slice(0, 90)) return true;
  const grams = (t, n = 4) => {
    const set = new Set();
    for (let i = 0; i + n <= Math.min(t.length, 400); i++) set.add(t.slice(i, i + n));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return false;
  let hit = 0;
  for (const g of gb) if (ga.has(g)) hit += 1;
  return hit / gb.size > 0.55;
}

/** Запрос сцены с одной попыткой починки, если модель вернула не JSON. */
async function askScene({ system, user, temperature = 0.85, maxTokens = 1800, minNarration, avoid = '' }) {
  const first = await askJson({ system, user, temperature, maxTokens });
  let plan = normalizePlan(first.data, { minNarration });
  if (plan && avoid && looksRepeated(avoid, plan.narration)) {
    // Сцена — почти копия прошлой: один повтор с прямым запретом, иначе оставляем как есть.
    try {
      const retry = await askJson({
        system: `${system}\n\nПОВТОР: предыдущий ответ начался так же, как прошлая сцена. Это запрещено. Начни с нового образа и новой детали, не пересказывай предыдущую сцену.`,
        user: `${user}\n\n(Прошлая сцена начиналась так: «${String(avoid).replace(/\s+/g, ' ').slice(0, 160)}…». Не повторяй её зачин и не пересказывай её события.)`,
        temperature: Math.min(1, temperature + 0.1),
        maxTokens
      });
      const fixed = normalizePlan(retry.data, { minNarration });
      if (fixed && !looksRepeated(avoid, fixed.narration)) {
        return {
          plan: fixed,
          usage: mergeUsage(first.usage, retry.usage),
          model: retry.model,
          latencyMs: (first.latencyMs || 0) + (retry.latencyMs || 0),
          degraded: Boolean(first.degraded || retry.degraded),
          repaired: retry.parseMode !== 'direct',
          repeated: true,
          finishReason: retry.finishReason
        };
      }
    } catch (err) {
      console.error('[scene] повтор не удался:', err?.message);
    }
  }
  if (plan) {
    return {
      plan,
      usage: first.usage,
      model: first.model,
      latencyMs: first.latencyMs,
      degraded: Boolean(first.degraded),
      repaired: first.parseMode !== 'direct',
      finishReason: first.finishReason
    };
  }

  const strict = `${system}

ВАЖНО: предыдущий ответ не удалось разобрать. Верни ТОЛЬКО валидный JSON-объект по схеме, без markdown, без пояснений, без текста вокруг. Поле narration — не короче 90 слов.`;
  const second = await askJson({
    system: strict,
    user: `${user}

(Предыдущий ответ не соответствовал формату: ${first.finishReason === 'length' ? 'оборвался по лимиту токенов' : 'не разобрался как JSON'}. Верни короткую завершённую сцену строго по схеме.)`,
    temperature: Math.max(0.4, temperature - 0.3),
    maxTokens: Math.min(4096, Math.round(maxTokens * 1.3))
  });
  plan = normalizePlan(second.data, { minNarration });
  return {
    plan,
    usage: mergeUsage(first.usage, second.usage),
    model: second.model,
    latencyMs: (first.latencyMs || 0) + (second.latencyMs || 0),
    degraded: Boolean(second.degraded || first.degraded),
    repaired: true,
    finishReason: second.finishReason
  };
}

function progress(state, entry) {
  state.log.push(entry);
  if (state.log.length > 200) state.log = state.log.slice(-200);
}

// ---------- сцены ----------

export async function openingFor(state, onPhase = () => {}) {
  let aiError = null;
  if (!isDemo() && aiAvailable()) {
    try {
      onPhase('writing', {});
      const retrieved = retrieve(state, [state.world.title, state.world.genre, state.world.start].join(' '));
      const scene = await askScene({
        system: buildSystemPrompt(state, retrieved),
        user: buildOpeningPrompt(state),
        temperature: 0.9,
        maxTokens: 2000,
        minNarration: 180
      });
      if (scene.plan) {
        bumpUsage(state, scene.usage);
        return { plan: scene.plan, demo: false, aiError: null, ai: sceneMeta(scene) };
      }
    } catch (err) {
      aiError = err?.message || 'Ошибка модели';
      console.error('[opening] ИИ недоступен:', aiError);
    }
  }
  return { plan: demoOpening(state), demo: true, aiError, ai: null };
}

/** Компактная телеметрия хода: видно, кто написал сцену и сколько это заняло. */
function sceneMeta(scene) {
  if (!scene) return null;
  return {
    model: scene.model || null,
    ms: scene.latencyMs || null,
    repaired: Boolean(scene.repaired),
    repeated: Boolean(scene.repeated),
    degraded: Boolean(scene.degraded)
  };
}

export function commitPlan(state, plan, { action, roll, demo }) {
  const deltas = plan.deltas && typeof plan.deltas === 'object' ? plan.deltas : {};
  const questsBefore = new Map((state.memory.quests || []).map((q) => [q.title.toLowerCase(), q.status]));
  const applied = applyDeltas(state, deltas, { action, free: action === 'Начало истории' });
  const questsClosed = (state.memory.quests || []).filter(
    (q) => q.status === 'done' && questsBefore.get(q.title.toLowerCase()) !== 'done'
  );

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

  // ----- сюжетная линия -----
  // Модель может попросить шаг (deltas.arc), закрытое задание двигает линию само,
  // а если линия стоит слишком долго — движок сдвигает её по темпу.
  let arcInfo = null;
  const arc = state.arc;
  if (arc && !died) {
    const modelSignal = deltas.arc === true || Number(deltas.arc) >= 1;
    const questSignal = questsClosed.length > 0;
    const fumbled = Boolean(roll?.fumble);
    // Два шага подряд — это уже не история, а пересказ оглавления.
    const tooSoon = (arc.step || 0) > 0 && state.scene.turn - (arc.advancedAt || 0) < 2;
    const stalled = state.scene.turn - (arc.advancedAt || 1) >= ARC_STALL_TURNS;
    const wanted = !fumbled && (modelSignal || questSignal) && !tooSoon;
    const paced = !wanted && !fumbled && stalled && !arc.complete && (!roll || roll.success);
    if (wanted || paced) {
      const moved = advanceArc(state, { reason: modelSignal ? 'master' : questSignal ? 'quest' : 'pace' });
      if (moved.advanced) {
        arcInfo = { ...moved, title: arc.title, paced: Boolean(paced) };
        state.audit.push({
          turn: state.scene.turn,
          at: Date.now(),
          kind: moved.complete ? 'arc-final' : 'arc',
          severity: 'soft',
          message: moved.complete
            ? `Линия «${arc.title}» пройдена: ${moved.total} из ${moved.total}. Теперь историю можно завершить финалом.`
            : `Линия «${arc.title}»: шаг ${moved.step}/${moved.total} — «${moved.stepName}».`
        });
      }
    }
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
    arc: arcInfo,
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
  // Опыт — за любой прожитый ход: с броском больше, без броска немного.
  const xp = awardExperience(state, roll);
  if (xp.gained) {
    turnEntry.xp = xp.gained;
    turnEntry.leveled = Boolean(xp.leveled);
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
  // Кости — только там, где провал действительно что-то меняет.
  const needsRoll = actionNeedsRoll(action);
  const roll = needsRoll ? serverRoll(state, action, undefined, { boost }) : null;
  if (roll) onPhase('check', { roll });

  let plan = null;
  let demo = false;
  let aiError = null;
  let aiInfo = null;

  if (!isDemo() && aiAvailable() && !usageCheck(state)) {
    aiError = `Дневной лимит запросов к модели исчерпан (${DAILY_LIMIT}). Сцену пишет резервный рассказчик.`;
    state.audit.push({
      turn: state.scene.turn,
      at: Date.now(),
      kind: 'limit',
      severity: 'soft',
      message: aiError
    });
  }

  if (!isDemo() && aiAvailable() && usageCheck(state)) {
    try {
      onPhase('writing', {});
      const retrieved = retrieve(state, action);
      const prevNarration = (state.log || []).slice(-1)[0]?.narration || '';
      const scene = await askScene({
        system: buildSystemPrompt(state, retrieved),
        user: buildTurnPrompt(state, { action, roll }),
        temperature: 0.8,
        maxTokens: 1900,
        minNarration: 120,
        avoid: prevNarration
      });
      plan = scene.plan;
      if (!plan) throw new AIError('Модель вернула пустую сцену', { status: 502 });
      aiInfo = sceneMeta(scene);
      bumpUsage(state, scene.usage);
    } catch (err) {
      aiError = err?.message || 'Ошибка модели';
      console.error('[turn] ИИ недоступен, включаю резерв:', aiError);
      state.audit.push({
        turn: state.scene.turn,
        at: Date.now(),
        kind: 'ai-error',
        severity: 'soft',
        message: String(aiError).slice(0, 300)
      });
      plan = null;
    }
  }

  if (!plan) {
    demo = true;
    plan = demoTurn(state, { action, roll });
  }

  const { turnEntry } = commitPlan(state, plan, { action, roll, demo });

  if (audit && !demo && !isDemo() && ENABLE_AI_AUDIT) {
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
  return { state, turn: turnEntry, demo, aiError, ai: aiInfo };
}

/**
 * Финал: арка пройдена, игрок решает закончить историю. Мастер пишет эпилог,
 * но исход фиксирует сервер — статус, эпиграф и отметка в статистике.
 */
export async function runFinale(state, onPhase = () => {}) {
  if (state.status === 'dead') throw new AIError('История уже закончена смертью героя.', { status: 409 });
  if (state.status === 'finished') {
    return { state, finale: state.finale, demo: Boolean(state.finale?.demo), aiError: null, ai: null, already: true };
  }
  const arc = state.arc;
  if (!arc || !arc.complete) {
    throw new AIError('Линия ещё не пройдена: финал открывается на последнем шаге.', { status: 400 });
  }

  onPhase('finale', {});
  let text = '';
  let epitaphAI = '';
  let demo = false;
  let aiError = null;
  let aiInfo = null;

  if (!isDemo() && aiAvailable() && usageCheck(state)) {
    try {
      const scene = await askScene({
        system: buildFinalePrompt(state),
        user: 'Напиши финальную сцену этой истории. Верни только JSON.',
        temperature: 0.9,
        maxTokens: 2000,
        minNarration: 150
      });
      if (!scene.plan) throw new AIError('Модель не вернула финал', { status: 502 });
      text = scene.plan.narration;
      epitaphAI = String(scene.plan.epitaph || '').slice(0, 120);
      aiInfo = sceneMeta(scene);
      bumpUsage(state, scene.usage);
    } catch (err) {
      aiError = err?.message || 'Ошибка модели';
      state.audit.push({
        turn: state.scene.turn,
        at: Date.now(),
        kind: 'ai-error',
        severity: 'soft',
        message: `Финал: ${String(aiError).slice(0, 280)}`
      });
    }
  }
  if (!text) {
    demo = true;
    text = demoFinale(state);
  }

  const epitaph =
    epitaphAI ||
    `${state.hero.name}, ${state.hero.archetype} · ${state.world.title} · ходов ${state.scene.turn - 1} · уровень ${state.hero.level}`;
  finishGame(state, { text, epitaph, demo, model: aiInfo?.model || null });
  // Финал — тоже сцена: он попадает в ленту и в хронику, а не живёт только в модальном окне.
  state.log.push({
    turn: state.scene.turn,
    at: Date.now(),
    action: 'Финал',
    narration: text,
    options: [],
    check: null,
    deltas: { hp: state.hero.hp, energy: state.hero.energy, gold: state.hero.gold },
    changes: [],
    limits: [],
    arc: null,
    epitaph,
    finale: true,
    demo
  });
  state.pendingOpening = false;
  state.audit.push({
    turn: state.scene.turn,
    at: Date.now(),
    kind: 'finale',
    severity: 'soft',
    message: `История завершена финалом: линия «${state.arc.title}» пройдена.`
  });
  await saveGame(state);
  return { state, finale: state.finale, demo, aiError, ai: aiInfo };
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
    arc: structuredClone(state.arc || null),
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
  if (snapshot.arc) state.arc = snapshot.arc;
  state.log = (state.log || []).slice(0, snapshot.logLength);
  state.audit = (state.audit || []).slice(0, snapshot.auditLength);
  state.snapshots = (state.snapshots || []).slice(1);
  state.status = 'active';
  // Откат из финала возвращает историю в игру: эпилог больше не финал.
  if (state.finale) delete state.finale;
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
  const { plan, demo, aiError, ai } = await openingFor(state, onPhase);
  commitPlan(state, plan, { action: 'Начало истории', roll: null, demo });
  await saveGame(state);
  return { state, demo, aiError, ai: ai || null };
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
  delete copy.finale;
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
  if (isDemo() || !aiAvailable()) {
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
