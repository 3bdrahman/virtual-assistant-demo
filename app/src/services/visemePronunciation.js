export const VISEMES = {
  sil: 'viseme_sil',
  PP: 'viseme_PP',
  FF: 'viseme_FF',
  TH: 'viseme_TH',
  DD: 'viseme_DD',
  kk: 'viseme_kk',
  CH: 'viseme_CH',
  SS: 'viseme_SS',
  nn: 'viseme_nn',
  RR: 'viseme_RR',
  aa: 'viseme_aa',
  E: 'viseme_E',
  I: 'viseme_I',
  O: 'viseme_O',
  U: 'viseme_U',
};

const PHONEME_TO_VISEME = {
  P: VISEMES.PP, B: VISEMES.PP, M: VISEMES.PP,
  F: VISEMES.FF, V: VISEMES.FF,
  TH: VISEMES.TH, DH: VISEMES.TH,
  T: VISEMES.DD, D: VISEMES.DD,
  K: VISEMES.kk, G: VISEMES.kk, NG: VISEMES.kk,
  CH: VISEMES.CH, SH: VISEMES.CH, JH: VISEMES.CH, ZH: VISEMES.CH,
  S: VISEMES.SS, Z: VISEMES.SS,
  N: VISEMES.nn, L: VISEMES.nn,
  R: VISEMES.RR, ER: VISEMES.RR,
  AA: VISEMES.aa, AE: VISEMES.aa, AH: VISEMES.aa, AW: VISEMES.aa,
  EH: VISEMES.E, EY: VISEMES.E,
  IH: VISEMES.I, IY: VISEMES.I, AY: VISEMES.I, Y: VISEMES.I,
  AO: VISEMES.O, OW: VISEMES.O, OY: VISEMES.O,
  UW: VISEMES.U, UH: VISEMES.U, W: VISEMES.U,
};

const PHONEME_WEIGHT = {
  P: 0.55, B: 0.55, M: 0.7,
  T: 0.55, D: 0.55, K: 0.55, G: 0.55,
  CH: 0.9, JH: 0.9, SH: 0.95, ZH: 0.95,
  F: 0.9, V: 0.9, TH: 0.95, DH: 0.95, S: 0.85, Z: 0.85,
  N: 0.9, L: 0.9, R: 1.0, ER: 1.2, NG: 0.9, HH: 0.35,
  AA: 1.6, AE: 1.45, AH: 1.25, AW: 1.6,
  EH: 1.35, EY: 1.55,
  IH: 1.25, IY: 1.45, AY: 1.65, Y: 0.55,
  AO: 1.45, OW: 1.55, OY: 1.6,
  UW: 1.45, UH: 1.25, W: 0.55,
};

const EXCEPTIONS = new Map(Object.entries({
  a: ['AH'],
  ai: ['EY', 'AY'],
  an: ['AE', 'N'],
  and: ['AE', 'N', 'D'],
  are: ['AA', 'R'],
  be: ['B', 'IY'],
  been: ['B', 'IH', 'N'],
  book: ['B', 'UH', 'K'],
  demo: ['D', 'EH', 'M', 'OW'],
  do: ['D', 'UW'],
  does: ['D', 'AH', 'Z'],
  done: ['D', 'AH', 'N'],
  "don't": ['D', 'OW', 'N', 'T'],
  face: ['F', 'EY', 'S'],
  food: ['F', 'UW', 'D'],
  for: ['F', 'AO', 'R'],
  have: ['HH', 'AE', 'V'],
  he: ['HH', 'IY'],
  her: ['HH', 'ER'],
  here: ['HH', 'IY', 'R'],
  i: ['AY'],
  eye: ['AY'],
  "i'm": ['AY', 'M'],
  is: ['IH', 'Z'],
  know: ['N', 'OW'],
  mom: ['M', 'AA', 'M'],
  of: ['AH', 'V'],
  one: ['W', 'AH', 'N'],
  paper: ['P', 'EY', 'P', 'ER'],
  phone: ['F', 'OW', 'N'],
  photo: ['F', 'OW', 'T', 'OW'],
  said: ['S', 'EH', 'D'],
  says: ['S', 'EH', 'Z'],
  she: ['SH', 'IY'],
  shoe: ['SH', 'UW'],
  that: ['DH', 'AE', 'T'],
  the: ['DH', 'AH'],
  their: ['DH', 'EH', 'R'],
  them: ['DH', 'EH', 'M'],
  there: ['DH', 'EH', 'R'],
  these: ['DH', 'IY', 'Z'],
  they: ['DH', 'EY'],
  thin: ['TH', 'IH', 'N'],
  this: ['DH', 'IH', 'S'],
  those: ['DH', 'OW', 'Z'],
  to: ['T', 'UW'],
  was: ['W', 'AH', 'Z'],
  we: ['W', 'IY'],
  were: ['W', 'ER'],
  what: ['W', 'AH', 'T'],
  who: ['HH', 'UW'],
  wrong: ['R', 'AO', 'NG'],
  you: ['Y', 'UW'],
  your: ['Y', 'ER'],
  could: ['K', 'UH', 'D'], would: ['W', 'UH', 'D'], should: ['SH', 'UH', 'D'],
  once: ['W', 'AH', 'N', 'S'], only: ['OW', 'N', 'L', 'IY'],
  how: ['HH', 'AW'], now: ['N', 'AW'], down: ['D', 'AW', 'N'],
  where: ['W', 'EH', 'R'], when: ['W', 'EH', 'N'], why: ['W', 'AY'],
  hello: ['HH', 'EH', 'L', 'OW'], world: ['W', 'ER', 'L', 'D'],
  people: ['P', 'IY', 'P', 'AH', 'L'], water: ['W', 'AO', 'T', 'ER'],
  blue: ['B', 'L', 'UW'], through: ['TH', 'R', 'UW'],
  light: ['L', 'AY', 'T'], night: ['N', 'AY', 'T'], right: ['R', 'AY', 'T'],
  come: ['K', 'AH', 'M'], some: ['S', 'AH', 'M'], love: ['L', 'AH', 'V'],
  give: ['G', 'IH', 'V'], good: ['G', 'UH', 'D'],
  because: ['B', 'IH', 'K', 'AH', 'Z'], speech: ['S', 'P', 'IY', 'CH'],
  assistant: ['AH', 'S', 'IH', 'S', 'T', 'AH', 'N', 'T'],
  eight: ['EY', 'T'], two: ['T', 'UW'], three: ['TH', 'R', 'IY'],
  five: ['F', 'AY', 'V'], zero: ['Z', 'IY', 'R', 'OW'],

}));

