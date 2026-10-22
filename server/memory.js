// Гибридная память мира.
// 1) каскад правил — важные факты (клятвы, имена, смерти) помечаются как «несгораемые»;
// 2) поиск по смыслу — лексический индекс с IDF, учётом сущностей и свежести.
// Никаких внешних эмбеддингов: память работает локально и бесплатно, но по-настоящему.

const STOP = new Set(
  ('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня ' +
    'еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там ' +
    'потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе ' +
    'под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда ' +
    'зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много ' +
    'разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между ' +
    'этот очень свой ваш весь')
);

const endRe =
  /(иями|ями|ами|ыми|ими|его|ого|ему|ому|ией|ей|ой|ый|ий|ая|ое|ые|ых|их|ую|юю|ям|ам|ом|ем|ах|ях|ов|ев|ия|ии|ию|ью|а|я|ы|и|о|е|у|ю|ь)$/;

export function stem(word) {
  let w = word.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9]/gi, '');
  if (w.length <= 3) return w;
  for (let i = 0; i < 2; i++) {
    const next = w.replace(endRe, '');
    if (next.length < 3) break;
    w = next;
  }
  return w;
}

export function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem)
    .filter(Boolean);
}

function termFreq(toks) {
  const tf = new Map();
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function buildIdf(docs) {
  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  const N = docs.length || 1;
  for (const [t, n] of df) idf.set(t, Math.log(1 + N / (1 + n)));
  return idf;
}

function scoreDoc(doc, qtf, idf, qTokens) {
  let score = 0;
  const len = doc.toks.length || 1;
  for (const [term, qn] of qtf) {
    const n = doc.tf.get(term);
    if (!n) continue;
    const w = idf.get(term) || 1;
    score += ((n * (qTokens.length > 8 ? 1.2 : 1.6)) / (1 + len / 60)) * w * qn;
  }
  // бонус за точное вхождение имени/сущности
  for (const ent of doc.entities || []) {
    if (qTokens.includes(stem(ent))) score += 1.4;
  }
  return score;
}

function entityList(state) {
  const names = new Set();
  for (const npc of state?.memory?.npcs || []) if (npc?.name) names.add(npc.name);
  if (state?.scene?.location) names.add(state.scene.location.split(',')[0]);
  if (state?.world?.title) names.add(state.world.title);
  return [...names];
}

/**
 * Достаёт из памяти всё, что относится к текущему действию и сцене.
 * Возвращает факты и фрагменты прошлых сцен с оценкой релевантности.
 */
export function retrieve(state, query, { maxFacts = 9, maxChunks = 3 } = {}) {
  const mem = state.memory || { facts: [], chunks: [], npcs: [] };
  const facts = mem.facts || [];
  const chunks = (mem.chunks || []).slice(-120);
  const entities = entityList(state);

  const queryText = [query, state.scene?.location, ...(state.memory?.quests || []).filter((q) => q.status === 'active').map((q) => q.title)]
    .filter(Boolean)
    .join(' ');
  const qTokens = [...new Set(tokens(queryText))];
  const qtf = termFreq(tokens(queryText));

  const factDocs = facts.map((f) => ({
    ...f,
    toks: tokens(f.text),
    tf: termFreq(tokens(f.text)),
    entities: entities.filter((e) => f.text?.toLowerCase().includes(e.toLowerCase()))
  }));
  const chunkDocs = chunks.map((c) => ({
    ...c,
    toks: tokens(c.text),
    tf: termFreq(tokens(c.text)),
    entities: entities.filter((e) => c.text?.toLowerCase().includes(e.toLowerCase()))
  }));

  const idf = buildIdf([...factDocs, ...chunkDocs]);
  const totalTurns = state.scene?.turn || 1;

  function rank(doc, isFact) {
    let s = scoreDoc(doc, qtf, idf, qTokens);
    const age = totalTurns - (doc.turn || 0);
    s += Math.max(0, 1.2 - age * 0.03); // свежесть
    if (isFact && doc.importance) s += doc.importance * 0.55;
    if (isFact && doc.pinned) s += 2.2;
    return s;
  }

  const rankedFacts = factDocs
    .map((d) => ({ d, s: rank(d, true) }))
    .sort((a, b) => b.s - a.s);
  const pinned = rankedFacts.filter((x) => x.d.pinned);
  const rest = rankedFacts.filter((x) => !x.d.pinned && x.s > 0.35);
  const pickedFacts = [...pinned.slice(-8), ...rest].slice(0, maxFacts);

  const pickedChunks = chunkDocs
    .map((d) => ({ d, s: rank(d, false) }))
    .filter((x) => x.s > 0.8)
    .sort((a, b) => b.s - a.s)
    .slice(0, maxChunks);

  return {
    facts: pickedFacts.map((x) => ({
      text: x.d.text,
      turn: x.d.turn,
      pinned: !!x.d.pinned,
      importance: x.d.importance || 1,
      score: Math.round(x.s * 100) / 100
    })),
    chunks: pickedChunks.map((x) => ({
      text: x.d.text,
      turn: x.d.turn,
      score: Math.round(x.s * 100) / 100
    })),
    entities
  };
}

/** Записывает ход в долговременную память: факты + фрагменты сцены. */
export function rememberTurn(state, { turn, action, narration, facts, npcs, location }) {
  const mem = state.memory;
  const now = turn;

  for (const raw of facts || []) {
    const text = String(raw?.text ?? raw ?? '').trim().slice(0, 260);
    if (text.length < 6) continue;
    if (mem.facts.some((f) => f.text.toLowerCase() === text.toLowerCase())) continue;
    mem.facts.push({
      turn: now,
      text,
      importance: Math.max(1, Math.min(3, Number(raw?.importance) || (raw?.pinned ? 3 : 1))),
      pinned: !!raw?.pinned,
      tags: Array.isArray(raw?.tags) ? raw.tags.slice(0, 4).map((t) => String(t).slice(0, 24)) : []
    });
  }

  const paragraphs = String(narration || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 80);
  paragraphs.slice(0, 3).forEach((p, i) => {
    mem.chunks.push({ turn: now, text: p.slice(0, 700), idx: i, location: location || state.scene?.location });
  });

  mem.chunks.push({
    turn: now,
    text: `Игрок: ${String(action || '').slice(0, 300)}`,
    idx: 9,
    location: location || state.scene?.location
  });

  // мягкая компакция, чтобы файл не разрастался бесконечно
  if (mem.facts.length > 240) {
    const pinned = mem.facts.filter((f) => f.pinned);
    const rest = mem.facts.filter((f) => !f.pinned).slice(-180);
    mem.facts = [...rest, ...pinned].slice(-240);
  }
  if (mem.chunks.length > 320) mem.chunks = mem.chunks.slice(-320);

  if (Array.isArray(npcs)) {
    for (const incoming of npcs.slice(0, 6)) {
      const name = String(incoming?.name || '').trim().slice(0, 60);
      if (!name) continue;
      const existing = mem.npcs.find((n) => n.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (incoming.attitude != null) {
          existing.attitude = Math.max(-5, Math.min(5, Number(incoming.attitude) || existing.attitude));
        }
        if (incoming.note) existing.note = String(incoming.note).slice(0, 200);
        if (incoming.status) existing.status = String(incoming.status).slice(0, 40);
        existing.lastTurn = now;
      } else {
        mem.npcs.push({
          name,
          attitude: Math.max(-5, Math.min(5, Number(incoming?.attitude) || 0)),
          note: String(incoming?.note || '').slice(0, 200),
          status: String(incoming?.status || 'на сцене').slice(0, 40),
          firstTurn: now,
          lastTurn: now
        });
      }
    }
    if (mem.npcs.length > 40) mem.npcs = mem.npcs.slice(-40);
  }
}

/** Короткая хроника: первые фразы ходов — для быстрого контекста. */
export function chronicle(state, limit = 10) {
  return (state.log || [])
    .slice(-limit)
    .map((entry) => {
      const paragraphs = String(entry.narration || '')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
      // первый абзац обычно атмосфера, второй — что произошло на самом деле
      const source = (paragraphs[1] || paragraphs[0] || '').split(/(?<=[.!?])\s/).slice(0, 2).join(' ');
      return { turn: entry.turn, action: entry.action, headline: source.slice(0, 180) };
    });
}

export function memoryIndexSize(state) {
  const mem = state.memory || {};
  return {
    facts: (mem.facts || []).length,
    chunks: (mem.chunks || []).length,
    npcs: (mem.npcs || []).length,
    quests: (mem.quests || []).length,
    pinned: (mem.facts || []).filter((f) => f.pinned).length
  };
}
