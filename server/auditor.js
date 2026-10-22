// Аудитор правил: локальные проверки без затрат + опциональная вторая модель.
import { askJson } from './ai.js';
import { buildAuditPrompt } from './prompts.js';

const DEATH_RE = /(ты (умираешь|мёртв|мертв|погиб)|твоя смерть|последний вдох|ты больше не дышишь)/i;
const GOLD_RE = /(получаешь|находишь|берёшь|забираешь)[^.!?]{0,40}(золот|монет|кредит|тал)/i;
const FORCE_RE = /(ты соглашаешься|ты решаешь довериться|тебе становится стыдно|ты чувствуешь гордость)/i;
const CLAIM_SUCCESS_RE = /(ты успешно|у тебя получается|без труда|легко добиваешься|всё выходит)/i;
const CLAIM_FAIL_RE = /(ничего не выходит|ты терпишь неудачу|тебя ждёт провал|попытка с треском)/i;

const WORDS = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

/** Быстрая проверка прямо по тексту хода и итоговому состоянию. */
export function localAudit(state, turn, plan, { skipStyle = false } = {}) {
  const issues = [];
  const text = turn.narration || '';

  if (state.hero.hp > 0 && DEATH_RE.test(text)) {
    issues.push({ kind: 'смерть', severity: 'hard', message: 'Повествование убивает героя, хотя по состоянию он жив. Смерть отклонена.' });
  }
  if (GOLD_RE.test(text) && !(Number(plan?.deltas?.gold) > 0)) {
    issues.push({ kind: 'экономика', severity: 'soft', message: 'В тексте герой что-то получает, но золото не изменилось.' });
  }
  if (turn.check && !turn.check.success && CLAIM_SUCCESS_RE.test(text)) {
    issues.push({ kind: 'бросок', severity: 'soft', message: 'Текст описывает успех, хотя бросок провален.' });
  }
  if (turn.check?.success && CLAIM_FAIL_RE.test(text)) {
    issues.push({ kind: 'бросок', severity: 'soft', message: 'Текст описывает провал, хотя бросок успешен.' });
  }
  if (FORCE_RE.test(text)) {
    issues.push({ kind: 'агентность', severity: 'soft', message: 'Мастер решил за игрока, что тот чувствует или выбирает.' });
  }
  if (!skipStyle && WORDS(text) < 45) {
    issues.push({ kind: 'стиль', severity: 'soft', message: 'Сцена слишком короткая: меньше 45 слов.' });
  }
  if (!skipStyle && Array.isArray(plan?.options) && plan.options.length !== 3) {
    issues.push({ kind: 'формат', severity: 'soft', message: `Вариантов действия ${plan.options.length}, ожидалось 3.` });
  }
  return issues;
}

/** Вторая модель проверяет соблюдение правил мира (дороже, поэтому по кнопке). */
export async function aiAudit(state, turn) {
  const { data, usage, model } = await askJson({
    system:
      'Ты — строгий аудитор настольных RPG. Ты не хвалишь и не переписываешь текст. Ты находишь нарушения правил мира и экономики. Отвечай только JSON.',
    user: buildAuditPrompt(state, turn),
    temperature: 0.2,
    maxTokens: 500,
    timeoutMs: 45000
  });
  return { data, usage, model };
}

export function auditSummary(state) {
  const items = state.audit || [];
  const hard = items.filter((a) => a.severity === 'hard').length;
  return { total: items.length, hard, last: items.slice(-1)[0]?.message || '' };
}
