// Настольный запуск Лории.
//
// Работает в двух режимах:
//   1) обычный Node: `node scripts/launcher.js` — то же, что `npm start`, но с браузером;
//   2) собранный .exe (Node SEA): статика распаковывается из самого файла,
//      сохранения лежат рядом с .exe (или в AppData, если папка только для чтения).
//
// Внутри exe нет Node и npm: один файл, двойной клик — игра открылась в браузере.

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

const exeDir = IS_SEA ? path.dirname(process.execPath) : path.resolve(process.cwd());
const appDataRoot = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const storeRoot = path.join(appDataRoot, 'Loria');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
const HOME = path.resolve(
  process.env.LORIA_HOME || (IS_SEA ? (portable ? exeDir : storeRoot) : exeDir)
);
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
      return target;
    } catch {
      /* пробуем следующий вариант */
    }
  }
  throw new Error('Не удалось распаковать файлы интерфейса');
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

// ---------- браузер ----------

function openBrowser(url) {
  if (NO_OPEN) return;
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
  line('  окно можно свернуть, но не закрывать: закроешь — игра остановится.');
  line('');

  const app = await import('../server/index.js');
  const url = `http://127.0.0.1:${port}`;
  const alive = await waitForServer(url);

  if (alive) {
    if (!NO_OPEN) line('  Открываю браузер…');
    openBrowser(url);
  } else {
    line('  Сервер не ответил. Открой адрес вручную, если он всё-таки поднялся.');
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
  line('  Чтобы остановить — закрой это окно или нажми Ctrl+C.');
  line('');

  let stopping = false;
  const stop = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    line('');
    line('  Останавливаю Лорию…');
    try {
      app?.server?.close();
    } catch {
      /* уже закрыт */
    }
    await sleep(150);
    process.exit(code);
  };

  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));
  process.on('SIGHUP', () => stop(0));
}

main().catch(async (err) => {
  console.error('');
  console.error('  Не удалось запустить Лорию.');
  console.error('  ' + (err?.stack || err?.message || err));
  console.error('');
  if (process.stdin.isTTY) {
    console.error('  Нажми Enter, чтобы закрыть окно.');
    await new Promise((resolve) => process.stdin.once('data', resolve));
  }
  process.exit(1);
});
