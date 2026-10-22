// Настольный запуск Лории.
//
// Работает в двух режимах:
//   1) обычный Node: `node scripts/launcher.js` — то же, что `npm start`, но с окном;
//   2) собранный .exe (Node SEA): статика и нативное окно распаковываются из самого файла,
//      сохранения лежат рядом с .exe (или в AppData, если папка только для чтения).
//
// Окно: сначала пробуем настоящее окно приложения (WebView2 через @webviewjs/webview),
// если не вышло — Edge/Chrome в режиме --app (окно без вкладок и адресной строки),
// и только в крайнем случае — обычный браузер.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { loadEnv } from '../server/env.js';

// createRequire нужен только ради встроенного node:sea — путь-заглушка подходит.
const requireHere = createRequire(path.join(process.cwd(), 'loria-launcher.js'));
let sea = null;
try {
  sea = requireHere('node:sea'); // есть только в Node 20.6+
} catch {
  /* старый Node — просто работаем как обычный сервер */
}
const IS_SEA = Boolean(sea && typeof sea.isSea === 'function' && sea.isSea());

const cliArgs = new Set(process.argv.slice(IS_SEA ? 1 : 2));
const NO_OPEN = cliArgs.has('--no-open') || process.env.LORIA_NO_OPEN === '1';
const FORCE_WEB = cliArgs.has('--web') || process.env.LORIA_WEB === '1';
const KEEP_CONSOLE = cliArgs.has('--console') || Boolean(process.env.PROMPT);
const HIDDEN = process.env.LORIA_HIDDEN === '1';

const exeDir = IS_SEA ? path.dirname(process.execPath) : path.resolve(process.cwd());
const appDataRoot = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const storeRoot = path.join(appDataRoot, 'Loria');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- скрыть консоль при запуске двойным кликом ----------

if (IS_SEA && process.platform === 'win32' && !HIDDEN && !KEEP_CONSOLE) {
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, LORIA_HIDDEN: '1' }
    });
    child.unref();
    process.exit(0);
  } catch {
    /* не получилось — работаем как есть */
  }
}

