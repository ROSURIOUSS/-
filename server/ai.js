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
  'google/gemini-2.5-pro',
  'anthropic/claude-sonnet-4',
  'anthropic/claude-3.7-sonnet',
  'openai/gpt-4.1-mini',
  'openai/gpt-4o-mini',
  'google/gemini-2.0-flash-001',
  'deepseek/deepseek-chat-v3-0324',
  'qwen/qwen-2.5-72b-instruct',
  'meta-llama/llama-3.3-70b-instruct'
];

let lastFailure = null;
let lastSuccess = null;

export function aiStatus() {
  return {
    lastFailure,
    lastFailureAt: lastFailure ? lastFailure.at : null,
    lastSuccess,
    lastSuccessAt: lastSuccess ? lastSuccess.at : null
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
 * Список моделей для панели «Мастер»: сильные платные, бесплатные и текущая.
 * Каталог нужен, чтобы не предлагать удалённые модели; без сети — статический список.
 */
export async function modelOptions() {
  const { primary } = aiConfig();
  const ids = await catalog();
  const free = (ids.length ? ids : FREE_FALLBACKS).filter((id) => id.endsWith(':free'));
  const paid = (ids.length ? ids : DEFAULT_FALLBACKS).filter((id) => !id.endsWith(':free'));
  const preferPaid = [
    'google/gemini-2.5-pro',
    'anthropic/claude-sonnet-4',
    'anthropic/claude-3.7-sonnet',
    'openai/gpt-4.1',
    'openai/gpt-4.1-mini',
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini'
  ];
  const rankedPaid = [
    ...preferPaid.filter((id) => ids.length === 0 || ids.includes(id)),
    ...paid.filter((id) => !preferPaid.includes(id))
  ];
  const rankedFree = [
    ...['deepseek', 'qwen', 'llama', 'gemini', 'mistral']
      .map((family) => free.find((id) => id.includes(family) && !/r1|reason/i.test(id)))
      .filter(Boolean),
    ...free
  ];
  const seen = new Set();
  const options = [];
  for (const id of [primary, ...rankedPaid, ...rankedFree]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    options.push({ id, free: id.endsWith(':free'), current: id === primary });
    if (options.length >= 18) break;
  }
  return { current: primary, catalog: ids.length > 0, options };
}

/** Сбросить кэш каталога: после смены ключа список моделей может отличаться. */
export function resetCatalogCache() {
  catalogCache = { at: 0, ids: null };
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
    // Сначала берём бесплатную модель из живого каталога: статический список быстро устаревает.
    const live = (await freeFromCatalog()).filter((m) => m !== primary && !/r1|reason/i.test(m));
    const free = live[0] || FREE_FALLBACKS.find((m) => m !== primary);
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

function stripFences(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json|JSON)?/g, '')
    .replace(/```/g, '')
    .trim();
}

/** Модели иногда оставляют в JSON настоящие переводы строк внутри строк — чиним. */
function escapeControlChars(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inStr = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') continue;
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      if (ch < ' ') continue;
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/** Достраивает оборванный JSON: закрывает строку и открытые скобки. */
function balanceJson(text) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = text;
  if (inStr) out += '"';
  out = out.replace(/[\s,]+$/, '');
  // обрыв на имени поля: {"narration":"…","opti
  out = out.replace(/,\s*"[^"\\]*$/, '');
  if (/:\s*$/.test(out)) out += ' null';
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === '{' ? '}' : ']';
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** Отрезает последний незавершённый элемент объекта и балансирует остаток. */
function dropLastMember(text) {
  let inStr = false;
  let esc = false;
  let lastComma = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === ',') lastComma = i;
  }
  if (lastComma < 0) return null;
  return balanceJson(text.slice(0, lastComma));
}

function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractStringField(text, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"`, 'i');
  const m = re.exec(text);
  if (!m) return '';
  let i = m.index + m[0].length;
  let out = '';
  let esc = false;
  while (i < text.length) {
    const ch = text[i];
    if (esc) {
      out += ch;
      esc = false;
      i += 1;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      esc = true;
      i += 1;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i += 1;
  }
  try {
    return JSON.parse(`"${out}"`);
  } catch {
    return out.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t');
  }
}

function extractStringArray(text, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*\\[`, 'i');
  const m = re.exec(text);
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length);
  const out = [];
  const itemRe = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  let guard = 0;
  while ((match = itemRe.exec(rest)) && guard < 8) {
    guard += 1;
    try {
      out.push(JSON.parse(`"${match[1]}"`));
    } catch {
      out.push(match[1]);
    }
  }
  return out;
}

/**
 * Разбор ответа модели. Прощает markdown-ограждения, обрывы по max_tokens
 * и «сырые» переводы строк; в худшем случае вытаскивает хотя бы прозу.
 * @returns {{data: object|null, mode: 'direct'|'repaired'|'salvaged'|'broken'|'empty'}}
 */
export function parseModelJson(text) {
  const raw = stripFences(text);
  if (!raw) return { data: null, mode: 'empty' };

  const direct = parseLoose(raw);
  if (direct && typeof direct === 'object') return { data: direct, mode: 'direct' };

  const start = raw.indexOf('{');
  if (start === -1) return { data: null, mode: 'broken' };
  const body = escapeControlChars(raw.slice(start, raw.lastIndexOf('}') + 1 || raw.length));

  const balanced = balanceJson(body);
  let parsed = parseLoose(balanced);
  if (parsed && typeof parsed === 'object') return { data: parsed, mode: 'repaired' };

  let trimmed = balanced;
  for (let i = 0; i < 4; i++) {
    trimmed = dropLastMember(trimmed);
    if (!trimmed) break;
    parsed = parseLoose(trimmed);
    if (parsed && typeof parsed === 'object') return { data: parsed, mode: 'repaired' };
  }

  // Совсем плохой JSON: спасаем прозу и варианты, остальное заполнит normalizePlan.
  const narration = extractStringField(body, 'narration');
  if (narration && narration.trim().length >= 60) {
    const deltas = {};
    for (const key of ['hp', 'energy', 'gold', 'tension']) {
      const m2 = new RegExp(`"${key}"\\s*:\\s*(-?\\d{1,3})`).exec(body);
      if (m2) deltas[key] = Number(m2[1]);
    }
    return {
      data: {
        narration,
        options: extractStringArray(body, 'options').slice(0, 3),
        deltas,
        facts: [],
        npcs: [],
        dead: /"dead"\s*:\s*true/.test(body)
      },
      mode: 'salvaged'
    };
  }
  return { data: null, mode: 'broken' };
}

/** Совместимость: старый вызов возвращает только данные. */
function tryParseJson(text) {
  return parseModelJson(text).data;
}

/** Для каких моделей просить меньше «размышлений» — иначе они съедают бюджет ответа. */
function reasoningParams(model) {
  const id = String(model || '').toLowerCase();
  if (/gemini-2\.5|thinking|o3|o4-mini|gpt-5|deepseek-r1|qwen3/.test(id)) {
    return { reasoning: { effort: 'low', exclude: true } };
  }
  return {};
}

async function callModel({ model, system, user, temperature = 0.85, maxTokens = 1800, signal, jsonMode = true }) {
  const { key } = aiConfig();
  if (!key) throw new AIError('Ключ OpenRouter не задан', { status: 0 });
  const started = Date.now();

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
      top_p: 0.92,
      max_tokens: maxTokens,
      ...reasoningParams(model),
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

  const choice = json?.choices?.[0] || {};
  const rawContent = choice?.message?.content;
  const content = Array.isArray(rawContent)
    ? rawContent.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
    : rawContent;
  if (!content) {
    const reason = json?.choices?.[0]?.finish_reason || json?.error?.message || 'без текста';
    throw new AIError(`Модель вернула пустой ответ (${reason})`, { status: 502, retryable: true });
  }

  const parsed = parseModelJson(content);
  return {
    data: parsed.data,
    parseMode: parsed.mode,
    finishReason: choice?.finish_reason || null,
    raw: content,
    usage: json?.usage || null,
    model: json?.model || model,
    latencyMs: Date.now() - started
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
  temperature = 0.85,
  maxTokens = 1800,
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
      // повтор пишем холоднее и чуть длиннее: так реже рвётся JSON и сцена не «плывёт»
      const attemptTemperature = attempt === 0 ? temperature : Math.max(0.45, temperature - 0.3);
      const attemptTokens = attempt === 0 ? maxTokens : Math.min(4096, Math.round(maxTokens * 1.35));
      try {
        const result = await callModel({
          model,
          system,
          user,
          temperature: attemptTemperature,
          maxTokens: attemptTokens,
          signal: controller.signal,
          jsonMode
        });
        if (!result.data) {
          const cut = result.finishReason === 'length';
          throw new AIError(
            cut
              ? 'Модель не уложилась в лимит ответа и оборвала JSON (finish_reason=length).'
              : 'Модель вернула ответ, из которого не удалось собрать сцену.',
            {
              status: 502,
              retryable: true,
              truncated: cut,
              parseMode: result.parseMode,
              detail: result.raw.slice(0, 300)
            }
          );
        }
        lastFailure = null;
        lastSuccess = {
          model: result.model,
          at: Date.now(),
          ms: result.latencyMs,
          repaired: result.parseMode !== 'direct',
          finishReason: result.finishReason
        };
        return {
          ...result,
          degraded: result.parseMode === 'salvaged',
          attempts: attempted.concat([
            { model, attempt: attempt + 1, ok: true, repaired: result.parseMode !== 'direct', ms: result.latencyMs }
          ])
        };
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

        // Обрыв по лимиту токенов — не повод менять модель: повторяем ту же с большим бюджетом.
        if (error.truncated && attempt === 0) {
          await sleep(250);
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