const LETTER_NAMES = {
  a: ['EY'], b: ['B', 'IY'], c: ['S', 'IY'], d: ['D', 'IY'], e: ['IY'],
  f: ['EH', 'F'], g: ['JH', 'IY'], h: ['EY', 'CH'], i: ['AY'], j: ['JH', 'EY'],
  k: ['K', 'EY'], l: ['EH', 'L'], m: ['EH', 'M'], n: ['EH', 'N'], o: ['OW'],
  p: ['P', 'IY'], q: ['K', 'Y', 'UW'], r: ['AA', 'R'], s: ['EH', 'S'],
  t: ['T', 'IY'], u: ['Y', 'UW'], v: ['V', 'IY'], w: ['D', 'AH', 'B', 'AH', 'L', 'Y', 'UW'],
  x: ['EH', 'K', 'S'], y: ['W', 'AY'], z: ['Z', 'IY'],
};

const NUMBER_WORDS = {
  0: ['Z', 'IY', 'R', 'OW'],
  1: ['W', 'AH', 'N'],
  2: ['T', 'UW'],
  3: ['TH', 'R', 'IY'],
  4: ['F', 'AO', 'R'],
  5: ['F', 'AY', 'V'],
  6: ['S', 'IH', 'K', 'S'],
  7: ['S', 'EH', 'V', 'AH', 'N'],
  8: ['EY', 'T'],
  9: ['N', 'AY', 'N'],
};

const TOKEN_PATTERN = /\d+(?:,\d{3})*(?:\.\d+)?|[\p{L}]+(?:['’][\p{L}]+)*/gu;

function normalizeWord(word) {
  return String(word || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’]/g, "'")
    .replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '')
    .toLowerCase();
}

function isAcronym(raw, normalized) {
  return /^[A-Z0-9]{2,6}$/.test(String(raw || '').replace(/[^A-Za-z0-9]/g, ''))
    && /[A-Z]/.test(raw)
    && !EXCEPTIONS.has(normalized);
}

const NUMBER_NAMES = {
  10: 'T EH N', 11: 'IH L EH V AH N', 12: 'T W EH L V', 13: 'TH ER T IY N',
  14: 'F AO R T IY N', 15: 'F IH F T IY N', 16: 'S IH K S T IY N',
  17: 'S EH V AH N T IY N', 18: 'EY T IY N', 19: 'N AY N T IY N',
  20: 'T W EH N T IY', 30: 'TH ER T IY', 40: 'F AO R T IY', 50: 'F IH F T IY',
  60: 'S IH K S T IY', 70: 'S EH V AH N T IY', 80: 'EY T IY', 90: 'N AY N T IY',
};

