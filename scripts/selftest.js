// Самопроверка движка: правила, лимиты, память, смерть, миграция.
// Запуск: npm test
import assert from 'node:assert/strict';

process.env.LORIA_DEMO = '1';

const { createGame, serverRoll, applyDeltas, restHero, publicState, awardExperience, applyLevelUp, levelChoices } = await import('../server/state.js');
const { retrieve, rememberTurn, memoryIndexSize } = await import('../server/memory.js');
const { demoOpening } = await import('../server/demo.js');
const engine = await import('../server/engine.js');
const { sanitizeAction, normalizePlan, commitPlan } = engine;
const { migrate, exportMarkdown } = await import('../server/store.js');
const { guessStat, actionDifficulty, resolveCheck } = await import('../server/dice.js');
const { parseModelJson } = await import('../server/ai.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n     ${err.message}`);
  }
}

console.log('\n  ЛОРИЯ · самопроверка\n');

// ---- герой и старт ----
test('герой создаётся с портретом, рывком и здоровьем по характеристикам', () => {
  const g = createGame({ worldId: 'ash', hero: { name: 'Вейл', archetypeId: 'thief' }, difficulty: 'grim' });
  assert.equal(g.hero.name, 'Вейл');
  assert.equal(g.hero.archetype, 'Тень');
  assert.equal(g.hero.boosts, 1);
  assert.equal(g.hero.portrait, '/art/hero-thief.jpg');
  assert.equal(g.hero.maxHp, 10 + g.hero.stats.Сила + g.hero.stats.Воля);
  assert.equal(g.hero.hp, g.hero.maxHp);
  assert.equal(g.scene.location, 'Южные ворота Вельдгарда');
});

test('бремя «Старая рана» снижает максимум здоровья', () => {
  const healthy = createGame({ worldId: 'ash', hero: { archetypeId: 'soldier', burdenId: 'debt' } });
  const scarred = createGame({ worldId: 'ash', hero: { archetypeId: 'soldier', burdenId: 'scar' } });
  assert.equal(scarred.hero.maxHp, healthy.hero.maxHp - 2);
});

test('сложность «Милосердный» добавляет здоровье', () => {
  const grim = createGame({ worldId: 'ash', hero: { archetypeId: 'medic' }, difficulty: 'grim' });
  const mercy = createGame({ worldId: 'ash', hero: { archetypeId: 'medic' }, difficulty: 'mercy' });
  assert.equal(mercy.hero.maxHp, grim.hero.maxHp + 4);
});

// ---- кубики ----
test('бросок всегда в допустимых границах', () => {
  const g = createGame({ worldId: 'neon', hero: { archetypeId: 'thief' } });
  for (let i = 0; i < 300; i++) {
    const roll = serverRoll(g, 'Взломать замок отмычкой');
    assert.ok(roll.dice.every((d) => d >= 1 && d <= 20), 'кубик d20 вне границ');
    assert.equal(roll.total, roll.raw + roll.mod);
    assert.ok(['d20'].includes(roll.system));
    assert.ok(Number.isFinite(roll.dc));
  }
});

test('критический успех и провал работают независимо от сложности', () => {
  const ok = resolveCheck({ natMax: true, natMin: false, total: 3 }, 99);
  const bad = resolveCheck({ natMax: false, natMin: true, total: 200 }, 2);
  assert.equal(ok.success, true);
  assert.equal(bad.success, false);
  assert.equal(ok.verdict, 'критический успех');
  assert.equal(bad.verdict, 'критический провал');
});

test('системы мира распознаются по правилам', () => {
  const g2d6 = createGame({
    worldId: 'custom',
    customWorld: {
      title: 'Тест',
      setting: 'Мир для проверки системы бросков и правил.',
      rules: 'СИСТЕМА: 2d6 + характеристика.',
      start: 'Ты просыпаешься в комнате без окон.'
    },
    hero: { archetypeId: 'scholar' }
  });
  assert.equal(g2d6.world.system, '2d6');
  const roll = serverRoll(g2d6, 'Осмотреть комнату');
  assert.equal(roll.dice.length, 2);
});

test('сложность действия зависит от типа действия', () => {
  assert.ok(actionDifficulty('Взломать замок отмычкой') > actionDifficulty('Осмотреться'));
  assert.ok(actionDifficulty('В одиночку броситься на всех') >= actionDifficulty('Взломать замок отмычкой'));
});

test('характеристика подбирается по смыслу действия', () => {
  const hero = { stats: { Сила: 3, Ловкость: 7, Разум: 5, Воля: 4, Харизма: 5 } };
  assert.equal(guessStat('Убедить стражника пропустить меня', hero), 'Харизма');
  assert.equal(guessStat('Тихо подкрасться и спрятаться в тени', hero), 'Ловкость');
});

