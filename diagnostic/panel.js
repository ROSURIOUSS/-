(() => {
  'use strict';
  if (document.getElementById('sandustry-bot-probe')) return;
  const host = document.createElement('div');
  host.id = 'sandustry-bot-probe';
  Object.assign(host.style, { position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647' });
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { color-scheme: dark; } section { width: 310px; padding: 18px; background: #142025;
    color: #edf4ed; border: 1px solid #d8c64d; border-radius: 10px; font: 14px/1.5 system-ui; box-shadow:0 6px 30px #0009; }
    h2 { font-size: 17px; margin: 0 0 10px; } p { margin: 10px 0; }
    button { padding:8px 12px; cursor:pointer; background:#d8c64d; color:#151b1d; border:0; border-radius:5px; }
    small { color:#bac8cb; } [hidden] { display:none; }
  </style><section><h2>Бот-добытчик · тест загрузки</h2>
  <p>Панель загружена внутри окна игры.</p>
  <p>Это только проверка подключения. Добыча, доставка и инвентарь ещё не подключены.</p>
  <small>Панель не читает и не изменяет мир или сохранения.</small>
  <p><button type="button">Свернуть</button></p></section>`;
  const section = root.querySelector('section');
  const toggle = document.createElement('button');
  toggle.textContent = 'Бот · тест'; toggle.hidden = true;
  root.append(toggle);
  root.querySelector('section button').onclick = () => { section.hidden = true; toggle.hidden = false; };
  toggle.onclick = () => { section.hidden = false; toggle.hidden = true; };
  // Keep interactions on the panel from reaching the game's document listeners.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'wheel'])
    host.addEventListener(type, event => event.stopPropagation());
  document.body.append(host);
})();
