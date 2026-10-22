// Клиент OpenRouter: аккуратные повторы, перебор запасных моделей,
// жёсткий таймаут и устойчивый разбор JSON.

function baseUrl() {
  return (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
}

const FREE_FALLBACKS = [
  'deepseek/deepseek-chat-v3-0324:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'google/gemini-2.0-flash-exp:free'
];

const DEFAULT_FALLBACKS = [
  'google/gemini-2.5-flash',
  'google/gemini-2.0-flash-001',
  'anthropic/claude-3.5-haiku',
  'openai/gpt-4o-mini',
  'deepseek/deepseek-chat-v3-0324',
  'qwen/qwen-2.5-72b-instruct',
  'meta-llama/llama-3.3-70b-instruct'
];

let lastFailure = null;

export function aiStatus() {
  return {
    lastFailure,
    lastFailureAt: lastFailure ? lastFailure.at : null
  };
}

export class AIError extends Error {
  constructor(message, { status, retryable = false, detail } = {}) {
    super(message);
    this.name = 'AIError';
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

export function aiConfig() {
  const key = process.env.OPENROUTER_API_KEY || '';
  const primary = process.env.LORIA_MODEL || 'google/gemini-2.5-flash';
  const extra = (process.env.LORIA_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const models = [...new Set([primary, ...extra, ...DEFAULT_FALLBACKS])];
  return { key, models, primary };
}

export function aiAvailable() {
  const { key } = aiConfig();
  return Boolean(key && key.startsWith('sk-or-'));
}

/** Короткая сводка о ключе — для панели «Мастер» и диагностики. */
export function aiKeyInfo() {
  const { key, primary } = aiConfig();
  return {
    present: Boolean(key),
    valid: Boolean(key && key.startsWith('sk-or-')),
    masked: key ? `${key.slice(0, 10)}…${key.slice(-4)}` : '',
    model: primary
  };
}

function netMessage(status, detail) {
  if (status === 401) return 'OpenRouter отклонил ключ (401). Проверь ключ или создай новый.';
  if (status === 402) return 'На ключе нет кредитов (402). Бесплатные модели могут работать — проверь их ниже.';
  if (status === 403) return 'Провайдер закрыл доступ (403). Проверь настройки приватности и бесплатные модели на openrouter.ai.';
  if (status === 404) return 'Модель не найдена (404). Выбери другую в LORIA_MODEL.';
  if (status === 429) return 'Слишком много запросов (429). Подожди минуту.';
  if (status >= 500) return `OpenRouter ответил ошибкой ${status}. Попробуй позже.`;
  return detail || `Ошибка ${status}`;
}

/** Один пробный запрос к модели: нужен кнопке «Проверить связь». */
export async function pingModel(model, { timeoutMs = 18000 } = {}) {
  const { key } = aiConfig();
  const started = Date.now();
  if (!key) return { model, ok: false, status: 0, ms: 0, reason: 'Ключ OpenRouter не задан' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.LORIA_SITE_URL || 'https://loria.local',
        'X-Title': 'Loria'
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Ответь одним словом: работает' }],
        max_tokens: 16
      })
    });
    const raw = await res.text();
    const ms = Date.now() - started;
    if (res.ok) return { model, ok: true, status: res.status, ms, reason: 'Модель ответила' };
    let detail = raw.slice(0, 300);
    try {
      detail = JSON.parse(raw)?.error?.message || detail;
    } catch {
      /* оставляем текст как есть */
    }
    return { model, ok: false, status: res.status, ms, reason: netMessage(res.status, detail), detail };
  } catch (err) {
    const ms = Date.now() - started;
    const timeout = err?.name === 'AbortError';
    return {
      model,
      ok: false,
      status: timeout ? 408 : 0,
      ms,
      reason: timeout ? `Модель не ответила за ${Math.round(timeoutMs / 1000)} с` : 'Нет связи с OpenRouter: проверь интернет или VPN.',
      detail: err?.message
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Живая проверка: основная модель, при отказе — бесплатная.
 * Не трогает сохранения и лимиты игр.
 */
export async function aiDoctorCheck({ timeoutMs = 18000 } = {}) {
  const info = aiKeyInfo();
  if (!info.present) {
    return { ok: false, ...info, checkedAt: Date.now(), results: [], reason: 'Ключ OpenRouter не задан' };
  }
  const { models } = aiConfig();
  const primary = models[0];
  const results = [await pingModel(primary, { timeoutMs })];
  const needsFallback = !results[0].ok && [402, 403, 404].includes(results[0].status);
  if (needsFallback) {
    const free = FREE_FALLBACKS.find((m) => m !== primary);
    if (free) results.push(await pingModel(free, { timeoutMs }));
  }
  const ok = results.some((r) => r.ok);
  return {
    ok,
    ...info,
    checkedAt: Date.now(),
    results,
    reason: ok ? 'Мастер на связи' : results[0]?.reason || 'Модель не ответила'
  };
}

function tryParseJson(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* ищем первый сбалансированный объект */
  }
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function callModel({ model, system, user, temperature = 0.95, maxTokens = 1200, signal, jsonMode = true }) {
  const { key } = aiConfig();
  if (!key) throw new AIError('Ключ OpenRouter не задан', { status: 0 });

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.LORIA_SITE_URL || 'https://loria.local',
      'X-Title': 'Loria Web'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    })
  });

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 400);
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || detail;
    } catch {
      /* оставляем как есть */
    }
    const retryable = res.status === 429 || res.status >= 500 || res.status === 408;
    const modelMissing = res.status === 404 || /no endpoints found|not a valid model/i.test(detail);
    throw new AIError(
      res.status === 401
        ? 'OpenRouter отклонил ключ (401). Проверь OPENROUTER_API_KEY.'
        : res.status === 402
          ? 'На ключе OpenRouter закончились кредиты (402).'
          : res.status === 429
            ? 'OpenRouter просит подождать: лимит запросов (429).'
            : `Модель ${model} ответила ошибкой ${res.status}.`,
      { status: res.status, retryable: retryable || modelMissing, detail, modelMissing }
    );
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AIError('OpenRouter вернул не-JSON ответ', { status: res.status, retryable: true, detail: raw.slice(0, 300) });
  }

  if (json?.error) {
    throw new AIError(json.error.message || 'Ошибка провайдера модели', {
      status: 502,
      retryable: true,
      detail: JSON.stringify(json.error).slice(0, 400)
    });
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new AIError('Пустой ответ модели', { status: 502, retryable: true });

  return {
    data: tryParseJson(content),
    raw: content,
    usage: json?.usage || null,
    model: json?.model || model
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let catalogCache = { at: 0, ids: null };

const PREFERRED_FAMILIES = [
  'google/gemini-2.5-flash',
  'google/gemini-2.0-flash-001',
  'google/gemini-flash-1.5',
  'anthropic/claude-3.5-haiku',
  'anthropic/claude-3.7-sonnet',
  'openai/gpt-4o-mini',
  'openai/gpt-4.1-mini',
  'deepseek/deepseek-chat',
  'qwen/qwen-2.5-72b-instruct',
  'meta-llama/llama-3.3-70b-instruct',
  'mistralai/mistral-small-latest'
];

/** Каталог моделей OpenRouter — чтобы не застрять на устаревшем имени модели. */
async function catalog() {
  if (catalogCache.ids && Date.now() - catalogCache.at < 10 * 60 * 1000) return catalogCache.ids;
  const { key } = aiConfig();
  if (!key) return [];
  try {
    const res = await fetch(`${baseUrl()}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const ids = (data?.data || []).map((m) => m.id);
    catalogCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return [];
  }
}

/** Бесплатные модели, которые сейчас реально есть в каталоге OpenRouter. */
async function freeFromCatalog() {
  const ids = await catalog();
  const free = ids.filter((id) => id.endsWith(':free'));
  const preferred = ['deepseek', 'qwen', 'llama', 'gemini', 'mistral'];
  return free.sort((a, b) => {
    const rank = (id) => {
      const i = preferred.findIndex((p) => id.includes(p));
      return i === -1 ? preferred.length : i;
    };
    return rank(a) - rank(b);
  });
}

/** Список моделей: сначала настроенная, затем доступные из каталога, затем статические запасные. */
export async function modelPlan() {
  const { models } = aiConfig();
  const ids = await catalog();
  if (!ids.length) return models;
  const available = new Set(ids);
  const fromPreferred = PREFERRED_FAMILIES.filter((m) => available.has(m));
  const configured = models.filter((m) => available.has(m));
  const ordered = [...new Set([models[0], ...configured, ...fromPreferred, ...models])].filter(Boolean);
  const usable = ordered.filter((m) => available.has(m) || m === models[0]);
  return usable.length ? usable : models;
}

/**
 * Запрос к модели с перебором моделей.
 * Пытается: основная модель, затем запасные; между попытками — пауза.
 */
export async function askJson({
  system,
  user,
  temperature = 0.95,
  maxTokens = 1200,
  timeoutMs = 75000,
  budgetMs = 70000
}) {
  if (!aiAvailable()) throw new AIError('ИИ недоступен: ключ не задан', { status: 0 });
  // Общий бюджет: игрок не должен ждать десять минут, пока перебираются модели.
  const deadline = Date.now() + budgetMs;
  const planned = await modelPlan();
  const queue = planned.slice(0, 4);
  const attempted = [];
  let lastError = null;
  let triedFree = false;
  let index = 0;

  while (index < queue.length) {
    const model = queue[index];
    let jsonMode = true;

    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 2500) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
      try {
        const result = await callModel({
          model,
          system,
          user,
          temperature,
          maxTokens,
          signal: controller.signal,
          jsonMode
        });
        if (!result.data) {
          throw new AIError('Модель вернула невалидный JSON', { status: 502, retryable: true, detail: result.raw.slice(0, 300) });
        }
        lastFailure = null;
        return { ...result, attempts: attempted.concat([{ model, attempt: attempt + 1, ok: true }]) };
      } catch (err) {
        const error =
          err?.name === 'AbortError'
            ? new AIError('Модель не ответила вовремя', { status: 408, retryable: true })
            : err instanceof TypeError
              ? new AIError('Нет связи с OpenRouter: проверь интернет или VPN.', { status: 0, retryable: true, detail: err.message })
              : err;

        attempted.push({ model, attempt: attempt + 1, ok: false, status: error.status, message: error.message });
        lastError = error;

        if (error.status === 401) throw withAttempts(error, attempted);

        // на нулевом балансе ещё можно сыграть на бесплатных моделях
        if (error.status === 402 && !triedFree) {
          triedFree = true;
          // Сначала пробуем бесплатные из живого каталога, потом статический список.
          const live = (await freeFromCatalog()).filter((m) => !queue.includes(m)).slice(0, 3);
          const free = [...live, ...FREE_FALLBACKS.filter((m) => !queue.includes(m) && !live.includes(m))];
          queue.splice(index + 1, 0, ...free);
          if (queue.length > 8) queue.length = 8;
          break;
        }
        if (error.status === 402) throw withAttempts(error, attempted);

        // провайдер может не поддерживать JSON-режим — повторяем ту же модель без него
        if (jsonMode && (error.status === 400 || error.status === 422)) {
          jsonMode = false;
          await sleep(200);
          continue;
        }

        const nextModel = error.modelMissing || error.status === 400 || error.status === 404;
        if (nextModel) break;
        if (attempt === 0) await sleep(500 + Math.floor(Math.random() * 400));
      } finally {
        clearTimeout(timer);
      }
    }
    index += 1;
  }

  const failure = withAttempts(lastError || new AIError('Не удалось получить ответ модели', { status: 502 }), attempted);
  lastFailure = { message: failure.message, status: failure.status, at: Date.now() };
  throw failure;
}

function withAttempts(error, attempts) {
  error.attempts = attempts;
  return error;
}

export { tryParseJson };
