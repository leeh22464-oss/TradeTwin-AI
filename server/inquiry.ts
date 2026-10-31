import type { AnalysisResult, ProductConfig } from '../shared/types.js';

export interface ParsedInquiryChange {
  config: ProductConfig;
  withholdDelivery: boolean;
  summary: string;
  requiresReview?: boolean;
}

type Candidate<T> = { value: T; raw: string; index: number };
type ParameterResult<T> = { value?: T; ambiguous?: boolean; negated?: boolean };

const POWER_VALUE = String.raw`\d+(?:\.\d+)?\s*(?:W(?:att)?s?|瓦)(?![A-Za-z0-9])`;
const IP_VALUE = String.raw`IP\s*\d{2}`;
const DRIVER_VALUE = String.raw`DRV[-_ ]?[A-Za-z0-9]+`;

function normalizeIp(value: string): string {
  return value.toUpperCase().replace(/\s+/g, '');
}

function normalizeDriver(value: string): string {
  return value.toUpperCase().replace(/[_ ]+/g, '-');
}

function normalizePower(value: string): number {
  return Number(value.replace(/\s*(?:W(?:att)?s?|瓦)$/i, '').trim());
}

function candidateValues<T>(text: string, pattern: string, normalize: (value: string) => T): Candidate<T>[] {
  const regex = new RegExp(pattern, 'gi');
  return [...text.matchAll(regex)].map((match) => ({
    value: normalize(match[0]),
    raw: match[0],
    index: match.index ?? 0,
  }));
}

function escapedPattern(pattern: string): string {
  return `(${pattern})`;
}

function allMatches(regex: RegExp, text: string): RegExpMatchArray[] {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  return [...text.matchAll(new RegExp(regex.source, flags))];
}

function negativeBefore(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 22), index);
  return /(?:不需要|不用|不要|不选|不选择|不采用|不考虑|不想要|请勿|别|not\s+need|without|don't(?:\s+need)?|do\s+not|not\s+(?:change|choose|take|select|pick)|never|nicht\s+(?:benötig|nehmen|wählen)|kein(?:e|en)?)/i.test(before);
}