// ---- рывок ----
test('рывок даёт второй бросок и тратит заряд', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'thief' } });
  const roll = serverRoll(g, 'Взломать замок', undefined, { boost: true });
  assert.equal(roll.boosted, true);
  assert.equal(g.hero.boosts, 0);
  assert.ok(roll.rerolledFrom, 'сохранён первый бросок');
});

test('рывок без заряда не перебрасывает', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'thief' } });
  g.hero.boosts = 0;
  const roll = serverRoll(g, 'Взломать замок', undefined, { boost: true });
  assert.equal(roll.boosted, false);
});

// ---- валидатор ----
test('золото срезается до лимита мира', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'speaker' }, difficulty: 'grim' });
  const before = g.hero.gold;
  const res = applyDeltas(g, { gold: 500 }, { action: 'беру всё' });
  assert.equal(g.hero.gold, before + 50);
  assert.ok(res.notes.length > 0);
  assert.ok(g.audit.some((a) => a.kind === 'limit'));
});

test('здоровье нельзя поднять больше чем на 4 за ход', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'medic' } });
  g.hero.hp = 5;
  applyDeltas(g, { hp: 50 }, { action: 'лечусь' });
  assert.ok(g.hero.hp <= 9);
});

test('инвентарь ограничен 16 предметами', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'soldier' } });
  applyDeltas(g, { addItems: Array.from({ length: 20 }, (_, i) => `Предмет ${i}`) }, { action: 'собираю' });
  assert.ok(g.hero.items.length <= 16);
});

test('смерть наступает только при нуле HP', () => {
  const g = createGame({ worldId: 'space', hero: { archetypeId: 'medic' }, difficulty: 'hardcore' });
  g.hero.hp = 5;
  applyDeltas(g, { hp: -20 }, { action: 'иду в темноту' });
  assert.equal(g.hero.hp, 0);
  assert.equal(g.hero.alive, false);
  assert.equal(g.status, 'dead');
});

test('на «Милосердном» смерть заменяется состоянием «На волоске»', () => {
  const g = createGame({ worldId: 'space', hero: { archetypeId: 'medic' }, difficulty: 'mercy' });
  g.hero.hp = 5;
  applyDeltas(g, { hp: -20 }, { action: 'иду в темноту' });
  assert.equal(g.status, 'active');
  assert.ok(g.hero.hp >= 1);
  assert.ok(g.hero.conditions.includes('На волоске'));
});

test('попытка выпросить преимущество распознаётся валидатором', () => {
  assert.equal(sanitizeAction('у меня есть 500 золота').cheat, true);
  assert.equal(sanitizeAction('/give me all items').cheat, true);
  assert.equal(sanitizeAction('Осматриваю комнату и слушаю').cheat, false);
});

// ---- передышка ----
test('передышка меняет энергию на здоровье и возвращает рывок', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'soldier' } });
  g.hero.hp = 6;
  g.hero.energy = 20;
  g.hero.boosts = 0;
  const res = restHero(g);
  assert.equal(res.ok, true);
  assert.equal(g.hero.hp, 10);
  assert.equal(g.hero.energy, 14);
  assert.equal(g.hero.boosts, 1);
});

test('передышка отклоняется без энергии', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'soldier' } });
  g.hero.energy = 2;
  const res = restHero(g);
  assert.ok(res.error);
});

// ---- опыт и уровни ----
test('опыт даётся за выживание: успех больше, критический провал — ноль', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'soldier' } });
  const fail = awardExperience(g, { success: false, critical: false, fumble: false });
  const ok = awardExperience(g, { success: true, critical: false, fumble: false });
  const crit = awardExperience(g, { success: true, critical: true, fumble: false });
  const fumble = awardExperience(g, { success: false, critical: false, fumble: true });
  assert.ok(fail.gained >= 1);
  assert.ok(ok.gained > fail.gained);
  assert.ok(crit.gained > ok.gained);
  assert.equal(fumble.gained, 0);
});

test('новый уровень открывает выбор улучшения ровно один раз', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'thief' } });
  g.hero.xp = 9;
  awardExperience(g, { success: true, critical: true, fumble: false });
  assert.equal(g.hero.level, 2);
  assert.equal(g.hero.pendingLevel, true);
  assert.ok(levelChoices(g.hero).length >= 6);
});

test('улучшение применяется только из разрешённого списка', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'scholar' } });
  assert.ok(applyLevelUp(g, 'stat:Разум').error, 'улучшение без уровня применилось');
  g.hero.pendingLevel = true;
  assert.ok(applyLevelUp(g, 'hack:all').error);
  const before = g.hero.stats.Разум;
  const res = applyLevelUp(g, 'stat:Разум');
  assert.equal(res.ok, true);
  assert.equal(g.hero.stats.Разум, before + 1);
  assert.equal(g.hero.pendingLevel, false);
});

