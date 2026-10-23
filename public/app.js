// ЛОРИЯ — клиент. Без фреймворков: один файл, делегирование событий, аккуратный DOM.

const app = document.getElementById('app');
const overlayRoot = document.getElementById('overlay-root');
const toastEl = document.getElementById('toast');

const store = {
  content: null,
  game: null,
  games: [],
  draft: null,
  view: 'boot',
  busy: false,
  tab: 'facts',
  lastTurn: null,
  rollMemory: null,
  boostArmed: false,
  earlier: [],
  earlierFrom: null,
  archive: { q: '', filter: 'all', sort: 'recent' },
  lastAi: null
};

const STAT_SHORT = { Сила: 'Сила', Ловкость: 'Ловк', Разум: 'Разум', Воля: 'Воля', Харизма: 'Хар' };

const NAMES = [
  'Вейл', 'Сорин', 'Мара', 'Даг', 'Ирма', 'Кай', 'Нора', 'Тео', 'Аста', 'Руф',
  'Лиан', 'Грета', 'Оден', 'Вера', 'Соль', 'Тарн', 'Юна', 'Бран', 'Эйра', 'Мор'
];

// ---------- утилиты ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nl2p = (text) =>
  esc(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

const clampText = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('err', isError);
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 4200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

function aiState() {
  const ai = store.content?.ai || {};
  if (!ai.available) return { label: 'резервный рассказчик', tone: '' };
  if (ai.lastFailure) return { label: 'модель не отвечает · резерв', tone: 'chip--blood' };
  return { label: 'ИИ-мастер активен', tone: 'chip--accent' };
}

function setAccent(color) {
  if (color) document.documentElement.style.setProperty('--accent', color);
}

function formatTurnDate(ts) {
  try {
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}

function timeAgo(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (!Number.isFinite(diff) || diff < 0) return '';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'вчера';
  if (days < 30) return `${days} дн назад`;
  return formatTurnDate(ts);
}

function plural(n, forms) {
  const value = Math.abs(Number(n) || 0) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
}

// ---------- иконки ----------

const MARK = `<svg class="brand__mark" viewBox="0 0 100 100" fill="none" aria-hidden="true">
  <path d="M50 6 61 41 96 50 61 59 50 94 39 59 4 50 39 41Z" fill="currentColor" opacity=".9"/>
  <circle cx="50" cy="50" r="10" fill="#0a090b"/>
</svg>`;

// ---------- загрузка ----------

async function boot() {
  renderLoader();
  try {
    const [content, games] = await Promise.all([api('/api/content'), api('/api/games').catch(() => ({ games: [] }))]);
    store.content = content;
    store.games = games.games || [];
  } catch (err) {
    app.innerHTML = `<div class="loader"><p>Сервер не отвечает: ${esc(err.message)}</p><button class="btn" data-act="reload">Повторить</button></div>`;
    return;
  }
  await route();
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);
  window.addEventListener(
    'scroll',
    () => {
      const btn = document.getElementById('to-bottom');
      if (!btn) return;
      const gap = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      btn.classList.toggle('is-on', gap > 500);
    },
    { passive: true }
  );
}

function renderLoader() {
  app.innerHTML = `<div class="loader">
    <svg class="loader__mark" viewBox="0 0 100 100" fill="none"><path d="M50 6 61 41 96 50 61 59 50 94 39 59 4 50 39 41Z" fill="currentColor"/></svg>
    <div class="eyebrow">Мастер готовит мир</div>
  </div>`;
}

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, section, param] = hash.split('/');

  if (section === 'game' && param) {
    store.view = 'game';
    await openGame(param);
    return;
  }
  if (section === 'create' && param) {
    store.view = 'create';
    startBuilder(param);
    return;
  }
  if (section === 'worlds') {
    store.view = 'worlds';
    await refreshGames();
    renderWorlds();
    return;
  }
  if (section === 'rules') {
    store.view = 'rules';
    renderRules();
    return;
  }
  if (section === 'archive') {
    store.view = 'archive';
    store.games = (await api('/api/games').catch(() => ({ games: [] }))).games || [];
    renderArchive();
    return;
  }
  store.view = 'home';
  await refreshGames();
  renderHome();
}

async function refreshGames() {
  try {
    store.games = (await api('/api/games')).games || [];
  } catch {
    /* не критично */
  }
}

// ---------- главный экран ----------

function renderHome() {
  const worlds = store.content.worlds;
  const lastId = localStorage.getItem('loria:last');
  const lastGame = store.games.find((g) => g.id === lastId) || store.games[0];
  setAccent('#c9814a');

  const slides = worlds.map((w) => w.art);
  app.innerHTML = `
  <section class="hero-screen">
    <div class="hero-screen__bg" data-slide="0" style="background-image:url('${esc(slides[0])}')"></div>
    <div class="hero-screen__bg" data-slide="1" style="background-image:url('${esc(slides[1] || slides[0])}')"></div>

    <header class="topbar">
      <div class="brand">
        ${MARK}
        <div>
          <div class="brand__name">Лория</div>
          <div class="brand__sub">${store.content.ai.available ? 'мастер на связи' : 'резервный рассказчик'}</div>
        </div>
      </div>
      <div class="topbar__meta">
        <span class="chip">${store.content.worlds.length} ${plural(store.content.worlds.length, ['мир', 'мира', 'миров'])}</span>
        <button class="chip ${aiState().tone}" data-act="ai-panel" title="Проверить мастера" style="background:none;border:1px solid var(--line);cursor:pointer"><span class="dot"></span>${aiState().label}</button>
        <button class="btn btn--ghost btn--small" data-act="nav" data-to="/rules">Правила</button>
        <button class="btn btn--ghost btn--small" data-act="nav" data-to="/archive">Архив</button>
      </div>
    </header>

    <div class="hero-screen__body">
      <div class="hero-copy">
        <div class="eyebrow">Текстовая RPG · ИИ-мастер с собственным мнением</div>
        <h1 class="hero-title">Лория<span>.</span></h1>
        <p class="hero-lead">
          Мастер не поддакивает. Проверки кидает сервер, а не модель.
          Мир помнит твои клятвы, долги и имена — и не смягчает последствий.
        </p>
        <div class="hero-actions">
          <button class="btn btn--primary" data-act="nav" data-to="/worlds">Новая история</button>
          <button class="btn btn--ghost" data-act="random-world">Случайный мир</button>
          ${lastGame ? `<button class="btn" data-act="open" data-id="${esc(lastGame.id)}">${lastGame.status === 'dead' ? 'Открыть хронику' : lastGame.status === 'finished' ? 'Перечитать финал' : 'Продолжить'}: ${esc(clampText(lastGame.heroName, 18))}</button>` : ''}
        </div>
        <p class="hero-note">
          Внутри: броски d20 / 2d6 / d100 на сервере, аудитор состояния, гибридная память мира и смерть, которую нельзя отменить.
          ${!store.content.ai.available ? '<br><span style="color:var(--accent)">Модель не подключена — сейчас сцены пишет резервный рассказчик. Правила и броски те же.</span>' : ''}
        </p>
      </div>

      <aside class="hero-aside">
        <div class="mini-card">
          <h4>Как это работает</h4>
          <ul>
            <li><b>01</b><span>Ты выбираешь мир и героя — с чертой и бременем.</span></li>
            <li><b>02</b><span>Каждое рискованное действие проверяется серверным броском.</span></li>
            <li><b>03</b><span>Мастер пишет сцену строго по исходу броска.</span></li>
            <li><b>04</b><span>Валидатор режет любую попытку обмануть цифры.</span></li>
          </ul>
        </div>
        ${lastGame ? `<div class="mini-card">
          <h4>Последняя история</h4>
          <p><b style="color:var(--ink)">${esc(lastGame.heroName)}</b> · ${esc(lastGame.title)}<br>
          Ходов: ${lastGame.turn - 1} · HP ${esc(lastGame.hp)} · ${lastGame.status === 'dead' ? 'герой погиб' : lastGame.status === 'finished' ? 'история завершена' : 'на паузе'}</p>
        </div>` : ''}
      </aside>
    </div>
    <div class="scroll-hint">выбери мир</div>
  </section>`;

  startSlideshow();
}

let slideTimer = null;
function startSlideshow() {
  clearInterval(slideTimer);
  const layers = [...app.querySelectorAll('.hero-screen__bg')];
  if (layers.length < 2 || !store.content) return;
  const arts = store.content.worlds.map((w) => w.art);
  let idx = 0;
  let front = 0;
  layers[0].classList.add('is-on');
  slideTimer = setInterval(() => {
    idx = (idx + 1) % arts.length;
    const back = 1 - front;
    layers[back].style.backgroundImage = `url('${arts[idx]}')`;
    layers[back].classList.add('is-on');
    layers[front].classList.remove('is-on');
    front = back;
  }, 7000);
}

// ---------- миры ----------

function renderWorlds() {
  clearInterval(slideTimer);
  setAccent('#c9814a');
  const alive = (store.games || []).filter((g) => g.status !== 'dead');
  const systems = [...new Set(store.content.worlds.map((w) => (w.system || 'd20').toUpperCase()))];
  app.innerHTML = `
  <div class="page">
    <header class="topbar" style="padding-left:0;padding-right:0">
      <div class="brand">${MARK}<div><div class="brand__name">Лория</div><div class="brand__sub">выбор мира</div></div></div>
      <button class="btn btn--ghost btn--small" data-act="nav" data-to="/">Назад</button>
    </header>

    <div class="page-head">
      <div>
        <div class="eyebrow">Шаг 1 из 2</div>
        <h1>Мир, который тебя не ждал</h1>
        <p>У каждого мира свои правила и своя система проверок. Механику задаёт автор мира, а не движок — мастер обязан их соблюдать.</p>
      </div>
      <div class="chip">${store.content.worlds.length} ${plural(store.content.worlds.length, ['мир', 'мира', 'миров'])} · ${systems.length} ${plural(systems.length, ['система', 'системы', 'систем'])} · ${systems.join(' / ')}</div>
    </div>

    ${
      alive.length
        ? `<div class="resume-strip">
            <div class="resume-strip__label">Незаконченные истории</div>
            <div class="resume-strip__row">
              ${alive
                .slice(0, 4)
                .map(
                  (g) => `<button class="resume-card" data-act="open" data-id="${esc(g.id)}">
                    <span class="resume-card__cover" style="background-image:url('${esc(g.art || '/art/world-ash.jpg')}')"></span>
                    <span class="resume-card__body">
                      <b>${esc(g.heroName)}</b>
                      <span>${esc(g.title)} · ход ${Math.max(0, (g.turn || 1) - 1)} · ур. ${esc(g.level || 1)}</span>
                    </span>
                    <span class="resume-card__go">→</span>
                  </button>`
                )
                .join('')}
            </div>
          </div>`
        : ''
    }

    <div class="worlds-grid">
      ${store.content.worlds
        .map(
          (w) => `
        <button class="world-card" style="--card-accent:${esc(w.accent)}" data-act="pick-world" data-id="${esc(w.id)}">
          <img src="${esc(w.art)}" alt="" loading="lazy" />
          <span class="chip world-card__genre">${esc(w.genre)}</span>
          <h3>${esc(w.title)}</h3>
          <p>${esc(w.pitch)}</p>
          <div class="world-card__foot">
            <span class="chip">${esc((w.system || 'd20').toUpperCase())}</span>
            <span class="chip chip--accent">Войти →</span>
          </div>
        </button>`
        )
        .join('')}
      <button class="world-card world-card--custom" data-act="pick-world" data-id="custom">
        <span class="chip">Авторский мир</span>
        <h3>Свой мир</h3>
        <p>Задай декорации, тон и правила. Мастер будет судить по ним — буквально.</p>
        <div class="world-card__foot"><span class="chip">твои правила</span><span class="chip chip--accent">Создать →</span></div>
      </button>
    </div>

    <div class="footer-note">
      <span>Лория · движок текстовых RPG</span>
      <span>${store.content.ai.available ? (store.content.ai.lastFailure ? 'Модель не ответила при старте — доступен резерв' : 'Модель подключена через OpenRouter') : 'Модель не подключена — работает резервный рассказчик'}</span>
    </div>
  </div>`;
}

// ---------- конструктор героя ----------

function startBuilder(worldId) {
  const isCustom = worldId === 'custom';
  const world = isCustom ? null : store.content.worlds.find((w) => w.id === worldId);
  if (!isCustom && !world) {
    location.hash = '#/worlds';
    return;
  }
  store.draft = {
    worldId,
    customWorld: isCustom
      ? { title: '', genre: 'Авторский мир', setting: '', tone: '', rules: '', start: '' }
      : null,
    name: NAMES[Math.floor(Math.random() * NAMES.length)],
    archetypeId: 'soldier',
    traitId: 'cold',
    burdenId: 'debt',
    difficulty: 'grim',
    appearance: ''
  };
  renderBuilder();
}

