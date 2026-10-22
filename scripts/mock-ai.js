// Локальная заглушка OpenRouter для проверки всего ИИ-пути без сети.
// Отвечает тем же форматом, что и настоящий API, и учитывает промпт:
// открытие, ход, аудит, уплотнение памяти.
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 4010);

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const SENSE = [
  'Пахнет мокрым камнем и старой золой; где-то капает вода, и звук идёт слишком ритмично.',
  'Свет фонаря дрожит на стене, и тени успевают шевельнуться раньше тебя.',
  'Ветер приносит обрывок чужого разговора — всего два слова, и оба тебе не нравятся.',
  'Под ногами хрустит стекло, и этот хруст слышно дальше, чем хотелось бы.'
];
const WIN = [
  'Получается — грубо, но получается. На пальцах остаётся чужая грязь, и её придётся отмывать.',
  'Ты добиваешься своего. Кто-то в тени закрывает за собой дверь чуть быстрее, чем нужно.',
  'Дело сдвигается. Ты узнаёшь одну вещь, и она делает остальные вопросы хуже.'
];
const FAIL = [
  'Не выходит. Мир отвечает холодно и без объяснений: дверь просто не поддаётся.',
  'Ты теряешь секунды, и секунды оборачиваются чьим-то вниманием — за тобой теперь смотрят.',
  'Ошибка стоит дороже, чем ты рассчитывал. Приходится отступить, пока не стало хуже.'
];

function turnScene(user) {
  const action = (user.match(/«([^»]+)»/) || [, 'осмотреться'])[1].slice(0, 160);
  const outcome = (user.match(/Исход:\s*([^\n.]+)/) || [, ''])[1].toLowerCase();
  const failed = /провал/.test(outcome);
  const crit = /критический успех/.test(outcome);
  const fumble = /критический провал/.test(outcome);

  const narration =
    `${pick(SENSE)}\n\n` +
    `Ты делаешь задуманное: «${action}». ${
      failed
        ? fumble
          ? 'Всё рушится сразу и целиком: мир не смягчает удар и не даёт второй попытки.'
          : 'Мир сопротивляется — мягко, но окончательно.'
        : crit
          ? 'Всё складывается так точно, что становится неприятно: у удачи тоже есть цена.'
          : 'Выходит, и даже с запасом — но запас этот кто-то заметил.'
    }\n\n` +
    `${failed ? pick(FAIL) : pick(WIN)}\n\n` +
    'Ты ещё здесь. Пока это всё, что можно сказать точно.';

  const deltas = failed
    ? { hp: fumble ? -3 : -1, energy: -2, tension: 3, location: 'Тёмный коридор', time: 'вечер' }
    : { hp: 0, energy: -2, tension: 2, gold: 4, location: 'Тёмный коридор', time: 'вечер', addItems: ['Медный ключ'] };

  return {
    narration,
    options: ['Осмотреть находку внимательнее', 'Спросить о ключе у первого встречного', 'Уйти, пока не стемнело'],
    deltas,
    facts: [
      { text: `На ходу ${Date.now() % 97}: ${action.slice(0, 60)} — ${failed ? 'неудача' : 'удача'}, найден медный ключ.`, importance: 2, pinned: false },
      { text: 'В этом месте кто-то ходит по ночам и не хочет, чтобы об этом знали.', importance: 2, pinned: false }
    ],
    npcs: [{ name: 'Сторож', attitude: failed ? -1 : 0, note: 'видел, как ты действовал', status: 'рядом' }],
    dead: false,
    deathReason: ''
  };
}

function openingScene(user) {
  return {
    narration:
      'Свет падает косо, и в нём видна пыль, которая не должна двигаться так медленно.\n\n' +
      'Ты стоишь там, где заканчивается чужая территория и начинается твоя. За спиной остаётся дорога, ' +
      'впереди — место, где вчера что-то случилось и никто не хочет об этом говорить.\n\n' +
      'Рядом кто-то ждёт. Он не подходит первым: здесь это считается вежливостью.',
    options: ['Осмотреться и запомнить выходы', 'Заговорить с тем, кто ждёт', 'Пройти мимо, не показывая интереса'],
    deltas: { location: 'Начало пути', time: 'сумерки', tension: 2 },
    facts: [{ text: 'Герой пришёл в место, где о вчерашнем не говорят.', importance: 2, pinned: false }],
    npcs: [],
    dead: false,
    deathReason: ''
  };
}

function handle(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n') || '';

  if (/Аудитор/i.test(system)) {
    return { violations: [], verdict: 'ok' };
  }
  if (/архивариус/i.test(system)) {
    return {
      facts: [{ text: 'Медный ключ открывает дверь в подвале, но не ту, о которой говорят вслух.', importance: 3, pinned: true }],
      npcs: [{ name: 'Сторож', attitude: -1, note: 'боится подвалов', status: 'жив' }],
      quests: [{ title: 'Понять, что за дверью в подвале', status: 'active', note: 'ключ уже у героя' }]
    };
  }
  if (/Начни игру/i.test(user)) return openingScene(user);
  return turnScene(user);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'mock/loria-scene' }, { id: 'mock/loria-backup' }] }));
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'not found' } }));
  }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad json' } }));
    }
    const payload = handle(body);
    const choice = { message: { role: 'assistant', content: JSON.stringify(payload) } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock-1',
        model: body.model || 'mock/loria-scene',
        choices: [choice],
        usage: { prompt_tokens: 900, completion_tokens: 420, total_tokens: 1320 }
      })
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-ai слушает http://127.0.0.1:${PORT}/api/v1`);
});