function integerPhones(number) {
  if (number < 10) return NUMBER_WORDS[number];
  if (NUMBER_NAMES[number]) return NUMBER_NAMES[number].split(' ');
  if (number < 100) return [...integerPhones(number - number % 10), ...integerPhones(number % 10)];
  const scale = number < 1000 ? 100 : 1000;
  const suffix = scale === 100 ? ['HH', 'AH', 'N', 'D', 'R', 'AH', 'D'] : ['TH', 'AW', 'Z', 'AH', 'N', 'D'];
  return [...integerPhones(Math.floor(number / scale)), ...suffix, ...(number % scale ? integerPhones(number % scale) : [])];
}

function numberPhones(text) {
  const [whole, decimal] = text.replaceAll(',', '').split('.');
  const phones = whole.length > 6 || (whole.length > 1 && whole.startsWith('0'))
    ? [...whole].flatMap((digit) => NUMBER_WORDS[digit]) : integerPhones(Number(whole));
  return decimal ? [...phones, 'P', 'OY', 'N', 'T', ...[...decimal].flatMap((digit) => NUMBER_WORDS[digit])] : phones;
}

function acronymPhones(text) {
  const phones = [];
  for (const character of String(text).toLowerCase()) {
    if (LETTER_NAMES[character]) phones.push(...LETTER_NAMES[character]);
    else if (NUMBER_WORDS[character]) phones.push(...NUMBER_WORDS[character]);
  }
  return phones;
}

function collapseDoubledLetters(word) {
  return word.replace(/([b-df-hj-np-tv-z])\1+/g, '$1');
}

function rulePhones(rawWord) {
  const normalized = normalizeWord(rawWord);
  if (!normalized) return { phones: /\p{L}/u.test(rawWord) ? Array.from(rawWord, () => 'AH') : [], estimated: true };
  if (EXCEPTIONS.has(normalized)) return { phones: EXCEPTIONS.get(normalized), estimated: false };
  if (/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(normalized)) return { phones: numberPhones(normalized), estimated: true };
  if (isAcronym(rawWord, normalized)) return { phones: acronymPhones(rawWord), estimated: false };

  if (normalized.length > 4 && normalized.endsWith('ed')) {
    const base = rulePhones(normalized.slice(0, -2)).phones;
    const last = base.at(-1);
    const ending = last === 'T' || last === 'D' ? ['IH', 'D']
      : ['P', 'K', 'F', 'S', 'SH', 'CH'].includes(last) ? ['T'] : ['D'];
    return { phones: [...base, ...ending], estimated: true };
  }

  let word = normalized.replace(/'s$/u, 's').replace(/'/g, '');
  if (!/[aeiouy]/.test(word)) {
    const phones = Array.from(word, (character) => LETTER_NAMES[character] || []).flat();
    return { phones: phones.length ? phones : ['AH'], estimated: true };
  }

  word = collapseDoubledLetters(word);
  if (word.startsWith('kn')) word = word.slice(1);
  if (word.startsWith('wr')) word = word.slice(1);
  const longVowel = word.length > 2 && /[aeiou][^aeiou]e$/.test(word) ? word.length - 3 : -1;
  if (longVowel >= 0) word = word.slice(0, -1);

  const phones = [];
  for (let index = 0; index < word.length;) {
    const pair = word.slice(index, index + 2);
    const next = word[index + 1] || '';
    const after = word[index + 2] || '';

    if (word.slice(index, index + 3) === 'igh') { phones.push('AY'); index += 3; continue; }
    if (pair === 'th') { phones.push(commonVoicedTh(word, index) ? 'DH' : 'TH'); index += 2; continue; }
    if (pair === 'sh') { phones.push('SH'); index += 2; continue; }
    if (pair === 'ch') { phones.push('CH'); index += 2; continue; }
    if (pair === 'ph') { phones.push('F'); index += 2; continue; }
    if (pair === 'ck') { phones.push('K'); index += 2; continue; }
    if (pair === 'ng') { phones.push('NG'); index += 2; continue; }
    if (pair === 'qu') { phones.push('K', 'W'); index += 2; continue; }
    if (pair === 'ue') { phones.push('UW'); index += 2; continue; }
    if (pair === 'ee' || pair === 'ea') { phones.push('IY'); index += 2; continue; }
    if (pair === 'oo') { phones.push(bookLikeUh(word) ? 'UH' : 'UW'); index += 2; continue; }
    if (pair === 'ai' || pair === 'ay') { phones.push('EY'); index += 2; continue; }
    if (pair === 'oa' || pair === 'ow') { phones.push('OW'); index += 2; continue; }
    if (pair === 'ou') { phones.push('AW'); index += 2; continue; }
    if (pair === 'oi' || pair === 'oy') { phones.push('OY'); index += 2; continue; }
    if (pair === 'er' || pair === 'ir' || pair === 'ur') { phones.push('ER'); index += 2; continue; }
    if (pair === 'ar') { phones.push('AA', 'R'); index += 2; continue; }
    if (pair === 'or') { phones.push('AO', 'R'); index += 2; continue; }

    const character = word[index];
    if (index === longVowel) phones.push({ a: 'EY', e: 'IY', i: 'AY', o: 'OW', u: 'UW' }[character]);
    else if (character === 'c') phones.push(/[eiy]/.test(next) ? 'S' : 'K');
    else if (character === 'g') phones.push(/[eiy]/.test(next) && after !== 'h' ? 'JH' : 'G');
    else if (character === 'x') phones.push('K', 'S');
    else if (character === 'a') phones.push(next === 'r' ? 'AA' : 'AE');
    else if (character === 'e') phones.push(index === word.length - 1 ? 'IY' : 'EH');
    else if (character === 'y' && index === word.length - 1) phones.push(word.length <= 3 ? 'AY' : 'IY');
    else if (character === 'i' || character === 'y') phones.push('IH');
    else if (character === 'o') phones.push('AA');
    else if (character === 'u') phones.push('AH');
    else if (character === 'h') phones.push('HH');
    else if (character === 'j') phones.push('JH');
    else if (character === 'r') phones.push('R');
    else if (character === 'l') phones.push('L');
    else if (character === 'm') phones.push('M');
    else if (character === 'n') phones.push('N');
    else if (character === 'p') phones.push('P');
    else if (character === 'b') phones.push('B');
    else if (character === 'f') phones.push('F');
    else if (character === 'v') phones.push('V');
    else if (character === 't') phones.push('T');
    else if (character === 'd') phones.push('D');
    else if (character === 'k') phones.push('K');
    else if (character === 's') phones.push('S');
    else if (character === 'w') phones.push('W');
    else if (character === 'z') phones.push('Z');
    else if (LETTER_NAMES[character]) phones.push(...LETTER_NAMES[character]);
    index++;
  }

  return { phones: phones.length ? phones : ['AH'], estimated: true };
}