function heroPreview() {
  const d = store.draft;
  const arch = store.content.archetypes.find((a) => a.id === d.archetypeId);
  const diff = store.content.difficulties.find((x) => x.id === d.difficulty);
  const stats = arch.stats;
  const hp = Math.max(4, 10 + stats.Сила + stats.Воля + diff.hpBonus);
  return { arch, diff, hp, stats };
}

function renderBuilder() {
  const d = store.draft;
  const world = d.customWorld
    ? {
        title: d.customWorld.title || 'Свой мир',
        genre: d.customWorld.genre,
        art: '/art/world-ash.jpg',
        accent: '#b8865a',
        pitch: 'Мир, который придумал ты.'
      }
    : store.content.worlds.find((w) => w.id === d.worldId);
  setAccent(world.accent || '#c9814a');
  const { arch, diff, hp, stats } = heroPreview();
  const trait = store.content.traits.find((t) => t.id === d.traitId);
  const burden = store.content.burdens.find((b) => b.id === d.burdenId);

  app.innerHTML = `
  <div class="page">
    <header class="topbar" style="padding-left:0;padding-right:0">
      <div class="brand">${MARK}<div><div class="brand__name">Лория</div><div class="brand__sub">${esc(world.title)}</div></div></div>
      <button class="btn btn--ghost btn--small" data-act="nav" data-to="/worlds">Другой мир</button>
    </header>

    <div class="page-head">
      <div>
        <div class="eyebrow">Шаг 2 из 2 · ${esc(world.genre)}</div>
        <h1>${esc(world.title)}</h1>
        <p>${esc(world.pitch)}</p>
      </div>
    </div>

    <div class="builder">
      <div class="builder__main">

        <section class="panel panel--flat">
          <h3>Кто ты</h3>
          <p class="panel__hint">Класс не даёт бессмертия. Он задаёт только то, как ты будешь ошибаться.</p>
          <div class="arch-grid">
            ${store.content.archetypes
              .map(
                (a) => `
              <button class="arch ${a.id === d.archetypeId ? 'is-active' : ''}" data-act="pick-arch" data-id="${esc(a.id)}">
                ${a.portrait ? `<span class="arch__portrait"><img src="${esc(a.portrait)}" alt="" loading="lazy" /></span>` : ''}
                <span class="arch__name">${esc(a.name)}</span>
                <span class="arch__tag">${esc(a.tagline)}</span>
                <span class="arch__stats">
                  ${Object.entries(a.stats)
                    .map(
                      ([k, v]) => `<span class="stat-mini"><span>${esc(STAT_SHORT[k] || k)}</span>
                      <span class="stat-mini__bar"><i style="width:${(v / 9) * 100}%"></i></span><span>${v}</span></span>`
                    )
                    .join('')}
                </span>
              </button>`
              )
              .join('')}
          </div>
        </section>

        <section class="panel panel--flat">
          <h3>Имя и лицо</h3>
          <p class="panel__hint">Имя в этом мире будут произносить. Иногда — последним.</p>
          <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end;">
            <label class="field"><span>Как тебя зовут</span>
              <input class="input" id="hero-name" maxlength="32" value="${esc(d.name)}" placeholder="Безымянный" />
            </label>
            <button class="btn" data-act="random-name">Случайно</button>
          </div>
          <label class="field" style="margin-top:14px"><span>Коротко о внешности (необязательно)</span>
            <input class="input" id="hero-look" maxlength="200" value="${esc(d.appearance)}" placeholder="Шрам через бровь, руки в старых ожогах" />
          </label>
        </section>

        <section class="panel panel--flat">
          <h3>Черта</h3>
          <p class="panel__hint">Одно преимущество. За него всегда платят.</p>
          <div class="pick-row">
            ${store.content.traits
              .map(
                (t) => `<button class="pick ${t.id === d.traitId ? 'is-active' : ''}" data-act="pick-trait" data-id="${esc(t.id)}">
                  <b>${esc(t.name)}</b><span>${esc(t.desc)}</span></button>`
              )
              .join('')}
          </div>
        </section>

        <section class="panel panel--flat">
          <h3>Бремя</h3>
          <p class="panel__hint">То, что ты несёшь. Оно будет напоминать о себе в худший момент.</p>
          <div class="pick-row">
            ${store.content.burdens
              .map(
                (b) => `<button class="pick ${b.id === d.burdenId ? 'is-active' : ''}" data-act="pick-burden" data-id="${esc(b.id)}">
                  <b>${esc(b.name)}</b><span>${esc(b.desc)}</span></button>`
              )
              .join('')}
          </div>
        </section>

        <section class="panel panel--flat">
          <h3>Насколько жёстко</h3>
          <p class="panel__hint">Сложность меняет цену каждого хода, а не текст.</p>
          <div class="pick-row">
            ${store.content.difficulties
              .map(
                (x) => `<button class="pick ${x.id === d.difficulty ? 'is-active' : ''}" data-act="pick-diff" data-id="${esc(x.id)}">
                  <b>${esc(x.name)}</b><span>${esc(x.desc)}</span></button>`
              )
              .join('')}
          </div>
        </section>

        ${
          d.customWorld
            ? `<section class="panel panel--flat">
                <h3>Твой мир</h3>
                <p class="panel__hint">Чем конкретнее правила, тем честнее мастер. Пустые поля он заполнит сам — но по своему усмотрению.</p>
                <div style="display:grid;gap:12px;">
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                    <label class="field"><span>Название мира</span><input class="input" id="cw-title" maxlength="60" value="${esc(d.customWorld.title)}" placeholder="Стеклянный город" /></label>
                    <label class="field"><span>Жанр</span><input class="input" id="cw-genre" maxlength="40" value="${esc(d.customWorld.genre)}" placeholder="мистика" /></label>
                  </div>
                  <label class="field"><span>Декорации и устройство мира</span><textarea class="textarea" id="cw-setting" maxlength="4000" placeholder="Город стоит на костях...">${esc(d.customWorld.setting)}</textarea></label>
                  <label class="field"><span>Тон повествования</span><textarea class="textarea" id="cw-tone" maxlength="1200" placeholder="Сухо, холодно, без надежды...">${esc(d.customWorld.tone)}</textarea></label>
                  <label class="field"><span>Правила мира (можно указать d20, 2d6 или d100)</span><textarea class="textarea" id="cw-rules" maxlength="4000" placeholder="СИСТЕМА: d20 + характеристика против сложности 12. Магия стоит крови...">${esc(d.customWorld.rules)}</textarea></label>
                  <label class="field"><span>С чего начинается история</span><textarea class="textarea" id="cw-start" maxlength="2000" placeholder="Ты просыпаешься в чужом вагоне...">${esc(d.customWorld.start)}</textarea></label>
                </div>
              </section>`
            : ''
        }
      </div>

      <aside class="builder__aside">
        <div class="panel preview-hero">
          <div class="eyebrow">Твой герой</div>
          <div class="preview-hero__name">${esc(d.name || 'Безымянный')}</div>
          <div class="preview-hero__role">${esc(arch.name)} · ${esc(diff.name)}</div>
          <div class="preview-hero__art" style="background-image:url('${esc(arch.portrait || world.art)}')"></div>
          ${arch.hook ? `<p class="preview-hero__hook">${esc(arch.hook)}</p>` : ''}
          <div class="kv"><span>Здоровье</span><b>${hp}</b></div>
          <div class="kv"><span>Энергия</span><b>24</b></div>
          <div class="kv"><span>Золото</span><b>15</b></div>
          <div class="kv"><span>Черта</span><b>${esc(trait.name)}</b></div>
          <div class="kv"><span>Бремя</span><b>${esc(burden.name)}</b></div>
          <div class="kv"><span>Система</span><b>${esc((world.system || 'd20').toUpperCase())}</b></div>
        </div>
        <button class="btn btn--primary" data-act="start-game" ${store.busy ? 'disabled' : ''}>${store.busy ? 'Мастер пишет...' : 'Войти в мир'}</button>
        <p style="font-size:11.5px;color:var(--muted);text-align:center;margin:0">
          Первая сцена займёт до 20 секунд. Ходы потом короче.
        </p>
      </aside>
    </div>
  </div>`;

  const nameInput = document.getElementById('hero-name');
  nameInput?.addEventListener('input', (e) => {
    store.draft.name = e.target.value;
    const preview = app.querySelector('.preview-hero__name');
    if (preview) preview.textContent = e.target.value || 'Безымянный';
  });
  document.getElementById('hero-look')?.addEventListener('input', (e) => {
    store.draft.appearance = e.target.value;
  });
  for (const key of ['title', 'genre', 'setting', 'tone', 'rules', 'start']) {
    document.getElementById(`cw-${key}`)?.addEventListener('input', (e) => {
      store.draft.customWorld[key] = e.target.value;
      if (key === 'title') {
        const brandSub = app.querySelector('.brand__sub');
        if (brandSub) brandSub.textContent = e.target.value || 'Свой мир';
      }
    });
  }
}

async function createGame() {
  const d = store.draft;
  if (!d || store.busy) return;
  if (d.customWorld) {
    if (d.customWorld.title.trim().length < 3) return toast('Дай миру название', true);
    if (d.customWorld.setting.trim().length < 30) return toast('Опиши мир хотя бы в двух предложениях', true);
    if (d.customWorld.start.trim().length < 15) return toast('Опиши, с чего начинается история', true);
  }
  store.busy = true;
  const btn = app.querySelector('[data-act="start-game"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Мастер раскладывает карты...';
  }
  showThinkingOverlay('Мастер входит в мир', 'Собирает память, правила и первую сцену. Это самый долгий запрос.');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 130000);
    const res = await api('/api/games', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        worldId: d.worldId,
        customWorld: d.customWorld,
        difficulty: d.difficulty,
        hero: {
          name: d.name,
          archetypeId: d.archetypeId,
          traitId: d.traitId,
          burdenId: d.burdenId,
          appearance: d.appearance
        }
      })
    });
    clearTimeout(timer);
    hideOverlay();
    store.game = res.state;
    store.earlier = [];
    store.earlierFrom = res.state.logFrom ?? 0;
    store.lastAi = res.demo ? { demo: true, error: res.aiError || '' } : res.ai || null;
    localStorage.setItem('loria:last', res.state.id);
    if (res.demo) {
      toast(
        res.aiError ? `Мастер не ответил: ${clampText(res.aiError, 90)}` : 'Модель не ответила — начал резервный рассказчик.',
        true
      );
    }
    location.hash = `#/game/${res.state.id}`;
  } catch (err) {
    hideOverlay();
    toast(err.name === 'AbortError' ? 'Мастер молчит слишком долго. Попробуй ещё раз.' : err.message, true);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Войти в мир';
    }
  } finally {
    store.busy = false;
  }
}

// ---------- игра ----------

async function openGame(id) {
  store.view = 'game';
  renderLoader();
  try {
    const data = await api(`/api/games/${id}`);
    store.game = data.state;
    store.earlier = [];
    store.earlierFrom = data.state.logFrom ?? 0;
    store.lastAi = null;
    store.meta = data;
    localStorage.setItem('loria:last', id);
    setAccent(store.game.world.accent);
    renderPlay(data);
    scrollToBottom(false);
  } catch (err) {
    toast(err.message, true);
    location.hash = '#/';
  }
}

function checkCard(check) {
  const cls = check.success ? 'is-success' : 'is-fail';
  const verdict = check.critical ? 'критический успех' : check.fumble ? 'критический провал' : check.verdict;
  const boost = check.boosted
    ? `<span class="check-card__boost" title="Рывок: второй бросок, взят лучший">рывок${check.rerolledFrom ? ` · было ${check.rerolledFrom.total}` : ''}</span>`
    : '';
  return `<div class="check-card ${cls}">
    <span class="check-card__die"><b>${esc(check.dice?.join('+') || '—')}</b></span>
    <span>${esc(check.stat)} · ${esc(check.formula)} = <b style="color:var(--ink)">${check.total}</b> / сложность ${check.dc}</span>
    ${boost}
    <span class="check-card__verdict">${esc(verdict)}</span>
  </div>`;
}

