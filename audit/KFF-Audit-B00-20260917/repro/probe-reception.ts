/**
 * B00 independent verification probe — AI Reception opt-out / refusal / output-filter rules.
 *
 * Loads the REAL module from the frozen checkout at 752042bc. It does not copy or re-implement
 * any rule: if the rule changes in the repo, this probe's answers change with it.
 *
 * READ-ONLY. No database, no network, no browser, no model call.
 * Run:  node_modules\.bin\tsx.cmd --tsconfig <repo>\tsconfig.json <this file>
 */
const REPO = 'C:/Users/17731/Desktop/KFF';

type Decision = { action: string; intent: string; reason?: string; reply?: string; valid_inquiry?: boolean };

const model = (await import(`file:///${REPO}/packages/adapters/src/reception-model.ts`)) as unknown as {
  explicitContactExit: (t: string) => boolean;
  localReceptionRules: { name: string; decide: (c: unknown) => Promise<Decision> };
  enforceReceptionDecision: (raw: unknown, ctx: unknown) => Decision;
};

const policyModule = (await import(`file:///${REPO}/packages/contracts/src/lead.ts`)) as unknown as {
  receptionPolicy: { parse: (v: unknown) => unknown };
};

const { explicitContactExit, localReceptionRules, enforceReceptionDecision } = model;

const context = (text: string) => ({
  history: [{ role: 'user' as const, content: text }],
  policy: policyModule.receptionPolicy.parse({}) as never,
  reply_count: 0,
  referred: false,
  has_whatsapp: true,
});

const good: Decision = {
  action: 'REPLY', intent: 'GREETING', valid_inquiry: false,
  intent_level: 'LOW', confidence: 0.95, reply: 'Hello, how can we help?', reason: 'Greeting', tags: [],
};

type Row = { text: string; exit: boolean; action: string; intent: string; reason: string };

async function classify(text: string): Promise<Row> {
  const exit = explicitContactExit(text);
  const viaRules = await localReceptionRules.decide(context(text));
  const viaEnforce = enforceReceptionDecision(good, context(text));
  // Report the LOCAL_RULES decision (that is the ingestion-side decision path) but also record
  // whether the shared model-output guard would have stopped it.
  return {
    text,
    exit,
    action: viaRules.action,
    intent: viaRules.intent,
    reason: viaRules.reason ?? (viaEnforce.reason ?? ''),
  };
}

// ---- Cases from the task brief, plus the regression guards from the shipped contract test ----
const cases: { group: string; expect: string; items: string[] }[] = [
  {
    group: 'A. English phrases the brief asks about',
    expect: 'explicit refusal must stop contact; a request to CONTINUE must not',
    items: [
      "Don't message me again.",
      "Please don't contact me again.",      // ASCII apostrophe
      "Please don\u2019t contact me again.",  // U+2019 typographic apostrophe (what phones type)
      'No more messages please.',
      "Please don't stop messaging me.",
      'Do not stop texting me.',
      'STOP',
      'When will these problems stop?',
      'Where is the bus stop?',
    ],
  },
  {
    group: 'B. Chinese phrases the brief asks about',
    expect: 'explicit refusal must stop contact; ordinary sentences must not',
    items: [
      '我不想再收到你的消息',
      '别再联系我',
      '不要再给我发消息',
      '不要再给我发广告',
      '我希望不要再发生这种事',
    ],
  },
  {
    group: 'C. Existing regression guards (must NOT regress)',
    expect: 'shipped contract test already asserts these',
    items: [
      '我想了解服务，不要再错过机会。',
      'Please don\u2019t stop.',
      "Please don't stop.",
      'do not stop sending updates',
      'I want to know more, do not stop sending updates',
      'STOP texting me',
      'Can you stop messaging me?',
    ],
  },
];

const rows: Row[] = [];
for (const group of cases) for (const text of group.items) rows.push(await classify(text));

// ---- Output filter cases ----
const filterCases: { group: string; expect: string; items: string[] }[] = [
  {
    group: 'D. Destinations that MUST be filtered (leak = P1/P2)',
    expect: 'action must become HANDOFF',
    items: [
      'Visit 例子.中国',
      'Visit example.com',
      'Visit www.example.com',
      'Call \uFF0B\uFF14\uFF14 \uFF17\uFF17\uFF10\uFF10 \uFF19\uFF10\uFF10\uFF11\uFF12\uFF13', // full-width phone
      'Call +44 7700 900123',
      'Call 07700 900123',
      'Mail sales@example.com',
      'Add wa.me/15550001111',
      'Pay at https://example.test',
      'The price is \u00A348.',
      'It is 48 USD.',
    ],
  },
  {
    group: 'E. Ordinary text that must NOT be filtered (false positive = P2)',
    expect: 'action must stay REPLY and text must survive',
    items: [
      'Your appointment is on 2026-09-17.',
      'We have been open since 1998.',
      'Happy birthday! Is it the 48th?',
      'The package includes 2 items.',
      'Sure, I can help with that.',
      'Version 1.2.3 was released.',
      'I am 34 years old.',
      'That costs 2.5 percent more.',
    ],
  },
];

type FilterRow = { text: string; action: string; reason: string };
const filterRows: FilterRow[] = [];
for (const group of filterCases) {
  for (const reply of group.items) {
    const d = enforceReceptionDecision({ ...good, reply }, context());
    filterRows.push({ text: reply, action: d.action, reason: d.reason ?? '' });
  }
}

// ---- The marketing-refusal question, stated as the product decision it actually is ----
const marketingText = '不要再给我发广告了';
const marketingDecision = await localReceptionRules.decide(context(marketingText));
const marketingFiltered = enforceReceptionDecision(good, context(marketingText));

console.log(JSON.stringify({
  probe: 'reception',
  repo: REPO,
  local_rules_model_name: localReceptionRules.name,
  groups: cases,
  cases: rows,
  filter_groups: filterCases,
  filter_cases: filterRows,
  marketing_refusal: {
    text: marketingText,
    explicit_contact_exit: explicitContactExit(marketingText),
    local_rules_action: marketingDecision.action,
    local_rules_intent: marketingDecision.intent,
    local_rules_reason: marketingDecision.reason,
    enforce_action_on_model_reply: marketingFiltered.action,
    note: 'explicitContactExit=false only means "not a global opt-out". The question is whether the product routes it to a human.',
  },
}, null, 2));
