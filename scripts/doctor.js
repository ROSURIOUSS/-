// Проверка окружения: ключ, сеть, модели, папка данных, порт.
import fs from 'node:fs';
import net from 'node:net';
import { loadEnv } from '../server/env.js';
loadEnv();

const OK = '\x1b[32m✓\x1b[0m';
const NO = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m!\x1b[0m';

const key = process.env.OPENROUTER_API_KEY || '';
const model = process.env.LORIA_MODEL || 'google/gemini-2.5-flash';

console.log('\n  ЛОРИЯ · диагностика\n');

console.log(`  ${fs.existsSync('.env') ? OK : WARN} файл .env ${fs.existsSync('.env') ? 'найден' : 'не найден (читаются только переменные окружения)'}`);
console.log(`  ${key.startsWith('sk-or-') ? OK : NO} ключ OpenRouter ${key ? `(…${key.slice(-6)})` : 'не задан'}`);
console.log(`  ${fs.existsSync('public/index.html') ? OK : NO} статика public/`);
console.log(`  ${fs.existsSync('data') ? OK : WARN} папка data/ ${fs.existsSync('data') ? '' : '(создастся при первом сохранении)'}`);

if (!key.startsWith('sk-or-')) {
  console.log(`\n  ${WARN} Без ключа приложение запустится в резервном режиме. Играть можно, но сцены будет писать шаблонный рассказчик.\n`);
}

async function checkModels() {
  if (!key.startsWith('sk-or-')) return;
  console.log('\n  Проверяю доступ к OpenRouter...');
  const started = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Ответь одним словом: работает' }],
        max_tokens: 12
      }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (res.ok) {
      console.log(`  ${OK} модель ${model} ответила за ${ms} мс`);
    } else {
      let detail = text.slice(0, 200);
      try {
        detail = JSON.parse(text)?.error?.message || detail;
      } catch {
        /* ignore */
      }
      console.log(`  ${NO} HTTP ${res.status}: ${detail}`);
      if (res.status === 401) console.log('     Ключ отклонён. Создай новый: https://openrouter.ai/keys');
      if (res.status === 402) console.log('     На ключе нет кредитов. Бесплатные модели всё ещё доступны, но их лимиты низкие.');
      if (res.status === 404) console.log('     Такой модели нет. Выбери другую в LORIA_MODEL.');
    }
  } catch (err) {
    console.log(`  ${NO} сеть недоступна: ${err.message}`);
    console.log('     Из этой песочницы запросы к openrouter.ai не проходят — это ограничение окружения,');
    console.log('     а не приложения. На машине с интернетом проверь игру: npm run doctor && npm start');
  }
}

function checkPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

const free = await checkPort(Number(process.env.PORT || 3000));
console.log(`  ${free ? OK : WARN} порт ${process.env.PORT || 3000} ${free ? 'свободен' : 'занят — останови другой процесс или задай PORT в .env'}`);

await checkModels();
console.log('');