function turnHTML(entry, isFirst, isNew = false) {
  const limits = Array.isArray(entry.limits) ? entry.limits : [];
  if (entry.finale) {
    return `<article class="turn turn--finale" data-turn="${entry.turn}" ${isNew ? 'data-new="1"' : ''}>
      ${entry.epitaph ? `<div class="turn__epitaph">${esc(entry.epitaph)}</div>` : ''}
      <div class="narration">${nl2p(entry.narration)}</div>
      <div class="turn__tags"><span class="tag tag--finale">история окончена</span></div>
    </article>`;
  }
  return `<article class="turn" data-turn="${entry.turn}" ${isNew ? 'data-new="1"' : ''}>
    <div class="turn__action"><b>Ход ${entry.turn}</b><span>${esc(entry.action)}</span></div>
    ${entry.check ? checkCard(entry.check) : isFirst ? '' : '<div class="turn__free">без броска</div>'}
    ${entry.arc ? `<div class="turn__arc">линия «${esc(entry.arc.title)}»: шаг ${entry.arc.step} из ${entry.arc.total}${
      entry.arc.complete ? ' — пройдена' : ''
    }${entry.arc.paced ? ' (по темпу)' : ''}</div>` : ''}
    <div class="narration">${nl2p(entry.narration)}</div>
    ${entry.xp || entry.leveled ? `<div class="turn__tags">
      ${entry.xp ? `<span class="tag tag--xp">+${entry.xp} опыта</span>` : ''}
      ${entry.leveled ? `<span class="tag tag--level">новый уровень</span>` : ''}
    </div>` : ''}
    ${limits.length ? `<div class="turn__tags">${limits.map((l) => `<span class="tag tag--warn">${esc(l)}</span>`).join('')}</div>` : ''}
    ${entry.demo ? `<div class="turn__tags"><span class="tag">резервный рассказчик</span></div>` : ''}
  </article>`;
}

function recapHTML(chronicle, s) {
  if (!chronicle.length || (s.scene.turn || 1) < 4) return '';
  const items = chronicle.slice(-5).reverse();
  return `<details class="recap">
    <summary><span class="recap__label">Ранее в истории</span><span class="recap__count">${items.length}</span></summary>
    <div class="recap__list">
      ${items
        .map(
          (c) => `<div class="recap__item"><span class="meta">ход ${c.turn}</span><b>${esc(clampText(c.action, 90))}</b>${
            c.headline ? `<span class="recap__line">${esc(c.headline)}</span>` : ''
          }</div>`
        )
        .join('')}
    </div>
  </details>`;
}

function headerHTML(s) {
  return `
    <div class="scene-title">
      <div class="eyebrow">${esc(s.world.genre)} · ${esc(s.difficulty.name)} · ход ${s.scene.turn - 1}</div>
      <h1>${esc(s.world.title)}</h1>
      <div class="scene-stats">
        <span class="scene-stat" data-k="hp"><i></i>HP <b>${s.hero.hp}</b><span>/${s.hero.maxHp}</span></span>
        <span class="scene-stat" data-k="en"><i></i>ЭН <b>${s.hero.energy}</b><span>/${s.hero.maxEnergy}</span></span>
        <span class="scene-stat" data-k="gold"><i></i><b>${s.hero.gold}</b> зол.</span>
        <span class="scene-stat" data-k="xp"><i></i>ур. <b>${s.hero.level || 1}</b><span> · ${s.hero.xp || 0}/${10 * (s.hero.level || 1)}</span></span>
        ${s.hero.boosts > 0 ? `<span class="scene-stat" data-k="boost"><i></i>рывок <b>${s.hero.boosts}</b></span>` : ''}
        <span class="save-pill" id="save-pill" title="Каждый ход сохраняется на диск">сохранено</span>
      </div>
      <div class="scene-hud">
        <span class="hud-item hud-item--hp"><i style="width:${Math.max(0, Math.min(100, (s.hero.hp / s.hero.maxHp) * 100))}%"></i><b>${s.hero.hp}/${s.hero.maxHp}</b></span>
        <span class="hud-item hud-item--en"><i style="width:${Math.max(0, Math.min(100, (s.hero.energy / s.hero.maxEnergy) * 100))}%"></i><b>${s.hero.energy}/${s.hero.maxEnergy}</b></span>
        <span class="hud-item hud-item--xp"><i style="width:${Math.min(100, ((s.hero.xp || 0) / (10 * (s.hero.level || 1))) * 100)}%"></i><b>ур.${s.hero.level || 1}</b></span>
        ${s.hero.pendingLevel ? `<button class="hud-level" data-act="levelup" aria-label="Выбрать улучшение">✦</button>` : ''}
      </div>
      <div class="scene-meta">
        <span class="chip chip--accent"><span class="dot"></span>${esc(s.scene.location)}</span>
        <span class="chip">${esc(s.scene.time || 'время не названо')}</span>
        ${s.scene.weather ? `<span class="chip">${esc(s.scene.weather)}</span>` : ''}
        <span class="chip">напряжение <span class="tension">${[1, 2, 3, 4, 5]
          .map((i) => `<i class="${i <= s.scene.tension ? 'on' : ''}"></i>`)
          .join('')}</span></span>
        ${s.arc ? `<button class="chip chip--arc${s.arc.complete ? ' is-complete' : ''}" data-act="arc-panel" title="Сюжетная линия">
          <span class="arc-dots">${s.arc.done.map(() => '<i class="on"></i>').join('')}${Array.from({ length: s.arc.left }, () => '<i></i>').join('')}</span>
          ${esc(s.arc.title)}
        </button>` : ''}
      </div>
    </div>
    <div class="scene-head__actions">
      <button class="btn btn--ghost btn--small sheet-toggle" data-act="toggle-sheet" aria-label="Открыть лист героя">Лист героя</button>
      <button class="btn btn--ghost btn--small" data-act="help" aria-label="Как играть">?</button>
      <button class="btn btn--ghost btn--small" data-act="ai-panel" aria-label="Мастер и модель">Мастер</button>
      <button class="btn btn--ghost btn--small" data-act="rules" aria-label="Правила мира">Правила</button>
      <a class="btn btn--ghost btn--small" href="/api/games/${esc(s.id)}/export">Хроника</a>
      <button class="btn btn--ghost btn--small" data-act="nav" data-to="/">Выход</button>
    </div>`;
}

// Лента: последние 60 ходов из состояния плюс всё, что игрок догрузил кнопкой.
function transcriptHTML() {
  const s = store.game;
  const log = s.log || [];
  const firstTurn = log[0]?.turn ?? Number.POSITIVE_INFINITY;
  const earlier = (store.earlier || []).filter((e) => e.turn < firstTurn);
  const earlierFrom = store.earlierFrom ?? s.logFrom ?? 0;
  return `
    ${earlierFrom > 0 ? `<button class="btn btn--ghost btn--small transcript__more" data-act="earlier">Показать более ранние ходы <b>${earlierFrom}</b></button>` : ''}
    ${recapHTML(store.meta?.chronicle || [], s)}
    ${earlier.map((entry, i) => turnHTML(entry, i === 0)).join('')}
    ${log.map((entry, i) => turnHTML(entry, !earlier.length && i === 0, i === log.length - 1 && log.length > 1)).join('')}`;
}

async function loadEarlier() {
  const s = store.game;
  if (!s || store.busy) return;
  const before = store.earlierFrom ?? s.logFrom ?? 0;
  if (before <= 0) return;
  const transcript = document.getElementById('transcript');
  const fromBottom = document.documentElement.scrollHeight - window.scrollY;
  try {
    const data = await api(`/api/games/${s.id}/turns?before=${before}&limit=30`);
    const known = new Set((store.earlier || []).map((e) => e.turn));
    store.earlier = [...(data.turns || []).filter((e) => !known.has(e.turn)), ...(store.earlier || [])];
    store.earlierFrom = data.from;
    if (transcript) transcript.innerHTML = transcriptHTML();
    window.scrollTo(0, Math.max(0, document.documentElement.scrollHeight - fromBottom));
  } catch (err) {
    toast(err.message || 'Не удалось загрузить историю', true);
  }
}

function aiMetaText() {
  const a = store.lastAi;
  if (!a) return '';
  if (a.demo) return a.error ? `Резервный рассказчик: ${clampText(a.error, 90)}` : 'Резервный рассказчик';
  const secs = a.ms ? ` · ${(a.ms / 1000).toFixed(1)} с` : '';
  const fix = a.repaired ? ' · формат починен' : a.degraded ? ' · ответ частичный' : '';
  const again = a.repeated ? ' · переписал самоповтор' : '';
  return `Мастер: ${a.model || 'модель'}${secs}${fix}${again}`;
}

function updateAiMeta() {
  const el = document.getElementById('ai-meta');
  if (!el) return;
  const text = aiMetaText();
  el.textContent = text;
  el.classList.toggle('is-bad', Boolean(store.lastAi?.demo || store.lastAi?.degraded));
}

function renderPlay(data) {
  const s = store.game;
  const log = s.log || [];
  const last = log[log.length - 1];
  const hero = s.hero;
  const dead = s.status === 'dead';
  const finished = s.status === 'finished';
  const arcReady = Boolean(s.arc?.complete) && !dead && !finished;

  app.innerHTML = `
  <div class="game">
    <header class="scene-head">
      <div class="scene-head__img" style="background-image:url('${esc(s.world.art)}')"></div>
      <div class="scene-head__inner">${headerHTML(s)}</div>
    </header>

    <div class="play-grid">
      <section class="transcript" id="transcript" aria-live="polite" aria-label="История">
        ${transcriptHTML()}
      </section>

      <aside class="sheet-col" id="sheet">
        ${sheetHTML()}
      </aside>
    </div>

    <footer class="composer" id="composer">
      <div class="composer__inner">
        <div class="choices" id="choices">
          ${
            finished
              ? `<button class="choice choice--finale" data-act="finale-screen" style="grid-column:1/-1"><b>Финал</b>История закончена. Прочитать эпилог.</button>`
              : dead
                ? `<button class="choice" data-act="death-screen" style="grid-column:1/-1"><b>Финал</b>История завершена. Посмотреть эпитафию.</button>`
                : arcReady
                  ? `<button class="choice choice--arc" data-act="open-finale" style="grid-column:1/-1"><b>Развязка</b>Линия пройдена до конца. Закончить историю здесь — или идти дальше.</button>`
                  : (last?.options || [])
                      .map((o, i) => choiceHTML(o, i))
                      .join('')
          }
        </div>
        <div class="free-form">
          <input class="input" id="free-action" maxlength="600" placeholder="${dead ? 'История окончена' : finished ? 'История закончена — но можно начать новую' : 'Или напиши своё действие...'}" ${dead || finished ? 'disabled' : ''} />
          ${dead || finished ? '' : `<button class="btn btn--boost ${hero.boosts > 0 ? '' : 'is-spent'}" data-act="toggle-boost" title="Второй бросок за ход, берётся лучший">
            <span>Рывок</span><b>${hero.boosts}/${hero.maxBoosts || 1}</b>
          </button>`}
          ${!dead && !finished && s.rewinds > 0 ? `<button class="btn btn--ghost btn--undo" data-act="rewind" title="Отменить последний ход и вернуться к началу сцены">
            <span>Отменить</span><b>${s.rewinds}</b>
          </button>` : ''}
          <button class="btn btn--primary" data-act="submit-free" ${dead || finished ? 'disabled' : ''}><span>Действовать</span>↵</button>
        </div>
        <div class="composer__hint">
          <span class="keys-hint">1–6 — варианты · ↑ — прошлые действия · H — лист героя · ? — подсказка</span>
          <span class="ai-meta" id="ai-meta">${esc(aiMetaText())}</span>
          ${store.boostArmed ? '<b style="color:var(--accent)">Рывок заряжен:</b> при провале сервер перебросит кубик и возьмёт лучший результат.' : 'Бросок делает сервер. Мастер не может его отменить.'}
          ${store.content.ai.available ? (store.content.ai.lastFailure ? ' Модель не ответила — сцены пишет резерв.' : '') : ' Резервный режим.'}
        </div>
      </div>
    </footer>
    <button class="to-bottom" id="to-bottom" data-act="to-bottom" aria-label="Прокрутить вниз">↓</button>
  </div>`;

  const freeInput = document.getElementById('free-action');
  freeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitFree();
      return;
    }
    if (e.key === 'ArrowUp' && e.target.selectionStart === 0 && e.target.selectionEnd === 0) {
      if (recallHistory(e.target, -1)) e.preventDefault();
    }
    if (e.key === 'ArrowDown' && store.histIndex != null && e.target.selectionStart === e.target.value.length) {
      if (recallHistory(e.target, 1)) e.preventDefault();
    }
  });
  freeInput?.addEventListener('input', () => {
    store.histIndex = null;
  });
  if (dead) setTimeout(() => showDeathOverlay(), 700);
}