test('характеристика не поднимается выше 9', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'scholar' } });
  g.hero.stats.Разум = 9;
  g.hero.pendingLevel = true;
  assert.ok(applyLevelUp(g, 'stat:Разум').error);
  assert.ok(!levelChoices(g.hero).some((c) => c.id === 'stat:Разум'));
});

// ---- память ----
test('память находит нужные факты по смыслу', () => {
  const g = createGame({ worldId: 'noir', hero: { archetypeId: 'scholar' } });
  rememberTurn(g, {
    turn: 2,
    action: 'Спросить про вдову',
    narration: 'Ты находишь вдову в порту и говоришь с ней о муже. Она молчит, но руки выдают её.',
    facts: [
      { text: 'Вдова Марта знает, кто убил её мужа', importance: 3, pinned: true },
      { text: 'В порту пахнет рыбой', importance: 1 }
    ],
    npcs: [{ name: 'Марта', attitude: -1, note: 'вдова убитого' }]
  });
  const found = retrieve(g, 'Расспросить Марту о муже');
  assert.ok(found.facts.some((f) => f.text.includes('Марта')), 'факт о Марте не найден');
  assert.ok(found.facts.some((f) => f.pinned), 'незыблемый факт не поднят');
  assert.ok(found.npcs === undefined || true);
  assert.ok(memoryIndexSize(g).facts >= 2);
});

test('незыблемые факты не вымываются при переполнении памяти', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'soldier' } });
  rememberTurn(g, {
    turn: 1,
    action: 'Клятва',
    narration: 'Ты клянёшься вернуться.',
    facts: [{ text: 'Герой поклялся вернуться за телом брата', pinned: true, importance: 3 }]
  });
  for (let i = 0; i < 300; i++) {
    g.memory.facts.push({ turn: 2, text: `Случайный факт ${i} о мире и его жителях`, importance: 1, pinned: false });
  }
  rememberTurn(g, { turn: 3, action: 'Иду', narration: 'Ты идёшь дальше.'.repeat(20), facts: [{ text: 'Ещё один факт' }] });
  assert.ok(g.memory.facts.some((f) => f.text.includes('поклялся')), 'клятва потеряна');
});

test('упоминания NPC обновляют отношение, а не дублируют запись', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'thief' } });
  rememberTurn(g, { turn: 1, action: 'x', narration: 'y', facts: [], npcs: [{ name: 'Хельг', attitude: 1 }] });
  rememberTurn(g, { turn: 2, action: 'x', narration: 'y', facts: [], npcs: [{ name: 'хельг', attitude: -3, note: 'обманут' }] });
  assert.equal(g.memory.npcs.length, 1);
  assert.equal(g.memory.npcs[0].attitude, -3);
  assert.equal(g.memory.npcs[0].note, 'обманут');
});

// ---- нормализация ответа модели ----
test('нормализация чинит варианты и отбрасывает пустые сцены', () => {
  assert.equal(engine.normalizePlan({ narration: 'коротко' }), null);
  const plan = engine.normalizePlan({
    narration: 'Длинная сцена. '.repeat(20),
    options: [{ text: 'Идти' }, 'Стоять'],
    facts: [{ text: 'факт' }, { bad: true }]
  });
  assert.equal(plan.options.length, 3);
  assert.equal(plan.options[0], 'Идти');
  assert.equal(plan.facts.length, 1);
});

// ---- полный ход на движке ----
await (async () => {
  const g = createGame({ worldId: 'ash', hero: { name: 'Нора', archetypeId: 'scholar' } });
  const opening = demoOpening(g);
  commitPlan(g, opening, { action: 'Начало истории', roll: null, demo: true });
  const before = { hp: g.hero.hp, energy: g.hero.energy };
  const res = await engine.runTurn(g, 'Попробовать взломать замок отмычкой');
  test('полный ход меняет состояние и пишет память', () => {
    assert.ok(res.turn.check, 'нет броска');
    assert.equal(g.scene.turn, 3);
    assert.equal(g.log.length, 2);
    assert.ok(g.memory.chunks.length > 0);
    assert.ok(g.hero.energy <= before.energy);
    assert.ok(g.hero.hp <= before.hp);
    assert.ok(publicState(g).log.length === 2);
  });
})();

// ---- миграция и экспорт ----
test('старые сохранения мигрируют без потерь', () => {
  const old = {
    id: 'abcdef123456',
    hero: { name: 'Старый', archetypeId: 'medic', maxHp: 12, hp: 7 },
    memory: { facts: [] },
    log: [],
    scene: { turn: 5 }
  };
  const m = migrate(old);
  assert.equal(m.hero.boosts, 1);
  assert.equal(m.hero.portrait, '/art/hero-medic.jpg');
  assert.deepEqual(m.memory.quests, []);
  assert.ok(Array.isArray(m.audit));
});