function canWrite(dir) {
  const probe = path.join(dir, `.loria-write-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- где живут сохранения ----------

const portable = IS_SEA && canWrite(exeDir);
const HOME = path.resolve(process.env.LORIA_HOME || (IS_SEA ? (portable ? exeDir : storeRoot) : exeDir));
const dataDir = path.resolve(process.env.LORIA_DATA_DIR || path.join(HOME, 'data'));

// .env читаем сначала рядом с exe (и на уровень выше — удобно при сборке из репозитория),
// потом в домашней папке. Уже заданные переменные не перетираются.
loadEnv(path.join(exeDir, '.env'));
loadEnv(path.join(exeDir, '..', '.env'));
if (HOME !== exeDir) loadEnv(path.join(HOME, '.env'));

if (process.env.LORIA_DEBUG) {
  const parentEnv = path.join(exeDir, '..', '.env');
  console.log('[debug] exeDir=%s cwd=%s parent=%s exists=%s key=%s', exeDir, process.cwd(), parentEnv, fs.existsSync(parentEnv), process.env.OPENROUTER_API_KEY ? 'set' : 'empty');
}

// В скрытом режиме консоли нет: пишем лог в файл, чтобы было что смотреть при сбое.
const logFile = HIDDEN ? path.join(HOME, 'loria.log') : null;
if (logFile) {
  try {
    fs.appendFileSync(logFile, `\n--- ${new Date().toISOString()} — запуск ---\n`);
  } catch {
    /* папка только для чтения */
  }
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        fs.appendFileSync(logFile, args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
      } catch {
        /* игнорируем */
      }
      void original;
    };
  }
  process.on('uncaughtException', (err) => {
    try {
      fs.appendFileSync(logFile, '[uncaught] ' + (err?.stack || err) + '\n');
    } catch {
      /* игнорируем */
    }
    process.exit(1);
  });
}

// ---------- встроенная статика ----------

function extractAssets() {
  if (!IS_SEA) return null;
  let manifest;
  try {
    manifest = JSON.parse(sea.getAsset('public.json', 'utf8'));
  } catch (err) {
    throw new Error('В файл не встроена папка public: ' + (err?.message || err));
  }
  const variants = [path.join(storeRoot, 'app', manifest.build), path.join(os.tmpdir(), 'loria-app', manifest.build)];
  for (const target of variants) {
    const index = path.join(target, 'index.html');
    try {
      if (!fs.existsSync(index)) {
        ensureDir(target);
        for (const [name, base64] of Object.entries(manifest.files)) {
          const file = path.join(target, name.replace(/^\/+/, ''));
          ensureDir(path.dirname(file));
          fs.writeFileSync(file, Buffer.from(base64, 'base64'));
        }
        fs.writeFileSync(path.join(target, '.build'), manifest.build);
      }
      writeNativeAddon(target);
      return target;
    } catch {
      /* пробуем следующий вариант */
    }
  }
  throw new Error('Не удалось распаковать файлы интерфейса');
}

// Нативное окно — отдельный .node-модуль: его нельзя загрузить из памяти,
// поэтому кладём рядом с интерфейсом.
function writeNativeAddon(dir) {
  if (process.platform !== 'win32') return null;
  const files = ['webview.node', 'vcruntime140.dll', 'vcruntime140_1.dll'];
  for (const name of files) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) continue;
    try {
      fs.writeFileSync(file, Buffer.from(sea.getAsset(name)));
    } catch {
      if (name === 'webview.node') return null;
    }
  }
  const addon = path.join(dir, 'webview.node');
  if (!fs.existsSync(addon)) return null;
  // libuv грузит .node с LOAD_WITH_ALTERED_SEARCH_PATH (своя папка в приоритете),
  // но PATH не помешает — на случай другой сборки Node.
  process.env.PATH = dir + path.delimiter + (process.env.PATH || '');
  return addon;
}

function writeEnvExample() {
  if (!IS_SEA) return;
  const file = path.join(HOME, '.env.example');
  if (fs.existsSync(file)) return;
  try {
    fs.writeFileSync(
      file,
      [
        '# Скопируй этот файл в .env и впиши свой ключ OpenRouter, чтобы играл живой мастер.',
        '# Без ключа Лория работает в резервном режиме: правила и броски те же.',
        '# Ключ: https://openrouter.ai/keys',
        'OPENROUTER_API_KEY=',
        '',
        '# Модель. Если не ответит — сервер переберёт запасные.',
        'LORIA_MODEL=google/gemini-2.5-flash',
        '# LORIA_MODELS=',
        '',
        '# Демо-режим без ИИ: 1 — включён, 0 — выключен, auto — только если нет ключа',
        '# LORIA_DEMO=auto',
        '',
        '# Лимиты',
        '# LORIA_DAILY_REQUESTS=200',
        '',
        '# Telegram-бот (необязательно)',
        '# TELEGRAM_BOT_TOKEN=',
        ''
      ].join('\n'),
      'utf8'
    );
  } catch {
    /* папка только для чтения — не страшно */
  }
}

// ---------- порт ----------

function canBind(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, process.env.HOST || '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function pickPort(start) {
  for (let port = start; port < start + 20; port += 1) {
    if (await canBind(port)) return port;
  }
  return start;
}

// ---------- окно ----------

let nativeApp = null;
let stopApp = () => process.exit(0);

function findChromium() {
  if (process.platform !== 'win32') return null;
  const roots = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA
  ].filter(Boolean);
  const rels = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
  for (const root of roots) {
    for (const rel of rels) {
      const file = path.join(root, rel);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

// Своё окно: WebView2 внутри процесса, без браузерной обвязки.
async function openNativeWindow(url) {
  if (FORCE_WEB) return false;
  if (IS_SEA && process.platform !== 'win32') return false;
  const addon = process.env.LORIA_WEBVIEW_MODULE || (IS_SEA ? path.join(process.env.LORIA_PUBLIC_DIR || '', 'webview.node') : '');
  if (IS_SEA) {
    if (!addon || !fs.existsSync(addon)) return false;
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon;
  }

  const { Application } = await import('@webviewjs/webview');
  const app = new Application();
  const win = app.createBrowserWindow({ title: 'Лория', width: 1280, height: 860, resizable: true });
  try {
    win.setMinSize(980, 640);
  } catch {
    /* не критично */
  }
  win.createWebview({ url });
  app.on('application-close-requested', () => {
    try {
      app.exit();
    } catch {
      /* уже закрыто */
    }
    stopApp(0);
  });
  app.run({ interval: 16 });
  nativeApp = app;
  return true;
}

// Запасной вариант: Edge или Chrome как отдельное окно приложения.
function openAppBrowser(url) {
  const exe = findChromium();
  if (!exe) return false;
  try {
    const child = spawn(exe, [`--app=${url}`, '--window-size=1280,860', '--no-first-run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const options = { detached: true, stdio: 'ignore', windowsHide: true };
  try {
    let child;
    if (process.platform === 'win32') child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], options);
    else if (process.platform === 'darwin') child = spawn('open', [url], options);
    else child = spawn('xdg-open', [url], options);
    child.on('error', () => {});
    child.unref();
  } catch {
    /* браузер не нашёлся — адрес напечатан выше */
  }
}

async function waitForServer(url, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* сервер ещё поднимается */
    }
    await sleep(200);
  }
  return false;
}

function line(text = '') {
  console.log(text);
}

// В скрытом режиме консоли нет — о сбое сообщаем окном Windows.
function showFatal(text) {
  if (process.platform === 'win32' && HIDDEN) {
    try {
      const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(text)}, 'Лория', 'OK', 'Error')`;
      const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.on('error', () => {});
      child.unref();
      return;
    } catch {
      /* остаётся лог */
    }
  }
  console.error(text);
}