function sheetHTML() {
  const s = store.game;
  const hero = s.hero;
  const mem = s.memory || { facts: [], npcs: [], quests: [] };
  const audit = (s.audit || []).slice(-12).reverse();
  const hpPct = Math.max(0, Math.min(100, (hero.hp / hero.maxHp) * 100));
  const enPct = Math.max(0, Math.min(100, (hero.energy / hero.maxEnergy) * 100));
  const goldPct = Math.min(100, hero.gold);
  const tab = store.tab;

  const facts = mem.facts.slice(-40).reverse();
  const npcs = [...mem.npcs].sort((a, b) => (b.lastTurn || 0) - (a.lastTurn || 0));

  return `
    <div class="sheet-head">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        ${hero.portrait ? `<img class="sheet-avatar" src="${esc(hero.portrait)}" alt="" />` : ''}
        <div style="min-width:0">
          <div class="sheet-name">${esc(hero.name)}</div>
          <div class="sheet-role">${esc(hero.archetype)}</div>
        </div>
      </div>
      <button class="btn btn--ghost btn--small sheet-close" data-act="toggle-sheet">×</button>
    </div>

    <div class="sheet-block">
      <div class="bar"><span class="bar__label">HP</span><span class="bar__track"><i class="bar__fill bar__fill--hp" style="width:${hpPct}%"></i></span><span class="bar__val">${hero.hp}/${hero.maxHp}</span></div>
      <div class="bar"><span class="bar__label">Энер</span><span class="bar__track"><i class="bar__fill bar__fill--en" style="width:${enPct}%"></i></span><span class="bar__val">${hero.energy}/${hero.maxEnergy}</span></div>
      <div class="bar"><span class="bar__label">Золото</span><span class="bar__track"><i class="bar__fill bar__fill--gold" style="width:${goldPct}%"></i></span><span class="bar__val">${hero.gold}</span></div>
    </div>

    <div class="sheet-block">
      <div class="bar">
        <span class="bar__label">Ур. ${hero.level || 1}</span>
        <span class="bar__track"><i class="bar__fill bar__fill--xp" style="width:${Math.min(100, ((hero.xp || 0) / (10 * (hero.level || 1))) * 100)}%"></i></span>
        <span class="bar__val">${hero.xp || 0}/${10 * (hero.level || 1)}</span>
      </div>
      ${hero.pendingLevel ? `<button class="btn btn--small btn--level" style="width:100%;margin-top:8px" data-act="levelup">Выбрать улучшение</button>` : ''}
    </div>

    <div class="sheet-block">
      <div style="display:flex;gap:8px">
        <button class="btn btn--small btn--rest" style="flex:1" data-act="rest" ${hero.energy < 6 ? 'disabled' : ''}>
          Передышка <b>−6⚡ / +4❤</b>
        </button>
        <button class="btn btn--small btn--boost ${hero.boosts > 0 ? '' : 'is-spent'}" style="flex:0 0 auto" data-act="toggle-boost" ${hero.boosts > 0 ? '' : 'disabled'}>
          Рывок <b>${hero.boosts}/${hero.maxBoosts || 1}</b>
        </button>
      </div>
    </div>

    <div class="sheet-block">
      <div class="stat-grid">
        ${Object.entries(hero.stats)
          .map(([k, v]) => `<div class="stat-cell"><b>${v}</b><span>${esc(STAT_SHORT[k] || k)}</span></div>`)
          .join('')}
      </div>
    </div>

    <div class="sheet-block">
      <div class="sheet-block__title">Состояния</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px">
        ${(hero.conditions.length ? hero.conditions : ['чист']).map((c) => `<span class="chip ${c === 'чист' ? '' : 'chip--blood'}">${esc(c)}</span>`).join('')}
      </div>
    </div>

    <div class="sheet-block">
      <div class="sheet-block__title">Черта и бремя</div>
      <div class="mem-item" style="margin-bottom:6px"><span class="meta">Черта</span>${esc(hero.trait.name)} — ${esc(hero.trait.desc)}</div>
      <div class="mem-item"><span class="meta">Бремя</span>${esc(hero.burden.name)} — ${esc(hero.burden.desc)}</div>
    </div>

    <div class="sheet-block">
      <div class="sheet-block__title">Где ты был <span>${(s.places || []).length}</span></div>
      <div class="item-list">
        ${(s.places || []).slice(-6).reverse().map((p) => `<span class="item">${esc(p)}</span>`).join('') || '<span class="mem-empty">пока нигде</span>'}
      </div>
    </div>

    <div class="sheet-block">
      <div class="sheet-block__title">Инвентарь <span>${hero.items.length}/16</span></div>
      <div class="item-list">${hero.items.map((i) => `<span class="item">${esc(i)}</span>`).join('') || '<span class="mem-empty">пусто</span>'}</div>
    </div>

    <div class="sheet-block">
      <div class="tabs">
        <button class="tab ${tab === 'facts' ? 'is-active' : ''}" data-act="tab" data-tab="facts">Память</button>
        <button class="tab ${tab === 'npcs' ? 'is-active' : ''}" data-act="tab" data-tab="npcs">NPC</button>
        <button class="tab ${tab === 'quests' ? 'is-active' : ''}" data-act="tab" data-tab="quests">Задания${
          mem.quests.some((q) => q.status === 'active') ? ` <b class="tab__count">${mem.quests.filter((q) => q.status === 'active').length}</b>` : ''
        }</button>
        <button class="tab ${tab === 'audit' ? 'is-active' : ''}" data-act="tab" data-tab="audit">Аудит</button>
        <button class="tab ${tab === 'chronicle' ? 'is-active' : ''}" data-act="tab" data-tab="chronicle">Ходы${(s.log || []).length ? ` <span class="tab__muted">${(s.log || []).length}</span>` : ''}</button>
      </div>

      ${
        tab === 'facts'
          ? `<div class="mem-list">${facts
              .map(
                (f) => `<div class="mem-item ${f.pinned ? 'pinned' : ''}">
                  <span class="meta">ход ${f.turn}${f.pinned ? ' · незыблемо' : ''}${f.compacted ? ' · уплотнено' : ''}</span>${esc(f.text)}</div>`
              )
              .join('') || '<div class="mem-empty">Мастер пока ничего не запомнил. Это ненадолго.</div>'}</div>
              ${(s.log || []).length >= 6 ? `<button class="btn btn--small" style="margin-top:8px;width:100%" data-act="compact">Уплотнить память</button>` : ''}`
          : ''
      }
      ${
        tab === 'npcs'
          ? `<div class="mem-list">${npcs
              .map(
                (n) => `<div class="mem-item">
                  <span class="meta">${esc(n.status || 'известен')} · отношение ${n.attitude > 0 ? '+' : ''}${n.attitude}</span>
                  <b style="color:var(--ink);font-weight:500">${esc(n.name)}</b>${n.note ? ` — ${esc(n.note)}` : ''}</div>`
              )
              .join('') || '<div class="mem-empty">Пока никого. В этом мире это редкость.</div>'}</div>`
          : ''
      }
      ${
        tab === 'quests'
          ? (() => {
              const order = { active: 0, done: 1, failed: 2 };
              const list = [...mem.quests].sort(
                (a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (b.updatedAt || 0) - (a.updatedAt || 0)
              );
              const activeCount = list.filter((q) => q.status === 'active').length;
              return `<div class="mem-summary">Активных: <b>${activeCount}</b> · всего: <b>${list.length}</b></div>
                <div class="mem-list">${list
                .map(
                  (q) => `<div class="mem-item ${q.status === 'active' ? 'pinned' : ''}">
                  <span class="meta">${q.status === 'active' ? 'активно' : q.status === 'done' ? 'завершено' : 'провалено'} · ход ${q.openedAt}</span>
                  ${esc(q.title)}${q.note ? `<br><span style="color:var(--muted)">${esc(q.note)}</span>` : ''}</div>`
                )
                .join('') || '<div class="mem-empty">Журнал пуст. Пока.</div>'}</div>`;
            })()
          : ''
      }
      ${
        tab === 'chronicle'
          ? `<div class="chronicle">${(s.log || [])
              .slice()
              .reverse()
              .map((t) => {
                const total = t.check ? ` · ${t.check.total}/${t.check.dc}` : '';
                const result = t.check ? (t.check.success ? 'ok' : 'fail') : t.finale ? 'finale' : '';
                const arcMark = t.arc ? ` · линия ${t.arc.step}/${t.arc.total}` : '';
                return `<button class="chronicle__item${t.finale ? ' is-finale' : ''}" data-act="goto-turn" data-turn="${t.turn}" data-result="${result}">
                  <span class="meta">ход ${t.turn}${total}${arcMark}</span>
                  <b>${esc(clampText(t.action, 70))}</b>
                  <span>${esc(clampText((t.narration || '').split(/\n{2,}/)[0], 110))}</span>
                </button>`;
              })
              .join('') || '<div class="mem-empty">История только началась.</div>'}</div>`
          : ''
      }
      ${
        tab === 'audit'
          ? `<div class="audit-list">${audit
              .map(
                (a) => `<div class="audit-item" data-kind="${esc(a.kind || 'apply')}" data-severity="${esc(a.severity || '')}">
                  <span class="meta">ход ${a.turn}${a.severity === 'hard' ? ' · нарушение' : ''}</span>${esc(a.message)}</div>`
              )
              .join('') || '<div class="mem-empty">Аудитор молчит: нарушений не было.</div>'}</div>
              <button class="btn btn--small" style="margin-top:8px;width:100%" data-act="audit">Проверить ход аудитором</button>`
          : ''
      }
    </div>

    <div class="sheet-block" style="margin-bottom:0">
      <div class="sheet-block__title">Сводка</div>
      <div class="kv"><span>Проверок</span><b>${s.stats.checks}</b></div>
      <div class="kv"><span>Успехов / провалов</span><b>${s.stats.successes} / ${s.stats.failures}</b></div>
      <div class="kv"><span>Криты / провалы</span><b>${s.stats.crits} / ${s.stats.fumbles}</b></div>
      <div class="kv"><span>Отметок аудитора</span><b>${(s.audit || []).length}</b></div>
      <div class="kv"><span>Отмен в запасе</span><b>${s.rewinds || 0}</b></div>
      <div class="kv"><span>Мир · система</span><b>${esc(s.world.title)} · ${esc((s.world.system || 'd20').toUpperCase())}</b></div>
      ${s.usage ? `<div class="kv"><span>Запросов к модели сегодня</span><b>${s.usage.requests}</b></div>` : ''}
      ${
        s.usage
          ? `<div class="kv"><span>Токены (вход / выход)</span><b>${Math.round((s.usage.promptTokens || 0) / 100) / 10}k / ${Math.round(
              (s.usage.completionTokens || 0) / 100
            ) / 10}k</b></div>`
          : ''
      }
      <div style="display:flex;gap:6px;margin-top:10px">
        <a class="btn btn--ghost btn--small" style="flex:1" href="/api/games/${esc(s.id)}/download">Скачать сохранение</a>
        <a class="btn btn--ghost btn--small" style="flex:1" href="/api/games/${esc(s.id)}/export" title="Хроника в Markdown">Хроника .md</a>
      </div>
    </div>
  `;
}

function updateSheet() {
  const sheet = document.getElementById('sheet');
  if (sheet) sheet.innerHTML = sheetHTML();
}

function refreshHeader() {
  const head = document.querySelector('.scene-head__inner');
  if (!head || !store.game) return;
  head.innerHTML = headerHTML(store.game);
  markSaved();
}

function markSaved() {
  const pill = document.getElementById('save-pill');
  if (!pill) return;
  pill.textContent = 'сохранено';
  pill.classList.add('is-flash');
  clearTimeout(markSaved.timer);
  markSaved.timer = setTimeout(() => pill.classList.remove('is-flash'), 1800);
}

function scrollToBottom(smooth = true) {
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  });
}

// ---------- ход ----------

function showThinking(action) {
  const transcript = document.getElementById('transcript');
  if (!transcript) return;
  const el = document.createElement('div');
  el.className = 'typing';
  el.id = 'typing-indicator';
  el.innerHTML = `<span class="typing__dots"><i></i><i></i><i></i></span>
    <span>${action ? `Мастер взвешивает: «${esc(clampText(action, 80))}»` : 'Мастер пишет сцену'}</span>`;
  const existing = document.getElementById('typing-indicator');
  if (existing) existing.remove();
  transcript.appendChild(el);
  scrollToBottom();
}

function setComposerBusy(busy) {
  store.busy = busy;
  app.querySelectorAll('.choice').forEach((b) => (b.disabled = busy));
  const input = document.getElementById('free-action');
  if (input) input.disabled = busy;
  const btn = app.querySelector('[data-act="submit-free"]');
  if (btn) btn.disabled = busy;
}

const histKey = () => `loria:hist:${store.game?.id || 'new'}`;

function readHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(histKey()) || '[]');
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 25) : [];
  } catch {
    return [];
  }
}

