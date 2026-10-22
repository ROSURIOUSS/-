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
  boostArmed: false
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
        <span class="chip">${store.content.worlds.length} мира</span>
        <span class="chip ${aiState().tone}"><span class="dot"></span>${aiState().label}</span>
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
          ${lastGame ? `<button class="btn" data-act="open" data-id="${esc(lastGame.id)}">${lastGame.status === 'dead' ? 'Открыть хронику' : 'Продолжить'}: ${esc(clampText(lastGame.heroName, 18))}</button>` : ''}
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
          Ходов: ${lastGame.turn - 1} · HP ${esc(lastGame.hp)} · ${lastGame.status === 'dead' ? 'история окончена' : 'на паузе'}</p>
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
      <div class="chip">${store.content.worlds.length} готовых миров + свой</div>
    </div>

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
    localStorage.setItem('loria:last', res.state.id);
    if (res.demo) toast('Модель не ответила — начал резервный рассказчик. Игра продолжится.');
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
  return `<article class="turn" data-turn="${entry.turn}" ${isNew ? 'data-new="1"' : ''}>
    <div class="turn__action"><b>Ход ${entry.turn}</b><span>${esc(entry.action)}</span></div>
    ${entry.check ? checkCard(entry.check) : ''}
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
      </div>
    </div>
    <div class="scene-head__actions">
      <button class="btn btn--ghost btn--small sheet-toggle" data-act="toggle-sheet" aria-label="Открыть лист героя">Лист героя</button>
      <button class="btn btn--ghost btn--small" data-act="rules" aria-label="Правила мира">Правила</button>
      <a class="btn btn--ghost btn--small" href="/api/games/${esc(s.id)}/export">Хроника</a>
      <button class="btn btn--ghost btn--small" data-act="nav" data-to="/">Выход</button>
    </div>`;
}