async function main() {
  process.title = 'Лория';
  ensureDir(path.join(dataDir, 'games'));
  writeEnvExample();

  const publicDir = extractAssets();
  if (publicDir) process.env.LORIA_PUBLIC_DIR = publicDir;

  process.env.LORIA_DATA_DIR = dataDir;
  process.env.LORIA_HOME = HOME;
  process.env.HOST = process.env.HOST || '127.0.0.1';

  const port = await pickPort(Number(process.env.PORT || 3000));
  process.env.PORT = String(port);

  try {
    process.chdir(HOME);
  } catch {
    /* остаёмся где были */
  }

  line('');
  line('  ЛОРИЯ — настольный запуск');
  line(`  сохранения: ${dataDir}`);
  line(`  адрес:      http://127.0.0.1:${port}`);
  line('');

  const app = await import('../server/index.js');
  const url = `http://127.0.0.1:${port}`;
  const alive = await waitForServer(url);

  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    line('');
    line('  Останавливаю Лорию…');
    try {
      nativeApp?.exit?.();
    } catch {
      /* уже закрыто */
    }
    try {
      app?.server?.close();
    } catch {
      /* уже закрыт */
    }
    await sleep(150);
    process.exit(code);
  };
  stopApp = stop;

  if (alive) {
    if (!NO_OPEN) {
      let opened = false;
      try {
        opened = await openNativeWindow(url);
      } catch (err) {
        line(`  Окно приложения не открылось (${err?.message || err}) — пробую Edge.`);
      }
      if (!opened && !FORCE_WEB) opened = openAppBrowser(url);
      if (!opened) openBrowser(url);
      line(opened ? '  Окно открыто.' : '  Открой адрес вручную.');
    }
  } else {
    line('  Сервер не ответил. Открой адрес вручную, если он всё-таки поднялся.');
    if (HIDDEN) showFatal(`Сервер не ответил. Открой адрес вручную: ${url}\nЛог: ${logFile}`);
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const bot = await import('../server/telegram.js');
      await bot.startBot();
    } catch (err) {
      line(`  Бот не запустился: ${err?.message || err}`);
    }
  }

  line('');
  line('  Чтобы остановить — закрой окно игры или нажми Ctrl+C.');
  line('');

  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGHUP', () => stop(0));
}

main().catch(async (err) => {
  const text = err?.stack || err?.message || String(err);
  console.error('');
  console.error('  Не удалось запустить Лорию.');
  console.error('  ' + text);
  console.error('');
  if (HIDDEN) {
    showFatal(`Лория не запустилась.\n\n${err?.message || err}\n\nЛог: ${logFile}`);
  } else if (process.stdin.isTTY) {
    console.error('  Нажми Enter, чтобы закрыть окно.');
    await new Promise((resolve) => process.stdin.once('data', resolve));
  }
  process.exit(1);
});