function pushHistory(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const list = readHistory().filter((x) => x !== clean);
  list.unshift(clean.slice(0, 500));
  try {
    localStorage.setItem(histKey(), JSON.stringify(list.slice(0, 25)));
  } catch {
    /* приватный режим */
  }
  store.histIndex = null;
}

function recallHistory(input, dir) {
  const list = readHistory();
  if (!list.length) return false;
  const next = store.histIndex == null ? (dir < 0 ? 0 : null) : Math.max(-1, Math.min(list.length - 1, store.histIndex - dir));
  if (next === null) return false;
  store.histIndex = next < 0 ? null : next;
  input.value = store.histIndex == null ? '' : list[store.histIndex];
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

async function submitAction(action) {
  if (store.busy || !action || !store.game) return;
  if (store.game.status === 'dead') return;
  setComposerBusy(true);
  showThinking(action);

  try {
    const res = await fetch(`/api/games/${store.game.id}/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ action, boost: Boolean(store.boostArmed) })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `Ошибка ${res.status}` }));
      throw new Error(err.error || `Ошибка ${res.status}`);
    }
    if (!res.body) throw new Error('Поток недоступен');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        const eventMatch = chunk.match(/^event:\s*(.+)$/m);
        const dataMatch = chunk.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;
        const event = eventMatch?.[1]?.trim();
        let payload;
        try {
          payload = JSON.parse(dataMatch[1]);
        } catch {
          continue;
        }
        if (event === 'phase' && payload.phase === 'check' && payload.roll) {
          flashDice(payload.roll);
        }
        if (event === 'phase' && payload.phase === 'writing') {
          const t = document.getElementById('typing-indicator');
          if (t) t.querySelector('span:last-child').textContent = 'Мастер пишет сцену';
        }
        if (event === 'done') {
          finished = true;
          finishTurn(payload);
        }
        if (event === 'error') {
          finished = true;
          throw new Error(payload.message || 'Мастер не ответил');
        }
      }
    }
    if (!finished) throw new Error('Соединение прервалось до конца сцены');
  } catch (err) {
    document.getElementById('typing-indicator')?.remove();
    toast(err.message || 'Не удалось сделать ход', true);
  } finally {
    setComposerBusy(false);
  }
}

function finishTurn(payload) {
  document.getElementById('typing-indicator')?.remove();
  store.boostArmed = false;
  store.lastAi = payload.demo
    ? { demo: true, error: payload.aiError || '' }
    : payload.ai || null;
  const prevLog = store.game?.log || [];
  store.game = payload.state;
  // Если окно истории сдвинулось, выпавшие ходы не теряем — они ушли в «ранние».
  const known = new Set([...(store.earlier || []), ...(payload.state.log || [])].map((e) => e.turn));
  const dropped = prevLog.filter((e) => !known.has(e.turn));
  if (dropped.length) store.earlier = [...dropped, ...(store.earlier || [])];
  store.earlierFrom = payload.state.logFrom ?? store.earlierFrom;
  store.meta = { ...(store.meta || {}), memoryIndex: payload.memoryIndex };

  const transcript = document.getElementById('transcript');
  if (transcript && payload.turn) {
    transcript.insertAdjacentHTML('beforeend', turnHTML(payload.turn, false, true));
    const more = transcript.querySelector('.transcript__more b');
    if (more && store.earlierFrom) more.textContent = String(store.earlierFrom);
  }
  refreshHeader();
  syncActionButtons();
  updateSheet();
  updateAiMeta();
  renderChoices(payload.state);
  if (payload.demo) {
    toast(
      payload.aiError ? `Мастер не ответил: ${clampText(payload.aiError, 90)}` : 'Модель не ответила — сцену дописал резервный рассказчик.',
      true
    );
  }
  if (payload.turn?.leveled) setTimeout(() => showLevelUp(), 1100);
  if (payload.state.status === 'dead' || payload.state.status === 'finished') {
    const input = document.getElementById('free-action');
    const btn = app.querySelector('[data-act="submit-free"]');
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
  }
  if (payload.state.status === 'dead') setTimeout(() => showDeathOverlay(), 900);
  const arcEvent = payload.turn?.arc;
  if (arcEvent) {
    setTimeout(() => {
      toast(
        arcEvent.complete
          ? `Линия «${arcEvent.title}» пройдена — теперь историю можно закончить.`
          : `Линия «${arcEvent.title}»: шаг ${arcEvent.step} из ${arcEvent.total}.`
      );
    }, 700);
  }
  scrollToBottom();
}

function choiceHTML(o, i) {
  return `<button class="choice" data-act="choice" data-i="${i}"><b>Вариант ${i + 1}</b>${esc(o)}<i class="choice__key" aria-hidden="true">${i + 1}</i></button>`;
}

function renderChoices(s) {
  const choices = document.getElementById('choices');
  if (!choices) return;
  const last = (s.log || []).slice(-1)[0];
  if (s.status === 'dead') {
    choices.innerHTML = `<button class="choice" data-act="death-screen" style="grid-column:1/-1"><b>Финал</b>История завершена. Посмотреть эпитафию.</button>`;
    return;
  }
  if (s.status === 'finished') {
    choices.innerHTML = `<button class="choice choice--finale" data-act="finale-screen" style="grid-column:1/-1"><b>Финал</b>История закончена. Прочитать эпилог.</button>`;
    return;
  }
  const options = (last?.options || []).map((o, i) => choiceHTML(o, i)).join('');
  const finale = s.arc?.complete
    ? `<button class="choice choice--arc" data-act="open-finale" style="grid-column:1/-1"><b>Развязка</b>Линия пройдена до конца. Закончить историю здесь — или идти дальше.</button>`
    : '';
  choices.innerHTML = finale + options;
}

function submitFree() {
  const input = document.getElementById('free-action');
  if (!input) return;
  const value = input.value.trim();
  if (!value) return toast('Опиши действие', true);
  input.value = '';
  pushHistory(value);
  submitAction(value);
}

// ---------- кубик ----------

function flashDice(roll) {
  const verdict = roll.critical ? 'критический успех' : roll.fumble ? 'критический провал' : roll.verdict;
  const box = document.createElement('div');
  box.className = 'dice-overlay';
  box.innerHTML = `<div class="dice-overlay__box">
    <div class="die"><b>${roll.total}</b></div>
    <div class="dice-caption">${esc(roll.stat)} · ${esc(roll.formula)} · сложность ${roll.dc}</div>
    <div class="dice-verdict" style="color:${roll.success ? 'var(--good)' : '#d8867b'}">${esc(verdict)}</div>
  </div>`;
  document.body.appendChild(box);
  setTimeout(() => {
    box.style.transition = 'opacity .35s ease';
    box.style.opacity = '0';
    setTimeout(() => box.remove(), 380);
  }, 1500);
}

// ---------- оверлеи ----------

function showThinkingOverlay(title, text) {
  overlayRoot.innerHTML = `<div class="overlay">
    <div class="overlay__card" style="text-align:center">
      <svg class="loader__mark" viewBox="0 0 100 100" fill="none" style="margin:0 auto 18px"><path d="M50 6 61 41 96 50 61 59 50 94 39 59 4 50 39 41Z" fill="currentColor"/></svg>
      <h2>${esc(title)}</h2>
      <p>${esc(text)}</p>
    </div>
  </div>`;
}

function hideOverlay() {
  overlayRoot.innerHTML = '';
}

// ---------- панель «Мастер» ----------

function aiRowsHTML(d) {
  const rows = [
    ['Ключ', d.present ? `${d.masked || ''}${d.valid ? '' : ' — не sk-or-'}` : 'не задан'],
    ['Источник', d.savedWithApp ? 'введён в приложении' : d.present ? '.env или переменные окружения' : '—'],
    ['Модель', d.model || '—'],
    ['Режим', d.demo ? 'резервный рассказчик' : d.valid ? 'мастер подключён' : 'без модели'],
    [
      'Последний ответ',
      d.lastSuccess
        ? `${d.lastSuccess.model}${d.lastSuccess.ms ? ` · ${(d.lastSuccess.ms / 1000).toFixed(1)} с` : ''}${
            d.lastSuccess.repaired ? ' · формат починен' : ''
          }`
        : '—'
    ],
    [
      'Кости',
      d.rolls === 'always' ? 'на каждое действие' : d.rolls === 'normal' ? 'на всё, кроме бытового' : 'только на риск'
    ],
    ['Последний сбой', d.lastFailure ? clampText(d.lastFailure.message, 140) : '—']
  ];
  return `<div class="ai-rows">${rows
    .map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join('')}</div>`;
}

function aiResultsHTML(results) {
  if (!results?.length) return '';
  return results
    .map(
      (r) => `<div class="ai-check ${r.ok ? 'is-ok' : 'is-bad'}">
        <b>${r.ok ? '✓' : '✗'} ${esc(r.model)}</b>
        <span>${r.status ? `HTTP ${r.status} · ` : ''}${esc(r.reason)}${r.ms ? ` · ${r.ms} мс` : ''}</span>
      </div>`
    )
    .join('');
}

async function refreshAIPanel() {
  const body = document.getElementById('ai-panel-body');
  if (!body) return;
  try {
    const data = await api('/api/doctor');
    body.innerHTML = aiRowsHTML(data);
    const rolls = document.getElementById('ai-rolls');
    if (rolls && data.rolls) rolls.value = data.rolls;
  } catch (err) {
    body.innerHTML = `<p class="mem-empty">Сервер не ответил: ${esc(err.message)}</p>`;
  }
}

function showAIPanel() {
  overlayRoot.innerHTML = `<div class="overlay" data-act="close-overlay">
    <div class="overlay__card" data-stop="1">
      <div class="eyebrow">Мастер</div>
      <h2>Модель</h2>
      <div id="ai-panel-body"><p class="mem-empty">Смотрю настройки…</p></div>

      <label class="eyebrow" for="ai-model" style="display:block;margin-top:18px">Модель мастера</label>
      <div style="display:flex;gap:8px;align-items:center">
        <select id="ai-model" class="input" style="flex:1;min-width:0" aria-label="Модель мастера">
          <option value="">Загружаю список…</option>
        </select>
        <button class="btn" data-act="ai-model-save" title="Применить модель">Применить</button>
      </div>
      <div class="composer__hint" style="text-align:left;margin-top:6px">
        Сильнее модель — плотнее сцены. Бесплатные помечены ·free: они медленнее и иногда рвут JSON.
      </div>

      <label class="eyebrow" for="ai-rolls" style="display:block;margin-top:18px">Кости</label>
      <select id="ai-rolls" class="input" aria-label="Когда кидать кости">
        <option value="risky">только на риск — рекомендую</option>
        <option value="normal">на всё, кроме бытовых действий</option>
        <option value="always">на каждое действие</option>
      </select>
      <div class="composer__hint" style="text-align:left;margin-top:6px">
        «Только на риск» — обычный разговор, осмотр или дорога идут без кубика.
      </div>

      <label class="eyebrow" for="ai-key" style="display:block;margin-top:18px">Ключ OpenRouter</label>
      <input id="ai-key" class="input" type="password" placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false" />
      <div class="composer__hint" style="text-align:left;margin-top:6px">
        Ключ остаётся на этом компьютере (data/settings.json) и главнее .env.
        Новый ключ: openrouter.ai/keys
      </div>
      <div class="overlay__actions">
        <button class="btn btn--primary" data-act="ai-save">Сохранить и проверить</button>
        <button class="btn" data-act="ai-check">Проверить связь</button>
        <button class="btn btn--ghost" data-act="close-overlay">Закрыть</button>
      </div>
      <div id="ai-panel-log" class="ai-panel__log"></div>
    </div>
  </div>`;
  refreshAIPanel();
  refreshModelList();
  document.getElementById('ai-rolls')?.addEventListener('change', (e) => saveRollPolicy(e.target.value));
}

async function refreshModelList() {
  const select = document.getElementById('ai-model');
  if (!select) return;
  try {
    const data = await api('/api/models');
    const options = data.options || [];
    select.innerHTML = options
      .map(
        (m) =>
          `<option value="${esc(m.id)}" ${m.id === data.current ? 'selected' : ''}>${esc(
            (m.free ? '·free · ' : '') + m.id
          )}</option>`
      )
      .join('');
  } catch (err) {
    select.innerHTML = `<option value="">${esc('Список недоступен: ' + err.message)}</option>`;
  }
}

async function saveRollPolicy(rolls) {
  try {
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify({ rolls }) });
    const label = {
      risky: 'кости только на риск',
      normal: 'кости на всё, кроме бытового',
      always: 'кости на каждое действие'
    }[data.rolls || rolls];
    toast(label || 'Правило сохранено');
    await refreshAIPanel();
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveAIModel() {
  const select = document.getElementById('ai-model');
  const model = (select?.value || '').trim();
  if (!model) return toast('Выбери модель', true);
  const log = document.getElementById('ai-panel-log');
  if (log) log.innerHTML = '<p class="mem-empty">Применяю модель и проверяю ответ…</p>';
  try {
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify({ model }) });
    if (log) log.innerHTML = aiResultsHTML(data.results) || `<p class="mem-empty">${esc(data.reason || '')}</p>`;
    toast(data.ok ? `Модель: ${model}` : 'Модель сохранена, но пока не отвечает', !data.ok);
    try {
      if (store.content) store.content.ai = (await api('/api/content')).ai;
    } catch {
      /* не критично */
    }
    await refreshAIPanel();
    await refreshModelList();
  } catch (err) {
    if (log) log.innerHTML = `<p class="mem-empty">${esc(err.message)}</p>`;
    toast(err.message, true);
  }
}

async function testAI() {
  const log = document.getElementById('ai-panel-log');
  if (log) log.innerHTML = '<p class="mem-empty">Стучусь в OpenRouter… до 20 секунд.</p>';
  try {
    const data = await api('/api/doctor', { method: 'POST' });
    if (log) log.innerHTML = aiResultsHTML(data.results) || `<p class="mem-empty">${esc(data.reason || 'Нет ответа')}</p>`;
    toast(data.ok ? 'Мастер на связи' : `Модель не ответила: ${clampText(data.reason || '', 70)}`, !data.ok);
    await refreshAIPanel();
  } catch (err) {
    if (log) log.innerHTML = `<p class="mem-empty">Не удалось проверить: ${esc(err.message)}</p>`;
  }
}

async function saveAIKey() {
  const input = document.getElementById('ai-key');
  const key = (input?.value || '').trim();
  if (!key) return toast('Вставь ключ OpenRouter', true);
  const log = document.getElementById('ai-panel-log');
  if (log) log.innerHTML = '<p class="mem-empty">Сохраняю и проверяю…</p>';
  try {
    const data = await api('/api/settings', { method: 'POST', body: JSON.stringify({ apiKey: key }) });
    if (input) input.value = '';
    if (log) log.innerHTML = aiResultsHTML(data.results);
    toast(data.ok ? 'Ключ сохранён, мастер на связи' : 'Ключ сохранён, но модель пока не ответила', !data.ok);
    try {
      if (store.content) store.content.ai = (await api('/api/content')).ai;
    } catch {
      /* не критично */
    }
    const head = document.querySelector('.scene-head__inner');
    if (head && store.game) head.innerHTML = headerHTML(store.game);
    await refreshAIPanel();
    await refreshModelList();
  } catch (err) {
    if (log) log.innerHTML = `<p class="mem-empty">${esc(err.message)}</p>`;
    toast(err.message, true);
  }
}

function showHelp() {
  const rows = [
    ['1–6', 'выбрать вариант ответа'],
    ['↑ / ↓', 'прошлые действия в поле ввода'],
    ['Enter', 'отправить действие'],
    ['H', 'лист героя'],
    ['Esc', 'закрыть окно или лист'],
    ['?', 'эта подсказка']
  ];
  overlayRoot.innerHTML = `<div class="overlay" data-act="close-overlay">
    <div class="overlay__card" data-stop="1">
      <div class="eyebrow">Подсказка</div>
      <h2>Как играть</h2>
      <p>Ты описываешь действие — мастер отвечает сценой. Кости кидает сервер и только там, где провал что-то меняет: риск, сопротивление, схватка, обман. Обычные действия просто работают — но мир всё равно может ответить. Смерть необратима, но ход можно отмотать назад.</p>
      <p>У истории есть линия: пять шагов, по которым она идёт. Шаги двигает сервер, когда ты действительно решаешь узел. Пройденная линия открывает финал — им можно закончить историю в любой момент.</p>
      <div class="help-rows">
        ${rows.map(([k, v]) => `<div><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`).join('')}
      </div>
      <div class="overlay__actions">
        <button class="btn btn--primary" data-act="close-overlay">Понятно</button>
        <button class="btn btn--ghost" data-act="rules">Правила мира</button>
      </div>
    </div>
  </div>`;
}

function rulesText() {
  return `Линия и финал:
- У мира пять шагов линии; пройденные видны, будущие закрыты.
- Шаг закрывается за настоящее решение, а не за разговор; два шага подряд не проходят.
- Пройденная линия открывает «Развязку»: мастер пишет эпилог, история завершается.
- После финала ход можно отмотать назад и продолжить — если закончил слишком рано.

Режиссура:
- Сцена заканчивается на новой возможности или новой проблеме, а не на пустом месте.
- Мир живёт сам: NPC преследуют свои цели, даже когда герой ничего не делает.
- Каждый ход сдвигает хотя бы одну линию: задание, отношения, угрозу или долг.

Кости:
- Риск, сопротивление, схватка, обман — серверный бросок, результат нельзя переписать.
- Осмотр, разговор, просьба, дорога, перевязка, ожидание — без броска.
- Правило меняется в панели «Мастер» → «Кости» (риск / всё кроме бытового / каждое действие).

Память:
- Мастер помнит факты, NPC, задания и короткие итоги последних ходов; при долгой игре помнит сжатые сводки.
- Противоречия с закреплёнными фактами ловит аудитор и отмечает в сцене.

Смерть и откат:
- Смерть необратима, но ход можно отмотать назад — история переписывается с того момента.`;
}

function showRules() {
  const s = store.game;
  overlayRoot.innerHTML = `<div class="overlay" data-act="close-overlay">
    <div class="overlay__card" data-stop="1">
      <div class="eyebrow">${esc(s.world.genre)} · ${esc(s.difficulty.name)}</div>
      <h2>${esc(s.world.title)}</h2>
      <p style="font-family:var(--serif);font-size:16px;color:var(--ink)">${esc(s.world.tone)}</p>
      <hr class="rule" />
      <div class="eyebrow" style="margin-bottom:8px">Правила мира</div>
      <p style="white-space:pre-wrap;font-size:13.5px;line-height:1.75">${esc(s.world.rules)}</p>
      <hr class="rule" />
      <div class="eyebrow" style="margin-bottom:8px">Мир</div>
      <p style="font-size:13.5px;line-height:1.75">${esc(s.world.setting)}</p>
      <hr class="rule" />
      <details class="rules-more">
        <summary>Как работает мастер, кости и память</summary>
        <p style="white-space:pre-wrap;font-size:13px;line-height:1.75">${esc(rulesText())}</p>
      </details>
      <div class="overlay__actions">
        <button class="btn" data-act="close-overlay">Закрыть</button>
        <a class="btn btn--ghost" href="/api/games/${esc(s.id)}/export">Скачать хронику</a>
      </div>
    </div>
  </div>`;
}

function showArcPanel() {
  const s = store.game;
  const arc = s?.arc;
  if (!arc) return toast('У этой истории нет сюжетной линии.', true);
  overlayRoot.innerHTML = `<div class="overlay" data-act="close-overlay">
    <div class="overlay__card" data-stop="1">
      <div class="eyebrow">Сюжетная линия · шаг ${arc.step} из ${arc.total}</div>
      <h2>${esc(arc.title)}</h2>
      <ol class="arc-list">
        ${arc.done.map((st) => `<li class="is-done"><span>${esc(st)}</span><i>пройдено</i></li>`).join('')}
        ${arc.current ? `<li class="is-current"><span>${esc(arc.current)}</span><i>сейчас</i></li>` : ''}
        ${Array.from({ length: Math.max(0, arc.left - (arc.current ? 1 : 0)) }, (_, i) => `<li class="is-future"><span>?</span><i>${i === 0 ? 'следующий шаг' : 'дальше'}</i></li>`).join('')}
      </ol>
      <p style="font-size:12.5px;color:var(--muted)">
        Линию двигает сервер — когда ты действительно закрываешь шаг, а не просто разговариваешь.
        ${arc.complete ? 'Все шаги пройдены: историю можно закончить финалом.' : 'Мастер видит, где ты, но не может перескочить шаг.'}
      </p>
      <div class="overlay__actions">
        <button class="btn btn--ghost" data-act="close-overlay">Закрыть</button>
        ${arc.complete && s.status === 'active' ? '<button class="btn btn--primary" data-act="open-finale">Закончить историю</button>' : ''}
      </div>
    </div>
  </div>`;
}

async function openFinale() {
  const s = store.game;
  if (!s) return;
  if (!s.arc?.complete) return toast('Линия ещё не пройдена.', true);
  overlayRoot.innerHTML = `<div class="overlay">
    <div class="overlay__card">
      <div class="eyebrow">Развязка</div>
      <h2>Закончить здесь?</h2>
      <p>Мастер напишет эпилог: что стало с миром после тебя. Это последняя сцена — продолжить историю будет нельзя. Хронику всегда можно скачать.</p>
      <div class="overlay__actions">
        <button class="btn btn--primary" data-act="confirm-finale">Написать финал</button>
        <button class="btn btn--ghost" data-act="close-overlay">Ещё поиграю</button>
      </div>
    </div>
  </div>`;
}

async function runFinale() {
  const s = store.game;
  if (!s) return;
  showThinkingOverlay('Мастер пишет финал', 'Последняя сцена. Обычно это занимает несколько секунд.');
  try {
    const data = await api(`/api/games/${s.id}/finale`, { method: 'POST', body: JSON.stringify({}) });
    store.game = data.state;
    if (data.demo) toast('Модель не ответила — финал дописал резервный рассказчик.', true);
    renderPlay();
    showFinaleOverlay();
  } catch (err) {
    hideOverlay();
    toast(err.message, true);
  }
}

function showFinaleOverlay() {
  const s = store.game;
  const f = s?.finale;
  if (!f) return;
  const arc = s.arc || {};
  overlayRoot.innerHTML = `<div class="overlay" data-act="close-overlay">
    <div class="overlay__card overlay__card--finale" data-stop="1">
      <div class="death-mark death-mark--alive">История окончена</div>
      <h2>${esc(s.hero.name)}</h2>
      <p>${esc(f.epitaph || s.hero.archetype)}</p>
      <div class="epitaph">${nl2p(f.text || 'Мир продолжается без тебя.')}</div>
      <div class="arc-final">Линия «${esc(arc.title)}» — ${arc.total} из ${arc.total}</div>
      <div style="display:flex;gap:16px;margin-top:18px;font-size:12px;color:var(--muted);flex-wrap:wrap">
        <span>Ходов: <b style="color:var(--ink)">${s.logTotal ?? (s.log || []).length}</b></span>
        <span>Уровень: <b style="color:var(--ink)">${s.hero.level}</b></span>
        <span>Проверок: <b style="color:var(--ink)">${s.stats.checks}</b></span>
        <span>Золото: <b style="color:var(--ink)">${s.hero.gold}</b></span>
      </div>
      <div class="overlay__actions">
        <a class="btn btn--primary" href="#/worlds" data-act="close-overlay">Новая история</a>
        <a class="btn" href="/api/games/${esc(s.id)}/export">Скачать хронику</a>
        <button class="btn btn--ghost" data-act="close-overlay">Перечитать</button>
      </div>
    </div>
  </div>`;
}

function showDeathOverlay() {
  const s = store.game;
  if (!s) return;
  const facts = (s.memory?.facts || []).filter((f) => f.pinned).slice(-3);
  const lastNarration = (s.log || []).slice(-1)[0]?.narration || '';
  overlayRoot.innerHTML = `<div class="overlay">
    <div class="overlay__card">
      <div class="death-mark">История окончена</div>
      <h2>${esc(s.hero.name)}</h2>
      <p>${esc(s.hero.archetype)} · ${esc(s.world.title)} · ходов ${s.scene.turn - 1}</p>
      <div class="epitaph">${nl2p(clampText(lastNarration.split(/\n{2,}/).slice(-1)[0] || s.deathReason || 'Мир не запомнил имени.', 420))}</div>
      ${facts.length ? `<div class="eyebrow" style="margin-bottom:6px">Что осталось в памяти мира</div>
        <div class="mem-list">${facts.map((f) => `<div class="mem-item pinned"><span class="meta">ход ${f.turn}</span>${esc(f.text)}</div>`).join('')}</div>` : ''}
      <div style="display:flex;gap:16px;margin-top:18px;font-size:12px;color:var(--muted);flex-wrap:wrap">
        <span>Проверок: <b style="color:var(--ink)">${s.stats.checks}</b></span>
        <span>Успехов: <b style="color:var(--ink)">${s.stats.successes}</b></span>
        <span>Критов: <b style="color:var(--ink)">${s.stats.crits}</b></span>
        <span>Отметок аудитора: <b style="color:var(--ink)">${(s.audit || []).length}</b></span>
      </div>
      <div class="overlay__actions">
        <a class="btn btn--primary" href="#/worlds" data-act="close-overlay">Новая история</a>
        <a class="btn" href="/api/games/${esc(s.id)}/export">Скачать хронику</a>
        <button class="btn btn--ghost" data-act="close-overlay">Остаться здесь</button>
      </div>
    </div>
  </div>`;
}

// ---------- правила ----------

function renderRules() {
  clearInterval(slideTimer);
  setAccent('#c9814a');
  const blocks = [
    {
      n: '01',
      title: 'Кубик кидает сервер',
      text: 'Каждое рискованное действие проходит проверку: d20, 2d6 или d100 — как решил автор мира. Сложность зависит от типа действия, а не от настроения модели. Результат попадает в промпт уже посчитанным, и мастер не может его отменить.'
    },
    {
      n: '02',
      title: 'Мастер не поддакивает',
      text: 'У мира есть тон, правила и собственные интересы. Мастер не решает за тебя, что ты чувствуешь, не выдаёт незаслуженных наград и не смягчает последствий. Если мир суров — он суров и к тебе.'
    },
    {
      n: '03',
      title: 'Валидатор следит за цифрами',
      text: 'Здоровье, энергия, золото, инвентарь, флаги и задания меняются только в допустимых пределах. Попытка выдать себе 500 золота срезается до лимита мира и попадает в журнал аудитора. Смерть объявляется только по состоянию, а не по тексту.'
    },
    {
      n: '04',
      title: 'Память мира',
      text: 'Мастер помнит клятвы, долги, имена и смерти. Незыблемые факты хранятся отдельно от прочей памяти, а прошлые сцены находятся по смыслу. Если история стала длинной — уплотни память, и архив перескажет её самому мастеру.'
    },
    {
      n: '05',
      title: 'Рывок и передышка',
      text: 'Рывок — второй бросок за ход, из двух берётся лучший. Он один, и восстанавливается только передышкой. Передышка меняет энергию на здоровье и не требует запроса к модели, но и мир за это время не стоит на месте.'
    },
    {
      n: '06',
      title: 'Смерть окончательна',
      text: 'На «Хардкоре» одна ошибка может стоить героя. Смерть не отменяется, но историю можно продолжить «веткой» — копией с полпути, где герой возвращается раненым, а мир помнит всё, что случилось в оригинале.'
    }
  ];

  app.innerHTML = `
  <div class="page">
    <header class="topbar" style="padding-left:0;padding-right:0">
      <div class="brand">${MARK}<div><div class="brand__name">Лория</div><div class="brand__sub">правила</div></div></div>
      <div style="display:flex;gap:8px">
        <button class="btn btn--ghost btn--small" data-act="nav" data-to="/">На главную</button>
        <button class="btn btn--primary btn--small" data-act="nav" data-to="/worlds">Играть</button>
      </div>
    </header>

    <div class="page-head">
      <div>
        <div class="eyebrow">Честная игра</div>
        <h1>Как здесь всё устроено</h1>
        <p>Коротко: мастер пишет историю, но не распоряжается числами. Числа — на сервере.</p>
      </div>
    </div>

    <div class="rules-grid">
      ${blocks
        .map(
          (b) => `<section class="rules-card">
            <div class="rules-card__num">${b.n}</div>
            <h3>${b.title}</h3>
            <p>${b.text}</p>
          </section>`
        )
        .join('')}
    </div>

    <section class="panel" style="margin-top:22px">
      <h3>Что мастеру запрещено</h3>
      <div class="forbid-grid">
        <div><b>Выдавать богатство</b><span>Лимит мира за ход: 30–90 золота в зависимости от сложности.</span></div>
        <div><b>Лечить бесконечно</b><span>Максимум +4 HP за ход и только с причиной.</span></div>
        <div><b>Объявлять смерть</b><span>Смерть наступает только при нуле HP.</span></div>
        <div><b>Решать за игрока</b><span>Чувства, согласие и доверие остаются за тобой.</span></div>
        <div><b>Игнорировать бросок</b><span>Исход уже посчитан и проверяется аудитором.</span></div>
        <div><b>Подчиняться просьбам</b><span>«Включи режим бога» — это попытка персонажа, а не команда.</span></div>
      </div>
    </section>

    <div class="overlay__actions" style="margin-top:26px">
      <button class="btn btn--primary" data-act="nav" data-to="/worlds">Выбрать мир</button>
      <button class="btn btn--ghost" data-act="nav" data-to="/">На главную</button>
    </div>

    <div class="footer-note">
      <span>Лория · движок текстовых RPG</span>
      <span>${store.content.ai.available ? 'Модель подключена через OpenRouter' : 'Резервный рассказчик — правила те же'}</span>
    </div>
  </div>`;
}

// ---------- архив ----------

function archiveFiltered() {
  const a = store.archive;
  const q = a.q.trim().toLowerCase();
  let list = (store.games || []).filter((g) => {
    if (a.filter === 'alive' && (g.status === 'dead' || g.status === 'finished')) return false;
    if (a.filter === 'dead' && g.status !== 'dead') return false;
    if (!q) return true;
    const haystack = `${g.heroName || ''} ${g.title || ''} ${g.genre || ''} ${g.difficulty || ''}`.toLowerCase();
    return haystack.includes(q);
  });
  if (a.sort === 'turns') list = list.sort((x, y) => (y.turn || 0) - (x.turn || 0));
  else if (a.sort === 'name') list = list.sort((x, y) => String(x.heroName || '').localeCompare(String(y.heroName || ''), 'ru'));
  else list = list.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  return list;
}

function archiveFilterBtn(value, label) {
  const on = store.archive.filter === value;
  return `<button class="chip archive-filter ${on ? 'is-on' : ''}" data-act="archive-filter" data-v="${value}">${label}</button>`;
}

function archiveCardHTML(g) {
  const dead = g.status === 'dead';
  const finished = g.status === 'finished';
  const turns = Math.max(0, (g.turn || 1) - 1);
  const stateLabel = dead ? 'герой погиб' : finished ? 'история завершена' : 'на паузе';
  return `<article class="archive-card ${dead ? 'is-dead' : ''} ${finished ? 'is-finished' : ''}">
    <div class="archive-card__cover" style="background-image:url('${esc(g.art || '/art/world-ash.jpg')}')">
      <span class="archive-card__state">${stateLabel}</span>
      <span class="archive-card__turns">${turns} ${plural(turns, ['ход', 'хода', 'ходов'])}</span>
    </div>
    <div class="archive-card__body">
      <div class="archive-card__top">
        <div>
          <h3>${esc(g.heroName || 'Безымянный')}</h3>
          <div class="archive-card__world">${esc(g.title || '')}${g.genre ? ` · ${esc(g.genre)}` : ''}</div>
        </div>
        <span class="archive-card__level">ур. ${esc(g.level || 1)}</span>
      </div>
      <div class="archive-card__meta">
        <span>HP ${esc(g.hp ?? '?')}</span>
        ${g.quests ? `<span>заданий: <b>${esc(g.quests)}</b></span>` : ''}
        ${g.difficulty ? `<span>${esc(g.difficulty)}</span>` : ''}
      </div>
      ${g.arcTitle ? `<div class="archive-card__arc">
        <span class="arc-dots">${Array.from({ length: g.arcTotal || 0 }, (_, i) => `<i class="${i < (g.arcStep || 0) ? 'on' : ''}"></i>`).join('')}</span>
        ${esc(g.arcTitle)}
      </div>` : ''}
      <div class="archive-card__foot">
        <span class="archive-card__date">${timeAgo(g.updatedAt)}</span>
        <div class="archive-card__actions">
          <button class="btn btn--small" data-act="open" data-id="${esc(g.id)}">${dead ? 'Открыть' : finished ? 'Финал' : 'Продолжить'}</button>
          ${dead || finished ? `<button class="btn btn--ghost btn--small" data-act="fork" data-id="${esc(g.id)}">Ветка</button>` : ''}
          <a class="btn btn--ghost btn--small" href="/api/games/${esc(g.id)}/export" title="Хроника в Markdown">.md</a>
          <a class="btn btn--ghost btn--small" href="/api/games/${esc(g.id)}/download" title="Скачать сохранение">json</a>
          <button class="btn btn--ghost btn--small btn--danger" data-act="delete" data-id="${esc(g.id)}" title="Удалить">×</button>
        </div>
      </div>
    </div>
  </article>`;
}

function renderArchiveList() {
  const box = document.getElementById('archive-list');
  if (!box) return;
  const list = archiveFiltered();
  const total = store.games.length;
  const dead = store.games.filter((g) => g.status === 'dead').length;
  const turns = store.games.reduce((sum, g) => sum + Math.max(0, (g.turn || 1) - 1), 0);
  const count = document.getElementById('archive-count');
  if (count) {
    count.innerHTML =
      `${total} ${plural(total, ['история', 'истории', 'историй'])} · ` +
      `${turns} ${plural(turns, ['ход', 'хода', 'ходов'])} · ` +
      `${dead} ${plural(dead, ['погибший', 'погибших', 'погибших'])}`;
  }
  if (!total) {
    box.innerHTML = `<div class="archive-empty">
      <h3>Архив пуст</h3>
      <p>Здесь появятся все твои истории: с обложкой мира, уровнем героя и числом ходов.</p>
      <button class="btn btn--primary" data-act="nav" data-to="/worlds">Начать первую</button>
    </div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="archive-empty">
      <h3>Ничего не найдено</h3>
      <p>Попробуй другое имя героя или мира — либо сбрось фильтры.</p>
      <button class="btn" data-act="archive-reset">Сбросить фильтры</button>
    </div>`;
    return;
  }
  box.innerHTML = list.map(archiveCardHTML).join('');
}

function renderArchive() {
  clearInterval(slideTimer);
  setAccent('#c9814a');
  const a = store.archive;
  app.innerHTML = `
  <div class="page">
    <header class="topbar" style="padding-left:0;padding-right:0">
      <div class="brand">${MARK}<div><div class="brand__name">Лория</div><div class="brand__sub">архив</div></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--ghost btn--small" data-act="nav" data-to="/">На главную</button>
      </div>
    </header>
    <div class="page-head">
      <div>
        <div class="eyebrow">Твои истории</div>
        <h1>Архив</h1>
        <p>Каждая история хранится локально. Можно продолжить с того же хода, открыть ветку после смерти или забрать хронику в Markdown.</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--ghost" data-act="import">Загрузить файл</button>
        <button class="btn btn--primary" data-act="nav" data-to="/worlds">Новая история</button>
      </div>
    </div>

    <div class="archive-toolbar">
      <input class="input archive-search" id="archive-q" placeholder="Найти героя, мир или жанр" value="${esc(a.q)}" autocomplete="off" aria-label="Поиск по архиву" />
      <div class="archive-filters" role="group" aria-label="Фильтр историй">
        ${archiveFilterBtn('all', 'Все')}${archiveFilterBtn('alive', 'Живые')}${archiveFilterBtn('dead', 'Погибшие')}
      </div>
      <select class="input archive-sort" id="archive-sort" aria-label="Сортировка">
        <option value="recent">Сначала свежие</option>
        <option value="turns">Больше ходов</option>
        <option value="name">По имени героя</option>
      </select>
    </div>
    <div class="archive-summary" id="archive-count"></div>
    <div class="archive-grid" id="archive-list"></div>
    <input type="file" id="import-file" accept="application/json,.json" hidden />
  </div>`;

  const sort = document.getElementById('archive-sort');
  if (sort) sort.value = a.sort;
  document.getElementById('archive-q')?.addEventListener('input', (e) => {
    store.archive.q = e.target.value;
    renderArchiveList();
  });
  document.getElementById('archive-sort')?.addEventListener('change', (e) => {
    store.archive.sort = e.target.value;
    renderArchiveList();
  });
  const fileInput = document.getElementById('import-file');
  fileInput?.addEventListener('change', (e) => {
    importSave(e.target.files?.[0]);
    e.target.value = '';
  });
  renderArchiveList();
}

// ---------- события ----------

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;

  if (act === 'nav') {
    location.hash = `#${el.dataset.to || '/'}`;
    return;
  }
  if (act === 'open') {
    location.hash = `#/game/${el.dataset.id}`;
    return;
  }
  if (act === 'earlier') {
    await loadEarlier();
    return;
  }
  if (act === 'pick-world') {
    location.hash = `#/create/${el.dataset.id}`;
    return;
  }
  if (act === 'pick-arch') {
    store.draft.archetypeId = el.dataset.id;
    renderBuilder();
    return;
  }
  if (act === 'pick-trait') {
    store.draft.traitId = el.dataset.id;
    renderBuilder();
    return;
  }
  if (act === 'pick-burden') {
    store.draft.burdenId = el.dataset.id;
    renderBuilder();
    return;
  }
  if (act === 'pick-diff') {
    store.draft.difficulty = el.dataset.id;
    renderBuilder();
    return;
  }
  if (act === 'random-name') {
    store.draft.name = NAMES[Math.floor(Math.random() * NAMES.length)];
    renderBuilder();
    return;
  }
  if (act === 'start-game') {
    createGame();
    return;
  }
  if (act === 'choice') {
    const s = store.game;
    const last = (s.log || []).slice(-1)[0];
    const option = last?.options?.[Number(el.dataset.i)];
    if (option) submitAction(option);
    return;
  }
  if (act === 'submit-free') {
    submitFree();
    return;
  }
  if (act === 'toggle-sheet') {
    const sheet = document.getElementById('sheet');
    sheet?.classList.toggle('is-open');
    return;
  }
  if (act === 'tab') {
    store.tab = el.dataset.tab;
    updateSheet();
    const sheet = document.getElementById('sheet');
    if (window.innerWidth <= 1080) sheet?.classList.add('is-open');
    return;
  }
  if (act === 'rules') {
    showRules();
    return;
  }
  if (act === 'audit') {
    await runAuditor();
    return;
  }
  if (act === 'compact') {
    await compactMemory();
    return;
  }
  if (act === 'toggle-boost') {
    const hero = store.game?.hero;
    if (!hero || hero.boosts <= 0) return toast('Рывок израсходован. Нужна передышка.', true);
    store.boostArmed = !store.boostArmed;
    rerenderComposer();
    return;
  }
  if (act === 'rest') {
    await takeRest();
    return;
  }
  if (act === 'rewind') {
    await rewindTurn();
    return;
  }
  if (act === 'levelup') {
    await showLevelUp();
    return;
  }
  if (act === 'level-choice') {
    await pickLevel(el.dataset.id);
    return;
  }
  if (act === 'import') {
    document.getElementById('import-file')?.click();
    return;
  }
  if (act === 'death-screen') {
    showDeathOverlay();
    return;
  }
  if (act === 'arc-panel') {
    showArcPanel();
    return;
  }
  if (act === 'open-finale') {
    openFinale();
    return;
  }
  if (act === 'confirm-finale') {
    runFinale();
    return;
  }
  if (act === 'finale-screen') {
    showFinaleOverlay();
    return;
  }
  if (act === 'close-overlay') {
    hideOverlay();
    return;
  }
  if (act === 'goto-turn') {
    const n = el.dataset.turn;
    if (window.innerWidth <= 1080) document.getElementById('sheet')?.classList.remove('is-open');
    const node = document.querySelector(`.turn[data-turn="${n}"]`);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('turn--flash');
      setTimeout(() => node.classList.remove('turn--flash'), 1600);
    }
    return;
  }
  if (act === 'help') {
    showHelp();
    return;
  }
  if (act === 'to-bottom') {
    scrollToBottom();
    return;
  }
  if (act === 'random-world') {
    const worlds = store.content?.worlds || [];
    if (!worlds.length) return;
    const pick = worlds[Math.floor(Math.random() * worlds.length)];
    location.hash = `#/create/${pick.id}`;
    return;
  }
  if (act === 'ai-model-save') {
    saveAIModel();
    return;
  }
  if (act === 'ai-panel') {
    showAIPanel();
    return;
  }
  if (act === 'ai-check') {
    await testAI();
    return;
  }
  if (act === 'ai-save') {
    await saveAIKey();
    return;
  }
  if (act === 'fork') {
    await forkStory(el.dataset.id);
    return;
  }
  if (act === 'archive-filter') {
    store.archive.filter = el.dataset.v || 'all';
    app.querySelectorAll('[data-act="archive-filter"]').forEach((b) => b.classList.toggle('is-on', b === el));
    renderArchiveList();
    return;
  }
  if (act === 'archive-reset') {
    store.archive = { q: '', filter: 'all', sort: 'recent' };
    renderArchive();
    return;
  }
  if (act === 'delete') {
    if (!confirm('Удалить эту историю без возможности вернуть?')) return;
    await api(`/api/games/${el.dataset.id}`, { method: 'DELETE' });
    store.games = store.games.filter((g) => g.id !== el.dataset.id);
    renderArchive();
    return;
  }
  if (act === 'reload') {
    boot();
  }
});

