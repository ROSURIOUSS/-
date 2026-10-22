// Серверные броски. Кубик кидает только сервер — модель не может его подделать.

export const STATS = ['Сила', 'Ловкость', 'Разум', 'Воля', 'Харизма'];

const STAT_WORDS = {
  'Сила': ['сил', 'удар', 'лома', 'подня', 'тащ', 'дера', 'вылом', 'толк', 'блок', 'прижим', 'метн', 'швыр', 'поднят'],
  'Ловкость': ['ловк', 'крад', 'пряч', 'прыг', 'уверн', 'убег', 'тихо', 'незамет', 'карман', 'отмыч', 'стрел', 'брос', 'пробег', 'пролез', 'взлом', 'замок', 'запер', 'баланс', 'акробат'],
  'Разум': ['разум', 'вспомн', 'поня', 'изуч', 'осмотр', 'анализ', 'чита', 'вычисл', 'наблюд', 'искать', 'провер', 'взгляд', 'слуша', 'нюха', 'след'],
  'Воля': ['воли', 'волю', 'страх', 'боль', 'терп', 'убежд', 'сопротив', 'рискн', 'решил', 'молч', 'выдерж', 'спокой', 'рассуд', 'безум'],
  'Харизма': ['харизм', 'говор', 'убед', 'прошу', 'приказ', 'торг', 'обман', 'лгал', 'хам', 'флирт', 'представ', 'спрашива', 'крич', 'зов']
};

/** Какую характеристику проверяет действие (эвристика; модель может уточнить). */
export function guessStat(action, hero) {
  const text = action.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [stat, roots] of Object.entries(STAT_WORDS)) {
    let score = 0;
    for (const root of roots) if (text.includes(root)) score += root.length / 4;
    if (score > bestScore) {
      bestScore = score;
      best = stat;
    }
  }
  if (best) return best;
  // запасной вариант — сильная сторона героя, но с элементом случайности
  const stats = STATS.filter((s) => typeof hero?.stats?.[s] === 'number');
  if (!stats.length) return 'Разум';
  stats.sort((a, b) => hero.stats[b] - hero.stats[a]);
  return Math.random() < 0.6 ? stats[0] : stats[Math.floor(Math.random() * stats.length)];
}

const RISKY = /(взлом|замок|убед|уговор|украд|стащ|атак|удар|прыг|побег|обман|совр|торг|лез|взбира|пробра|проник|спрят|подкрад|обезвред|вскры|подключ|взлом|риск|провер|напа|убить|убива|опрокин|швыр|оттолк|схват|борьб)/i;
const EXTREME = /(в одиночку|против всех|спрыгн|броситься в|на глазах у всех|без оружия|голыми руками|взорв|подожг|убить всех)/i;
const EASY = /(осмотр|огляд|прислуш|принюх|вспомн|подума|провер(ить)? свои|перевяз|пересчита|спокойно)/i;

// Действия, где провал что-то меняет: сопротивление, риск, цена ошибки.
const HARD_ACTIONS = /(?:^|[^а-яё])(взлом|отмыч|вскры|украд|стащ|выкрад|обшари|карман|атак|удар|руб|стрел|выстрел|метн|прыг|спрыг|запрыг|перепрыг|побег|убег|уверн|уклон|уворач|влез|перелез|пролез|взбира|вскараб|пробра|проник|спрят|подкрад|крад|незамет|обезвред|подключ|взорв|подожг|риск|напа|убить|убива|опрокин|швыр|оттолк|схват|борьб|вылом|толкн|блокиру|парир|перехват|уговор|уговар|убед|убежд|договор|договар|подкуп|торгу|торгуюсь|обман|солг|лгать|лгу|лже|блеф|пригроз|запуга|приказ|допрос|выпыт|склонить|переубед|соблазн|флирт)/i;
// Спокойные действия: разговор, наблюдение, бытовые движения — без броска.
const CALM_ACTIONS = /(?:^|[^а-яё])(осмотр|огляд|прислуш|принюх|вспомн|подума|рассматр|чита|спраш|спрос|говор|сказа|ответ|кивн|улыбн|благодар|представ|подойд|подход|иду|идти|пойд|направ|вход|выхож|сажусь|сесть|встаю|встать|беру|взять|кладу|убира|надева|снима|перевяз|пересчита|отдых|сплю|ем|пью|жду|ждать|молч|стою|стоять|смотр|дышу|размышл|изуча|запомина)/i;