function negativeOption(text: string, index: number): boolean {
  const context = text.slice(Math.max(0, index - 14), Math.min(text.length, index + 2));
  return /(?:不(?:要)?选|不选择|不采用|不要|请勿|别|do\s+not|don't|not\s+(?:choose|take|select|pick)|nicht\s+(?:nehmen|wählen))/i.test(context);
}

function keepsCurrentParameter(text: string): boolean {
  return /(?:keep|retain|maintain)\s+(?:the\s+)?current|保留当前|保持当前|保留现有|保持原有/i.test(text);
}

function pairTarget<T>(
  text: string,
  pattern: string,
  normalize: (value: string) => T,
): ParameterResult<T> {
  const p = escapedPattern(pattern);
  const pairs: Array<{ regex: RegExp; target: 1 | 2 }> = [
    // 24W -> 36W, from 24W to 36W, von 24 Watt auf 36 Watt.
    { regex: new RegExp(`${p}\\s*(?:->|→|to|auf)\\s*${p}`, 'i'), target: 2 },
    { regex: new RegExp(`(?:from|von)\\s*${p}\\s*(?:to|auf)\\s*${p}`, 'i'), target: 2 },
    // 36W instead of 24W, 36 Watt statt 24 Watt.
    { regex: new RegExp(`${p}\\s*(?:instead\\s+of|statt|anstatt)\\s*(?:(?:the\\s+)?(?:current|aktuell(?:en|e)?)\\s*)?${p}`, 'i'), target: 1 },
    // replace 24W with 36W, DRV-A durch DRV-B.
    { regex: new RegExp(`(?:replace|ersetze|ersetzen|用)\\s*${p}\\s*(?:with|durch|mit|为)\\s*${p}`, 'i'), target: 2 },
    // 36W 替换/代替 24W.
    { regex: new RegExp(`${p}\\s*(?:替换|代替)\\s*${p}`, 'i'), target: 1 },
    // 用 36W 替换 24W.
    { regex: new RegExp(`用\\s*${p}\\s*(?:替换|代替)\\s*${p}`, 'i'), target: 1 },
  ];
  const candidates: Array<{ value: T; start: number; end: number }> = [];
  const seen = new Set<string>();
  let negated = false;
  const collect = (regex: RegExp, target: 1 | 2) => {
    for (const match of allMatches(regex, text)) {
      const start = match.index ?? 0;
      if (negativeBefore(text, start)) {
        negated = true;
        continue;
      }
      const raw = match[target];
      if (!raw) continue;
      const end = start + match[0].length;
      const value = normalize(raw);
      const overlapsEquivalent = candidates.some((candidate) => candidate.value === value && start <= candidate.end && end >= candidate.start);
      const key = `${start}:${end}:${raw}`;
      if (!seen.has(key) && !overlapsEquivalent) {
        seen.add(key);
        candidates.push({ value, start, end });
      }
    }
  };
  for (const pair of pairs) collect(pair.regex, pair.target);
  if (pattern === POWER_VALUE) {
    // Compact English shorthand such as "from24to36" omits the unit. It is
    // accepted only inside an explicit from/to direction, never as a bare
    // number elsewhere in the message.
    collect(/(?:from|von)\s*(\d+(?:\.\d+)?)\s*(?:to|auf)\s*(\d+(?:\.\d+)?)/i, 2);
  }
  if (candidates.length > 1) return { ambiguous: true };
  if (candidates.length === 1) return { value: candidates[0].value };
  return negated ? { negated: true } : {};
}

function directTarget<T>(
  text: string,
  pattern: string,
  normalize: (value: string) => T,
): ParameterResult<T> {
  const p = escapedPattern(pattern);
  // Chinese/English/German directive followed by one target value.
  const regexes = [
    new RegExp(`(?:改成|改为|换成|变更为|替换为|切换为|调整为|改到|to|auf)\\s*${p}`, 'i'),
    new RegExp(`(?:change|switch|set|update|change\\s+to)\\s+(?:the\\s+)?(?:power|wattage|ip|protection|driver)\\s*(?:to|as|auf|为)?\\s*${p}`, 'i'),
  ];
  const candidates: Array<{ value: T; start: number; end: number }> = [];
  const seen = new Set<string>();
  let negated = false;
  for (const regex of regexes) {
    for (const match of allMatches(regex, text)) {
      const start = match.index ?? 0;
      if (negativeBefore(text, start)) {
        negated = true;
        continue;
      }
      const raw = match[1];
      if (!raw) continue;
      const end = start + match[0].length;
      const key = `${start}:${end}:${raw}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push({ value: normalize(raw), start, end });
      }
    }
  }
  if (candidates.length > 1) return { ambiguous: true };
  if (candidates.length === 1) return { value: candidates[0].value };
  return negated ? { negated: true } : {};
}

function parseParameter<T>(
  text: string,
  pattern: string,
  normalize: (value: string) => T,
): ParameterResult<T> {
  const candidates = candidateValues(text, pattern, normalize);
  const pair = pairTarget(text, pattern, normalize);
  const direct = directTarget(text, pattern, normalize);
  const directionalValues = [pair.value, direct.value].filter((value): value is T => value !== undefined);
  const conflictingDirection = directionalValues.length > 1 && directionalValues.some((value) => value !== directionalValues[0]);
  const directionalAmbiguous = Boolean(pair.ambiguous || direct.ambiguous || conflictingDirection || (directionalValues.length > 0 && (pair.negated || direct.negated)));
  if (directionalAmbiguous) return { ambiguous: true };
  if (directionalValues.length === 1) return keepsCurrentParameter(text) ? { ambiguous: true } : { value: directionalValues[0] };
  if (pair.negated || direct.negated) return { negated: true };
  if (candidates.length === 0) return {};
  if (candidates.length === 1) {
    if (negativeBefore(text, candidates[0].index)) return { negated: true };
    return { value: candidates[0].value };
  }
  // Several values without an explicit direction are unsafe. In particular,
  // never silently pick the last number in a German/English comparison.
  return { ambiguous: true };
}

function selectedOption(text: string): 'A' | 'B' | undefined {
  const patterns = [
    /(?:选择|选(?:择)?|采用|选用)\s*(?:方案|option)?\s*([AB])\b/gi,
    /(?:take|choose|select|pick|go\s+with|nehmen|wählen|waehlen|entscheiden\s+uns\s+für)\s+(?:option|die\s+option|方案)?\s*([AB])\b/gi,
    /(?:方案|option)\s*([AB])\s*(?:被选|获选|chosen|selected)\b/gi,
  ];
  const matches: Array<{ option: 'A' | 'B'; index: number }> = [];
  for (const regex of patterns) {
    for (const match of text.matchAll(regex)) {
      const option = match[1]?.toUpperCase() as 'A' | 'B' | undefined;
      const index = match.index ?? 0;
      if (option && !negativeOption(text, index)) matches.push({ option, index });
    }
  }
  return matches.sort((a, b) => a.index - b.index).at(-1)?.option;
}

function normalizeMarket(value: string): string {
  const normalized = value.toLocaleLowerCase();
  if (/德国|germany|deutschland|deutsch/.test(normalized)) return 'DE';
  if (/法国|france|french|frankreich|französisch|français/.test(normalized)) return 'FR';
  if (/欧盟|eu|european\s+union/.test(normalized)) return 'EU';
  return value.trim().toUpperCase();
}

function explicitMarket(text: string): { value?: string; ambiguous?: boolean } {
  const matches: Array<{ value: string; index: number; finalTarget: boolean }> = [];
  const pushMatches = (regex: RegExp, finalTarget: boolean) => {
    for (const match of allMatches(regex, text)) {
      const raw = match[1];
      if (raw) matches.push({ value: normalizeMarket(raw), index: match.index ?? 0, finalTarget });
    }
  };
  pushMatches(/(?:目标市场|市场改为|销往|发往|出口到|销售到|目的地)\s*(?:是|为|到|：|:)?\s*(德国|Deutschland|Germany|法国|France|Frankreich|欧盟|EU)/gi, true);
  pushMatches(/(?:ship|deliver|export|sell|send)\s+(?:to|in|for)\s+(Germany|Deutschland|France|Frankreich|EU)/gi, false);
  pushMatches(/(?:target\s+market|market|destination)\s*(?:is|to|:|：|auf|für)\s*(Germany|Deutschland|France|Frankreich|EU)/gi, true);
  pushMatches(/(德国市场|German\s+market|deutscher\s+Markt|法国市场|French\s+market|französischer\s+Markt)/gi, true);
  if (!matches.length) return {};
  matches.sort((a, b) => a.index - b.index);
  const last = matches.at(-1)!;
  if (matches.length > 1 && !last.finalTarget) return { ambiguous: true };
  return { value: last.value };
}

function materialValue(text: string): string | undefined {
  const rejected = /^(?:be\s+)?confirmed\s+(?:later|später)|later|später|tbd|unknown|unconfirmed|待确认|稍后确认|待定|未知|未确认|不详/i;
  const patterns = [
    /(?:材料|材质)\s*(?:改为|变更为|换成|替换为|设置为|是|为|：|:)\s*([^，。；;\n]+)/i,
    /(?:change|switch|replace|use|set)\s+(?:the\s+)?material\s+(?:to|with)\s+([^,.;\n]+)/i,
    /material\s*(?:is|=)\s*([^,.;\n]+)/i,
    /Material(?:ien)?\s*(?:auf|zu|ist|=)\s*([^,.;\n]+)/i,
  ];
  for (const regex of patterns) {
    const match = regex.exec(text);
    if (negativeBefore(text, match?.index ?? 0)) continue;
    const value = match?.[1]?.trim();
    if (value && !rejected.test(value)) return value;
  }
  return undefined;
}

function materialNeedsReview(text: string): boolean {
  return /(?:材料|材质|material|materialien)\s*(?:改为|变更为|换成|替换为|设置为|是|为|：|:|to|with|is|=|auf|zu)\s*(?:unknown|unconfirmed|未知|未确认|不详)/i.test(text);
}

function deliveryWithheld(text: string): boolean {
  return /(?:暂不承诺|不承诺|不要承诺|不要给具体交期|排期确认后|待.*确认|do\s+not\s+commit|without\s+(?:a\s+)?specific\s+delivery|keine\s+feste\s+Lieferzeit)/i.test(text);
}

export function parseInquiryChange(
  message: string,
  current: ProductConfig,
  previous: AnalysisResult | null = null,
): ParsedInquiryChange {
  const text = message.trim();
  let config: ProductConfig = { ...current };
  const notes: string[] = [];
  const option = selectedOption(text);
  let selectedConfig = false;
  if (option) {
    const alternative = previous?.alternatives.find((item) => item.id === option);
    if (alternative) {
      config = { ...alternative.config };
      selectedConfig = true;
      notes.push(`已选择方案 ${option}，将按该方案配置重新推演。`);
    } else {
      notes.push(`识别到方案 ${option}，但当前会话没有可用的方案明细，保留当前配置并需要人工核验。`);
    }
  }

  const power = parseParameter(text, POWER_VALUE, normalizePower);
  const ip = parseParameter(text, IP_VALUE, normalizeIp);
  const driver = parseParameter(text, DRIVER_VALUE, normalizeDriver);
  const material = materialValue(text);
  const materialReview = materialNeedsReview(text);
  const market = explicitMarket(text);
  const changes: string[] = [];
  if (power.value !== undefined) { config.powerW = power.value; changes.push(`功率=${power.value}W`); }
  if (ip.value !== undefined) { config.ip = ip.value; changes.push(`IP=${ip.value}`); }
  if (driver.value !== undefined) { config.driver = driver.value; changes.push(`驱动=${driver.value}`); }
  if (material !== undefined) { config.material = material; changes.push(`材料=${material}`); }
  if (market.value !== undefined) { config.market = market.value; changes.push(`目标市场=${market.value}`); }

  const ambiguous = [power, ip, driver].some((item) => item.ambiguous === true);
  if (ambiguous) notes.push('检测到多个候选参数但未识别到明确替代方向，保留当前配置并建议人工核验。');
  if (market.ambiguous) notes.push('检测到多个目标市场且口径冲突，保留当前市场并建议人工核验。');
  if (materialReview) notes.push('材料被明确改为未知或未确认值，保留当前材料并建议人工核验。');
  if (deliveryWithheld(text)) notes.push('已标记暂不承诺具体交期。');
  const withholdDelivery = deliveryWithheld(text);
  const recognized = selectedConfig || changes.length > 0 || Boolean(option) || withholdDelivery;
  const requiresReview = ambiguous || Boolean(market.ambiguous) || materialReview || (Boolean(option) && !selectedConfig);
  const negatedOnly = [power, ip, driver].some((item) => item.negated === true) && !recognized;
  const summary = notes.length > 0 ? notes.join(' ') : recognized ? '已识别变更，等待确定性规则重新计算。' : negatedOnly ? '检测到否定或说明性文字，未应用配置变更。' : requiresReview ? '未能安全确定客户选择，保留当前配置并建议人工核验。' : '未识别到可应用的配置变更，保留当前配置。';
  return { config, withholdDelivery, summary, ...(requiresReview ? { requiresReview: true } : {}) };
}

export { normalizeDriver, normalizeIp, normalizePower };