overlayRoot.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-act]');
  const act = action?.dataset.act;
  if (act === 'confirm-finale') {
    await runFinale();
    return;
  }
  if (act === 'open-finale') {
    openFinale();
    return;
  }
  if (act === 'finale-screen') {
    showFinaleOverlay();
    return;
  }
  if (act === 'arc-panel') {
    showArcPanel();
    return;
  }
  if (act === 'death-screen') {
    showDeathOverlay();
    return;
  }
  if (act === 'level-choice') {
    await pickLevel(action.dataset.id);
    return;
  }
  if (act === 'fork') {
    await forkStory(action.dataset.id);
    return;
  }
  if (act === 'ai-check') {
    await testAI();
    return;
  }
  if (act === 'ai-save') {
    await saveAIKey();
    return;
  }
  // Клик по затемнению закрывает окно, клик по самой карточке — нет.
  if (act === 'close-overlay' && !e.target.closest('[data-stop]')) {
    hideOverlay();
    return;
  }
  if (e.target.classList.contains('overlay')) hideOverlay();
});

/** Досоздаёт/убирает кнопки рывка и отмены после хода, не трогая поле ввода. */
function syncActionButtons() {
  const g = store.game;
  const form = document.querySelector('.free-form');
  if (!g || !form || g.status === 'dead') return;
  const hero = g.hero;

  let boost = form.querySelector('[data-act="toggle-boost"]');
  if (!boost) {
    boost = document.createElement('button');
    boost.className = 'btn btn--boost';
    boost.dataset.act = 'toggle-boost';
    boost.title = 'Второй бросок за ход, берётся лучший';
    boost.innerHTML = '<span>Рывок</span><b></b>';
    form.insertBefore(boost, form.querySelector('[data-act="submit-free"]'));
  }
  boost.classList.toggle('is-spent', hero.boosts <= 0);
  boost.querySelector('b').textContent = `${hero.boosts}/${hero.maxBoosts || 1}`;

  let undo = form.querySelector('[data-act="rewind"]');
  if ((g.rewinds || 0) > 0) {
    if (!undo) {
      undo = document.createElement('button');
      undo.className = 'btn btn--ghost btn--undo';
      undo.dataset.act = 'rewind';
      undo.title = 'Отменить последний ход и вернуться к началу сцены';
      undo.innerHTML = '<span>Отменить</span><b></b>';
      form.insertBefore(undo, form.querySelector('[data-act="submit-free"]'));
    }
    undo.querySelector('b').textContent = g.rewinds;
  } else if (undo) {
    undo.remove();
  }
}