/**
 * Нужен ли бросок под действие.
 * По умолчанию кости кидаются только там, где провал действительно что-то меняет.
 * Политика задаётся LORIA_ROLLS: risky (по умолчанию), normal, always.
 */
export function actionNeedsRoll(action, { policy = process.env.LORIA_ROLLS || 'risky' } = {}) {
  const text = String(action || '').trim();
  if (policy === 'always') return true;
  if (text.length < 3) return false;
  if (EXTREME.test(text) || HARD_ACTIONS.test(text)) return true;
  if (CALM_ACTIONS.test(text)) return false;
  if (policy === 'normal') return true;
  // Всё остальное — обычное движение по сцене: мастер опишет последствия без кубика.
  return false;
}

/** Базовая сложность проверки под действие. Сила героя на неё не влияет. */
export function actionDifficulty(action, system = 'd20') {
  const sys = systemInfo(system);
  const text = String(action || '');
  if (EXTREME.test(text)) return sys.dc.extreme;
  if (RISKY.test(text)) return sys.dc.hard;
  if (EASY.test(text)) return sys.dc.easy;
  return sys.dc.normal;
}

export function rollDie(sides) {
  return 1 + Math.floor(Math.random() * sides);
}

const SYSTEMS = {
  d20: { dice: 1, sides: 20, statMod: (v) => v, dc: { easy: 8, normal: 12, hard: 16, extreme: 19 } },
  '2d6': { dice: 2, sides: 6, statMod: (v) => v - 4, dc: { easy: 6, normal: 8, hard: 10, extreme: 12 } },
  d100: { dice: 1, sides: 100, statMod: (v) => v * 5, dc: { easy: 40, normal: 55, hard: 70, extreme: 85 } }
};

export function systemInfo(system = 'd20') {
  return SYSTEMS[system] || SYSTEMS.d20;
}

/**
 * Бросок под основное рискованное действие хода.
 * Возвращает честный результат: сумма уже посчитана на сервере.
 */
export function rollCheck({ system = 'd20', stat = 'Разум', statValue = 5, fatigue = false }) {
  const sys = systemInfo(system);
  const dice = [];
  for (let i = 0; i < sys.dice; i++) dice.push(rollDie(sys.sides));
  const raw = dice.reduce((a, b) => a + b, 0);
  const mod = sys.statMod(statValue) + (fatigue ? -3 : 0) + (sys.sides === 100 ? 0 : 0);
  const total = raw + mod;
  const natMax = sys.dice === 1 && raw === sys.sides;
  const natMin = sys.dice === 1 && raw === 1;
  return {
    system,
    stat,
    dice,
    sides: sys.sides,
    raw,
    mod,
    total,
    natMax,
    natMin,
    fatigue,
    formula: `${dice.join('+')}${mod >= 0 ? '+' : ''}${mod}`
  };
}

/** Пересчёт исхода проверки на сервере. Модель не решает, успех или нет. */
export function resolveCheck(roll, dc) {
  const difficulty = Number.isFinite(dc) ? Math.max(2, Math.min(100, Math.round(dc))) : 12;
  const success = roll.natMax ? true : roll.natMin ? false : roll.total >= difficulty;
  const margin = roll.total - difficulty;
  return {
    dc: difficulty,
    success,
    margin,
    critical: roll.natMax,
    fumble: roll.natMin,
    verdict: roll.natMax
      ? 'критический успех'
      : roll.natMin
        ? 'критический провал'
        : success
          ? margin >= 8
            ? 'уверенный успех'
            : 'успех'
          : margin <= -8
            ? 'сокрушительный провал'
            : 'провал'
  };
}