function commonVoicedTh(word, index) {
  return index === 0 && /^(the|thi[sz]|tha[tn]|tho(se|u)|there|they|them|their)/.test(word);
}

function bookLikeUh(word) {
  return /^(book|cook|look|took|good|wood|foot)$/.test(word);
}

// Vowel glides change shape during one sound rather than spelling two letters.
const GLIDES = { AY: ['AA', 'IY'], AW: ['AA', 'UW'], OY: ['AO', 'IY'], EY: ['EH', 'IY'], OW: ['AO', 'UW'] };

function makeWordUnits(rawWord, charStart = null, charEnd = null) {
  const word = String(rawWord || '');
  const { phones, estimated } = rulePhones(rawWord);
  return phones.flatMap((phone, index) => {
    const segments = GLIDES[phone] || [phone];
    return segments.map((segment, part) => ({
      viseme: PHONEME_TO_VISEME[segment] || PHONEME_TO_VISEME[phones.slice(index + 1).find((next) => /^(AA|AE|AH|EH|IH|IY|AO|UW|UH)/.test(next))] || VISEMES.aa,
      phoneme: segment,
      weight: (PHONEME_WEIGHT[phone] || 1) * (segments.length === 1 ? 1 : part === 0 ? 0.7 : 0.3),
      word, charStart, charEnd, estimated,
    }));
  });
}

function tokenizeText(text) {
  const tokens = [];
  const source = String(text || '');
  for (const match of source.matchAll(TOKEN_PATTERN)) {
    tokens.push({
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

function scaleUnits(units, start, end, timeKeys) {
  const totalWeight = units.reduce((sum, item) => sum + item.weight, 0) || 1;
  let cursor = start;
  return units.map((unit, index) => {
    const itemStart = cursor;
    const itemEnd = index === units.length - 1
      ? end
      : start + ((cursor - start) + ((end - start) * unit.weight / totalWeight));
    cursor = itemEnd;
    const output = {
      viseme: unit.viseme,
      weight: unit.weight,
      [timeKeys.start]: itemStart,
      [timeKeys.end]: itemEnd,
    };
    if (unit.phoneme) output.phoneme = unit.phoneme;
    if (unit.word) output.word = unit.word;
    if (unit.charStart !== null) output.charStart = unit.charStart;
    if (unit.charEnd !== null) output.charEnd = unit.charEnd;
    if (unit.estimated) output.estimated = true;
    return output;
  });
}

export function buildVisemeTimeline(text) {
  const tokens = tokenizeText(text);
  const units = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    units.push(...makeWordUnits(token.raw, token.start, token.end));
    const following = String(text).slice(token.end, tokens[index + 1]?.start ?? String(text).length);
    if (/[.,!?;:\n]/.test(following)) units.push({ viseme: VISEMES.sil, weight: /[.!?]/.test(following) ? 1.1 : 0.5, charStart: token.end, charEnd: token.end + following.length });
  }
  if (!units.length) return [];
  return scaleUnits(units, 0, 1, { start: 'startFrac', end: 'endFrac' });
}