function rerenderComposer() {
  const composer = document.getElementById('composer');
  if (!composer || !store.game) return;
  const hero = store.game.hero;
  const dead = store.game.status === 'dead';
  const boostBtn = composer.querySelector('[data-act="toggle-boost"]');
  if (boostBtn) {
    boostBtn.classList.toggle('is-armed', store.boostArmed);
    boostBtn.classList.toggle('is-spent', hero.boosts <= 0);
    const counter = boostBtn.querySelector('b');
    if (counter) counter.textContent = `${hero.boosts}/${hero.maxBoosts || 1}`;
  }
  const hint = composer.querySelector('.composer__hint');
  if (hint && !dead) {
    hint.innerHTML =
      '<span class="keys-hint">1–3 — варианты · H — лист героя</span>' +
      `${store.boostArmed ? '<b style="color:var(--accent)">Рывок заряжен:</b> при провале сервер перебросит кубик и возьмёт лучший результат.' : 'Бросок делает сервер. Мастер не может его отменить.'}${
        store.content.ai.available ? (store.content.ai.lastFailure ? ' Модель не ответила — сцены пишет резерв.' : '') : ' Резервный режим.'
      }`;
  }
}

async function showLevelUp() {
  if (!store.game) return;
  try {
    const data = await api(`/api/games/${store.game.id}/levels`);
    if (!data.choices?.length) return toast('Улучшать больше нечего: всё на максимуме.', true);
    overlayRoot.innerHTML = `<div class="overlay">
      <div class="overlay__card">
        <div class="eyebrow">Уровень ${data.level} · ${data.xp}/${data.next} опыта</div>
        <h2>Герой выжил</h2>
        <p>Мир не стал добрее — просто ты стал чуть крепче. Это не подарок: это цена, которую он согласился платить за твою настойчивость.</p>
        <div class="level-grid">
          ${data.choices
            .map(
              (c) => `<button class="level-choice" data-act="level-choice" data-id="${esc(c.id)}">
                <b>${esc(c.name)}</b><span>${esc(
                  c.id === 'hp' ? 'Больше держит удар' : c.id === 'energy' ? 'Дольше идёт' : c.id === 'boosts' ? 'Чаще рискует с умом' : 'Проверки этого типа станут надёжнее'
                )}</span>
              </button>`
            )
            .join('')}
        </div>
        <div class="overlay__actions">
          <button class="btn btn--ghost" data-act="close-overlay">Позже</button>
        </div>
      </div>
    </div>`;
  } catch (err) {
    toast(err.message, true);
  }
}