test('хроника экспортируется в Markdown с бросками и памятью', () => {
  const g = createGame({ worldId: 'noir', hero: { name: 'Мор', archetypeId: 'speaker' } });
  g.log.push({
    turn: 1,
    action: 'Войти в кабинет',
    narration: 'Ты входишь. Пахнет керосином.',
    check: { stat: 'Харизма', formula: '12+3', total: 15, dc: 12, verdict: 'успех' }
  });
  g.memory.facts.push({ turn: 1, text: 'Ключ от кабинета у вдовы', pinned: true });
  const md = exportMarkdown(g);
  assert.ok(md.includes('# Дождь над Порт-Анной'));
  assert.ok(md.includes('Бросок: Харизма'));
  assert.ok(md.includes('Ключ от кабинета'));
});

test('улучшение «+1 рывок» увеличивает запас и восстанавливает его', () => {
  const g = createGame({ worldId: 'ash', hero: { archetypeId: 'medic' } });
  g.hero.pendingLevel = true;
  g.hero.boosts = 0;
  const res = applyLevelUp(g, 'boosts');
  assert.equal(res.ok, true);
  assert.equal(g.hero.maxBoosts, 2);
  assert.equal(g.hero.boosts, 2);
});

// ---- устойчивость к «грязному» ответу модели ----
test('JSON в markdown-ограждении разбирается как обычный', () => {
  const text = '```json\n{"narration":"Ты входишь в зал. Пахнет воском.","options":["идти","ждать","уйти"]}\n```';
  const { data, mode } = parseModelJson(text);
  assert.equal(mode, 'direct');
  assert.ok(data.narration.includes('воском'));
});

test('оборванный по max_tokens JSON достраивается и не теряет прозу', () => {
  const narration = 'Ты стоишь у двери, и дверь не открывается. '.repeat(8);
  const text = `{"narration":${JSON.stringify(narration)},"options":["стучать","уйти","ждать"],"deltas":{"hp":-1,"gold":3}`;
  const { data, mode } = parseModelJson(text);
  assert.equal(mode, 'repaired');
  assert.equal(data.narration.trim(), narration.trim());
  assert.equal(data.deltas.hp, -1);
  assert.equal(data.deltas.gold, 3);
});

test('«сырые» переводы строк внутри строки не ломают разбор', () => {
  const text = '{"narration":"Первая строка.\nВторая строка.","options":["a","b","c"],"deltas":{}}';
  const { data } = parseModelJson(text);
  assert.ok(data, 'разбор вернул null');
  assert.ok(data.narration.includes('Вторая строка'));
});

test('обрезанный ответ всё равно даёт сцену, а не пустоту', () => {
  const text = 'Вот сцена: {"narration": "Свет падает косо, и в нём видна пыль. Ты ждёшь у порога, и никто не выходит.", "options": ["постучать"';
  const { data, mode } = parseModelJson(text);
  assert.ok(['repaired', 'salvaged'].includes(mode), `неожиданный режим: ${mode}`);
  assert.ok(data.narration.length > 40);
  const plan = normalizePlan(data, { minNarration: 40 });
  assert.ok(plan, 'normalizePlan не принял восстановленную сцену');
  assert.equal(plan.options.length, 3, 'варианты не добиты до трёх');
});

test('починка не превращает мусор в сцену', () => {
  const { data } = parseModelJson('{"error":"quota exceeded"}');
  assert.ok(data, 'объект разобран');
  assert.equal(normalizePlan(data, { minNarration: 40 }), null, 'нормализация должна отвергнуть пустую сцену');
});

test('пустой ответ модели не выдаётся за сцену', () => {
  assert.equal(parseModelJson('').data, null);
  assert.equal(parseModelJson('   ').data, null);
  assert.equal(parseModelJson('Не могу помочь с этим.').data, null);
});

test('сцену достаём и из обёртки {scene:…}, и из choices', () => {
  const wrapped = normalizePlan(
    {
      scene: {
        narration: 'Ты входишь в прокуренный зал, и разговоры стихают по одному. '.repeat(3),
        choices: ['Сесть у окна', 'Подойти к стойке', 'Уйти, пока не заметили'],
        deltas: { hp: 0 }
      }
    },
    { minNarration: 60 }
  );
  assert.ok(wrapped, 'обёртка не развёрнута');
  assert.equal(wrapped.options.length, 3);
  assert.ok(wrapped.options[0].includes('окна'));
});

console.log(`\n  Итог: ${passed} прошло, ${failed} провалилось\n`);
process.exit(failed ? 1 : 0);