function renderPlay(data) {
  const s = store.game;
  const log = s.log || [];
  const last = log[log.length - 1];
  const hero = s.hero;
  const dead = s.status === 'dead';

  app.innerHTML = `
  <div class="game">
    <header class="scene-head">
      <div class="scene-head__img" style="background-image:url('${esc(s.world.art)}')"></div>
      <div class="scene-head__inner">${headerHTML(s)}</div>
    </header>

    <div class="play-grid">
      <section class="transcript" id="transcript" aria-live="polite" aria-label="История">
        ${recapHTML(data.chronicle || [], s)}
        ${log.map((entry, i) => turnHTML(entry, i === 0, i === log.length - 1 && log.length > 1)).join('')}
      </section>

      <aside class="sheet-col" id="sheet">
        ${sheetHTML()}
      </aside>
    </div>

    <footer class="composer" id="composer">
      <div class="composer__inner">
        <div class="choices" id="choices">
          ${
            dead
              ? `<button class="choice" data-act="death-screen" style="grid-column:1/-1"><b>Финал</b>История завершена. Посмотреть эпитафию.</button>`
              : (last?.options || [])
                  .map((o, i) => `<button class="choice" data-act="choice" data-i="${i}"><b>Вариант ${i + 1}</b>${esc(o)}</button>`)
                  .join('')
          }
        </div>
        <div class="free-form">
          <input class="input" id="free-action" maxlength="600" placeholder="${dead ? 'История окончена' : 'Или напиши своё действие...'}" ${dead ? 'disabled' : ''} />
          ${dead ? '' : `<button class="btn btn--boost ${hero.boosts > 0 ? '' : 'is-spent'}" data-act="toggle-boost" title="Второй бросок за ход, берётся лучший">
            <span>Рывок</span><b>${hero.boosts}/${hero.maxBoosts || 1}</b>
          </button>`}
          ${!dead && s.rewinds > 0 ? `<button class="btn btn--ghost btn--undo" data-act="rewind" title="Отменить последний ход и вернуться к началу сцены">
            <span>Отменить</span><b>${s.rewinds}</b>
          </button>` : ''}
          <button class="btn btn--primary" data-act="submit-free" ${dead ? 'disabled' : ''}><span>Действовать</span>↵</button>
        </div>
        <div class="composer__hint">
          <span class="keys-hint">1–3 — варианты · H — лист героя</span>
          ${store.boostArmed ? '<b style="color:var(--accent)">Рывок заряжен:</b> при провале сервер перебросит кубик и возьмёт лучший результат.' : 'Бросок делает сервер. Мастер не может его отменить.'}
          ${store.content.ai.available ? (store.content.ai.lastFailure ? ' Модель не ответила — сцены пишет резерв.' : '') : ' Резервный режим.'}
        </div>
      </div>
    </footer>
  </div>`;

  document.getElementById('free-action')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitFree();
    }
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
  const quests = [...mem.quests].reverse();

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
        <button class="tab ${tab === 'quests' ? 'is-active' : ''}" data-act="tab" data-tab="quests">Задания</button>
        <button class="tab ${tab === 'audit' ? 'is-active' : ''}" data-act="tab" data-tab="audit">Аудит</button>
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
          ? `<div class="mem-list">${quests
              .map(
                (q) => `<div class="mem-item ${q.status === 'active' ? 'pinned' : ''}">
                  <span class="meta">${q.status === 'active' ? 'активно' : q.status === 'done' ? 'завершено' : 'провалено'} · ход ${q.openedAt}</span>
                  ${esc(q.title)}${q.note ? `<br><span style="color:var(--muted)">${esc(q.note)}</span>` : ''}</div>`
              )
              .join('') || '<div class="mem-empty">Журнал пуст. Пока.</div>'}</div>`
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
      </div>
    </div>
  `;
}

function updateSheet() {
  const sheet = document.getElementById('sheet');
  if (sheet) sheet.innerHTML = sheetHTML();
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
  store.game = payload.state;
  store.meta = { ...(store.meta || {}), memoryIndex: payload.memoryIndex };

  const transcript = document.getElementById('transcript');
  if (transcript && payload.turn) {
    transcript.insertAdjacentHTML('beforeend', turnHTML(payload.turn, false, true));
  }
  const head = document.querySelector('.scene-head__inner');
  if (head) head.innerHTML = headerHTML(store.game);
  syncActionButtons();
  updateSheet();
  renderChoices(payload.state);
  if (payload.demo) toast('Модель не ответила — сцену дописал резервный рассказчик.');
  if (payload.turn?.leveled) setTimeout(() => showLevelUp(), 1100);
  if (payload.state.status === 'dead') {
    const input = document.getElementById('free-action');
    const btn = app.querySelector('[data-act="submit-free"]');
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
    setTimeout(() => showDeathOverlay(), 900);
  }
  scrollToBottom();
}

function renderChoices(s) {
  const choices = document.getElementById('choices');
  if (!choices) return;
  const last = (s.log || []).slice(-1)[0];
  if (s.status === 'dead') {
    choices.innerHTML = `<button class="choice" data-act="death-screen" style="grid-column:1/-1"><b>Финал</b>История завершена. Посмотреть эпитафию.</button>`;
    return;
  }
  choices.innerHTML = (last?.options || [])
    .map((o, i) => `<button class="choice" data-act="choice" data-i="${i}"><b>Вариант ${i + 1}</b>${esc(o)}</button>`)
    .join('');
}

function submitFree() {
  const input = document.getElementById('free-action');
  if (!input) return;
  const value = input.value.trim();
  if (!value) return toast('Опиши действие', true);
  input.value = '';
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
      <div class="overlay__actions">
        <button class="btn" data-act="close-overlay">Закрыть</button>
        <a class="btn btn--ghost" href="/api/games/${esc(s.id)}/export">Скачать хронику</a>
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

function renderArchive() {
  setAccent('#c9814a');
  app.innerHTML = `
  <div class="page">
    <header class="topbar" style="padding-left:0;padding-right:0">
      <div class="brand">${MARK}<div><div class="brand__name">Лория</div><div class="brand__sub">архив</div></div></div>
      <button class="btn btn--ghost btn--small" data-act="nav" data-to="/">На главную</button>
    </header>
    <div class="page-head">
      <div>
        <div class="eyebrow">Твои истории</div>
        <h1>Архив</h1>
        <p>Каждая история хранится локально на сервере. Можно продолжить или забрать хронику в Markdown.</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn--ghost" data-act="import">Загрузить файл</button>
        <button class="btn btn--primary" data-act="nav" data-to="/worlds">Новая история</button>
      </div>
    </div>
    <input type="file" id="import-file" accept="application/json,.json" hidden />
    <div class="archive-list">
      ${
        store.games.length
          ? store.games
              .map(
                (g) => `<div class="archive-item">
                  <img src="${esc(g.art || '/art/world-ash.jpg')}" alt="" />
                  <div>
                    <h4>${esc(g.heroName)} <span style="color:var(--muted);font-size:13px">· ${esc(g.title)}</span></h4>
                    <p>${esc(g.status === 'dead' ? 'погиб' : 'жив')} · ходов ${g.turn - 1} · HP ${esc(g.hp)} · ${esc(g.difficulty || '')} · ${formatTurnDate(g.updatedAt)}</p>
                  </div>
                  <div class="archive-item__right">
                    <button class="btn btn--small" data-act="open" data-id="${esc(g.id)}">${g.status === 'dead' ? 'Открыть' : 'Продолжить'}</button>
                    ${g.status === 'dead' ? `<button class="btn btn--ghost btn--small" data-act="fork" data-id="${esc(g.id)}">Ветка</button>` : ''}
                    <a class="btn btn--ghost btn--small" href="/api/games/${esc(g.id)}/export">.md</a>
                    <a class="btn btn--ghost btn--small" href="/api/games/${esc(g.id)}/download" title="Скачать сохранение">json</a>
                    <button class="btn btn--ghost btn--small btn--danger" data-act="delete" data-id="${esc(g.id)}">×</button>
                  </div>
                </div>`
              )
              .join('')
          : `<div class="panel"><p style="margin:0;color:var(--muted)">Пока пусто. Первая история начинается на главной.</p></div>`
      }
    </div>
  </div>`;

  const fileInput = document.getElementById('import-file');
  fileInput?.addEventListener('change', (e) => {
    importSave(e.target.files?.[0]);
    e.target.value = '';
  });
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
  if (act === 'close-overlay') {
    hideOverlay();
    return;
  }
  if (act === 'fork') {
    await forkStory(el.dataset.id);
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
  if (action?.dataset.act === 'level-choice') {
    await pickLevel(action.dataset.id);
    return;
  }
  if (action?.dataset.act === 'fork') {
    await forkStory(action.dataset.id);
    return;
  }
  if (action?.dataset.act === 'close-overlay') {
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
  if (['1', '2', '3'].includes(e.key)) {
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
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

boot();