async function pickLevel(id) {
  if (!store.game) return;
  try {
    const res = await api(`/api/games/${store.game.id}/levelup`, { method: 'POST', body: JSON.stringify({ choice: id }) });
    store.game = res.state;
    hideOverlay();
    refreshHeader();
    updateSheet();
    syncActionButtons();
    toast(`Улучшение: ${res.choice}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function rewindTurn() {
  if (!store.game || store.busy) return;
  if (!confirm('Отменить последний ход? Сцена исчезнет, состояние вернётся к её началу.')) return;
  setComposerBusy(true);
  try {
    const res = await api(`/api/games/${store.game.id}/rewind`, { method: 'POST', body: '{}' });
    toast(`Ход ${res.undoneTurn} отменён. Отмен осталось: ${res.remaining}.`);
    await openGame(res.state.id);
  } catch (err) {
    toast(err.message, true);
  } finally {
    setComposerBusy(false);
  }
}

async function takeRest() {
  if (!store.game || store.busy) return;
  setComposerBusy(true);
  try {
    const res = await api(`/api/games/${store.game.id}/rest`, { method: 'POST', body: '{}' });
    store.game = res.state;
    refreshHeader();
    updateSheet();
    syncActionButtons();
    rerenderComposer();
    toast('Передышка: силы частично вернулись, рывок восстановлен.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    setComposerBusy(false);
  }
}

async function compactMemory() {
  if (!store.game || store.busy) return;
  toast('Архивариус перечитывает хронику...');
  try {
    const res = await api(`/api/games/${store.game.id}/compact`, { method: 'POST', body: '{}' });
    store.game = res.state;
    updateSheet();
    toast(res.added ? `Память уплотнена: +${res.added} фактов` : 'Память уже уплотнена.');
  } catch (err) {
    toast(err.message, true);
  }
}

async function importSave(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const res = await api('/api/import', { method: 'POST', body: JSON.stringify(parsed) });
    toast('История загружена.');
    store.games = (await api('/api/games')).games || [];
    location.hash = `#/game/${res.state.id}`;
  } catch (err) {
    toast(err instanceof SyntaxError ? 'Это не JSON-файл сохранения.' : err.message, true);
  }
}

async function forkStory(id) {
  try {
    const res = await api(`/api/games/${id}/fork`, { method: 'POST', body: '{}' });
    hideOverlay();
    toast('Ветка создана: герой возвращается с полпути.');
    location.hash = `#/game/${res.state.id}`;
  } catch (err) {
    toast(err.message, true);
  }
}

async function runAuditor() {
  if (!store.game || store.busy) return;
  toast('Аудитор читает последний ход...');
  try {
    const res = await api(`/api/games/${store.game.id}/audit`, { method: 'POST', body: '{}' });
    store.game = res.state;
    updateSheet();
    toast(res.note || 'Аудитор закончил проверку.');
  } catch (err) {
    toast(err.message, true);
  }
}

function onKey(e) {
  if (store.view !== 'game' || store.busy) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (['1', '2', '3', '4', '5', '6'].includes(e.key)) {
    const btn = app.querySelector(`.choice[data-i="${Number(e.key) - 1}"]`);
    if (btn) btn.click();
  }
  if (e.key === 'Escape') {
    hideOverlay();
    document.getElementById('sheet')?.classList.remove('is-open');
  }
  if (e.key === 'h' || e.key === 'р') {
    document.getElementById('sheet')?.classList.toggle('is-open');
  }
  if (e.key === '?') {
    showHelp();
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();
