import vm from 'node:vm';
import type { Rule, Scope } from '../types.js';
import { escapeRegExp } from './util.js';
import { applyRearrange } from './rearrange.js';
import { applyPinyin } from './pinyin.js';
import { applyDate } from './date.js';

/* ============================== 基础工具 ============================== */

export interface FileParts {
  name: string;
  ext: string;
}

export interface EvalCtx {
  /** 在整个列表里的序号（从 1 开始） */
  index: number;
  total: number;
  /** 在同一目录里的序号（从 1 开始，用于「按目录重置」） */
  dirIndex: number;
  dirTotal: number;
  dir: string;
  path: string;
  meta: Record<string, string>;
  /** 可复现的随机源：同一次预览与执行结果一致 */
  random: () => number;
}

export class RuleError extends Error {
  ruleId: string;
  constructor(ruleId: string, message: string) {
    super(message);
    this.name = 'RuleError';
    this.ruleId = ruleId;
  }
}

/** 拆分文件名为主名 + 扩展名（不含点）。`.gitignore` 这类点开头文件视为无扩展名。 */
export function splitName(filename: string): FileParts {
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return { name: filename, ext: '' };
  return { name: filename.slice(0, idx), ext: filename.slice(idx + 1) };
}

export function joinName(p: FileParts): string {
  return p.ext ? `${p.name}.${p.ext}` : p.name;
}

/** 展开正则替换模板中的 $1 / $<name> / $& / $$ */
function expandTemplate(template: string, match: RegExpExecArray | RegExpMatchArray): string {
  return template.replace(
    /\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g,
    (_m, token: string) => {
      if (token === '$') return '$';
      if (token === '&') return match[0];
      if (token === '`') return (match as any).input?.slice(0, match.index) ?? '';
      if (token === "'") return (match as any).input?.slice((match.index ?? 0) + match[0].length) ?? '';
      if (token.startsWith('<')) {
        const g = (match as any).groups ?? {};
        return g[token.slice(1, -1)] ?? '';
      }
      const i = Number(token);
      return (match as any)[i] ?? '';
    },
  );
}

function replaceWithCount(
  s: string,
  re: RegExp,
  replacement: string,
  occurrences: number,
): string {
  if (occurrences === Infinity) {
    return s.replace(re, replacement);
  }
  let out = s;
  let done = 0;
  while (done < occurrences) {
    const single = new RegExp(re.source, re.flags.replace('g', ''));
    const m = single.exec(out);
    if (!m) break;
    out = out.slice(0, m.index) + expandTemplate(replacement, m) + out.slice(m.index + m[0].length);
    done++;
    if (m[0] === '') break; // 防止零宽匹配死循环
  }
  return out;
}

/** 转义路径中的非法字符（Windows 规则 + 控制字符） */
const ILLEGAL_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/* ============================== 各规则实现 ============================== */

function applyInsert(s: string, params: any): string {
  const text = String(params.text ?? '');
  const position = params.position ?? 'prefix';
  if (position === 'replace') return text;
  if (position === 'afterText' || position === 'beforeText') {
    const anchor = String(params.anchor ?? '');
    if (!anchor) return s;
    const cs = params.caseSensitive !== false;
    const idx = cs
      ? s.indexOf(anchor)
      : s.toLowerCase().indexOf(anchor.toLowerCase());
    if (idx === -1) return s;
    return position === 'beforeText'
      ? s.slice(0, idx) + text + s.slice(idx)
      : s.slice(0, idx + anchor.length) + text + s.slice(idx + anchor.length);
  }
  if (position === 'prefix') return text + s;
  if (position === 'suffix') return s + text;
  let at = Number(params.at ?? 0);
  if (Number.isNaN(at)) at = 0;
  if (at < 0) at = Math.max(0, s.length + at);
  at = Math.min(at, s.length);
  return s.slice(0, at) + text + s.slice(at);
}

function applyReplace(s: string, params: any): string {
  const find = String(params.find ?? '');
  if (!find) return s;
  const replacement = String(params.replaceWith ?? '');
  const caseSensitive = params.caseSensitive !== false;
  const isRegex = !!params.regex;
  const wholeWord = !!params.wholeWord;

  let source = isRegex ? find : escapeRegExp(find);
  if (wholeWord && !isRegex) source = `\\b${source}\\b`;
  const flags = 'g' + (caseSensitive ? '' : 'i');

  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch (e: any) {
    throw new Error(`正则表达式无效: ${e.message}`);
  }

  const occ = params.occurrences;
  let occurrences: number | 'last' = Infinity;
  if (occ === 'first') occurrences = 1;
  else if (occ === 'last') occurrences = 'last';
  else if (typeof occ === 'number' && occ > 0) occurrences = occ;

  if (occurrences === 'last') {
    const gre = new RegExp(re.source, re.flags);
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = gre.exec(s))) {
      last = m;
      if (m[0] === '') { gre.lastIndex++; continue; }
    }
    if (!last) return s;
    return (
      s.slice(0, last.index) +
      expandTemplate(replacement, last) +
      s.slice(last.index + last[0].length)
    );
  }

  // 非正则模式下，替换文本里的 $ 需要当作字面量
  const repl = isRegex ? replacement : replacement;
  return replaceWithCount(s, re, repl, occurrences as number);
}

function applyRemove(s: string, params: any): string {
  const mode = params.mode ?? 'chars';
  if (mode === 'text') {
    // 对齐 ReNamer：删除指定文本，可选全部 / 第一个 / 最后一个
    const text = String(params.text ?? '');
    if (!text) return s;
    const cs = params.caseSensitive !== false;
    const wholeWord = !!params.wholeWord;
    let source = escapeRegExp(text);
    if (wholeWord) source = `\\b${source}\\b`;
    let re: RegExp;
    try {
      re = new RegExp(source, 'g' + (cs ? '' : 'i'));
    } catch {
      return s;
    }
    const occ = params.occurrences ?? 'all';
    if (occ === 'all') return s.replace(re, '');
    const matches: RegExpExecArray[] = [];
    const gre = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = gre.exec(s))) {
      if (m[0] === '') { gre.lastIndex++; continue; }
      matches.push(m);
    }
    const target = occ === 'first' ? matches[0] : matches[matches.length - 1];
    if (!target) return s;
    return s.slice(0, target.index) + s.slice(target.index + target[0].length);
  }
  if (mode === 'chars') {
    const chars = String(params.chars ?? '');
    if (!chars) return s;
    const set = new Set(chars.split(''));
    return s
      .split('')
      .filter((c) => !set.has(c))
      .join('');
  }
  if (mode === 'range') {
    const fromEnd = !!params.fromEnd;
    const fromRaw = Math.max(1, Number(params.from ?? 1));
    const from = fromRaw - 1; // 1 基转 0 基
    const rawCount = Number(params.count);
    // 长度留空 / 0 / 负数 = 一直删到末尾
    const tillEnd = !Number.isFinite(rawCount) || rawCount <= 0;
    const count = tillEnd ? 0 : Math.floor(rawCount);
    const start = tillEnd
      ? fromEnd
        ? Math.max(0, s.length - fromRaw)
        : from
      : fromEnd
        ? Math.max(0, s.length - from - count)
        : from;
    if (start >= s.length) return s;
    return s.slice(0, start) + (tillEnd ? '' : s.slice(start + count));
  }
  if (mode === 'between') {
    const open = String(params.open ?? '');
    const close = String(params.close ?? '');
    if (!open || !close) return s;
    const startIdx = s.indexOf(open);
    if (startIdx === -1) return s;
    const endIdx = s.indexOf(close, startIdx + open.length);
    if (endIdx === -1) return s;
    const inclusive = !!params.inclusive;
    const cutStart = inclusive ? startIdx : startIdx + open.length;
    const cutEnd = inclusive ? endIdx + close.length : endIdx;
    return s.slice(0, cutStart) + s.slice(cutEnd);
  }
  return s;
}

function applyCase(s: string, params: any): string {
  const mode = params.mode ?? 'lower';
  const seps = String(params.separators ?? ' \t_-');
  switch (mode) {
    case 'lower':
      return s.toLowerCase();
    case 'upper':
      return s.toUpperCase();
    case 'invert':
      return s
        .split('')
        .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
        .join('');
    case 'title': {
      const sepSet = new Set(seps.split(''));
      let prevIsSep = true;
      return s
        .split('')
        .map((c) => {
          const isSep = sepSet.has(c);
          const out = prevIsSep && !isSep ? c.toUpperCase() : c.toLowerCase();
          prevIsSep = isSep;
          return out;
        })
        .join('');
    }
    case 'capitalize': {
      // 对齐 ReNamer「Capitalize AND Preserve」：首字母大写，其余保留原样
      const sepSet = new Set(seps.split(''));
      let prevIsSep = true;
      return s
        .split('')
        .map((c) => {
          const isSep = sepSet.has(c);
          const out = prevIsSep && !isSep ? c.toUpperCase() : c;
          prevIsSep = isSep;
          return out;
        })
        .join('');
    }
    case 'sentence': {
      const lower = s.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    }
    default:
      return s;
  }
}

function applyStrip(s: string, params: any): string {
  let out = s;
  if (params.removeChars) {
    const set = new Set(String(params.removeChars).split(''));
    const where = params.where ?? 'everywhere';
    if (where === 'leading') {
      let i = 0;
      while (i < out.length && set.has(out[i])) i++;
      out = out.slice(i);
    } else if (where === 'trailing') {
      let i = out.length;
      while (i > 0 && set.has(out[i - 1])) i--;
      out = out.slice(0, i);
    } else {
      out = out
        .split('')
        .filter((c) => !set.has(c))
        .join('');
    }
  }
  if (params.removeDiacritics) {
    out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  if (params.collapseSpaces) {
    out = out.replace(/\s+/g, ' ');
  }
  if (params.trim !== false) {
    out = out.trim();
  }
  return out;
}

function applyCleanup(s: string, params: any): string {
  let out = s;
  // 对齐 ReNamer「Strip out content of brackets」：连同括号一起删
  if (params.stripBrackets) {
    out = out.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, '');
  }
  // 对齐 ReNamer「Insert a space in front of capitalized letters」
  if (params.camelSpace) {
    out = out.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  const repl = params.replaceWith ?? '_';
  out = out.replace(ILLEGAL_CHARS, repl);
  if (params.collapse) out = out.replace(new RegExp(`${escapeRegExp(repl)}{2,}`, 'g'), repl);
  if (params.trimEnds !== false) out = out.replace(/[. ]+$/, '');
  return out;
}

const CHARSETS: Record<string, string> = {
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  hex: '0123456789abcdef',
};

function applyRandomize(s: string, params: any, ctx: EvalCtx): string {
  const length = Math.max(1, Number(params.length ?? 8));
  const custom = String(params.custom ?? '').trim();
  const charset = custom || CHARSETS[params.charset ?? 'alnum'] || CHARSETS.alnum;
  let out = '';
  for (let i = 0; i < length; i++) {
    out += charset[Math.floor(ctx.random() * charset.length)];
  }
  const mode = params.mode ?? 'replace';
  if (mode === 'prefix') return out + s;
  if (mode === 'suffix') return s + out;
  return out;
}

function applyPadding(s: string, params: any): string {
  const length = Math.max(0, Number(params.length ?? 0));
  const char = String(params.char ?? '0')[0] ?? '0';
  const align = params.align ?? 'left';
  let out = s;
  // 对齐 ReNamer「Remove zero padding」：去掉前导零
  if (params.stripZeros) out = out.replace(/^0+(?=\d)/, '');
  if (out.length < length) {
    const pad = char.repeat(length - out.length);
    out = align === 'left' ? pad + out : out + pad;
  } else if (out.length > length && params.truncate) {
    out = align === 'left' ? out.slice(out.length - length) : out.slice(0, length);
  }
  return out;
}

function applyMeta(s: string, params: any, ctx: EvalCtx): string {
  const pattern = String(params.pattern ?? '');
  if (!pattern) return s;
  let missing = false;
  const out = pattern.replace(/\{([^}]+)\}/g, (_m, expr: string) => {
    const [key, padRaw] = String(expr).split(':');
    const value = ctx.meta[key.trim()] ?? ctx.meta[key.trim().toLowerCase()];
    if (value === undefined || value === '') {
      missing = true;
      return '';
    }
    const pad = Number(padRaw);
    return Number.isFinite(pad) && pad > 0 ? value.padStart(pad, '0') : value;
  });
  if (missing && params.keepIfMissing) return s;
  return out;
}

function applyScript(s: string, params: any, ctx: EvalCtx): string {
  const code = String(params.code ?? '');
  if (!code.trim()) return s;
  const sandbox = {
    name: s,
    ext: '',
    index: ctx.index,
    total: ctx.total,
    dir: ctx.dir,
    meta: { ...ctx.meta },
    result: s,
  };
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
  const wrapped = `(function(){ "use strict";\n${code}\n return (typeof result !== 'undefined' ? result : name); })()`;
  try {
    const value = vm.runInContext(wrapped, context, { timeout: 300 });
    if (typeof value !== 'string') {
      throw new Error('脚本必须返回字符串（或给 result 赋值）');
    }
    return value;
  } catch (e: any) {
    throw new Error(`脚本执行失败: ${e.message}`);
  }
}

/** 序列号的进制 / 编号系统（对齐 ReNamer「Numbering system」） */
function toRoman(num: number): string {
  const map: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'],
    [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'],
    [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [v, sym] of map) {
    while (num >= v) {
      out += sym;
      num -= v;
    }
  }
  return out;
}

function toLetters(n: number): string {
  // 1→a  2→b … 26→z  27→aa
  let out = '';
  let x = n;
  while (x > 0) {
    x--;
    out = String.fromCharCode(97 + (x % 26)) + out;
    x = Math.floor(x / 26);
  }
  return out;
}

function formatNumber(n: number, system: string, padding: number): string {
  switch (system) {
    case 'hex':
      return n.toString(16);
    case 'hexUpper':
      return n.toString(16).toUpperCase();
    case 'letters':
      return toLetters(Math.max(1, n));
    case 'roman':
      return toRoman(Math.max(1, n));
    default:
      return String(n).padStart(padding, '0');
  }
}

/* ============================== 作用域分发 ============================== */

function withScope(parts: FileParts, scope: Scope, fn: (s: string) => string): FileParts {
  if (scope === 'ext') return { ...parts, ext: fn(parts.ext) };
  if (scope === 'full') return splitName(fn(joinName(parts)));
  return { ...parts, name: fn(parts.name) };
}

/* ============================== 主入口 ============================== */

export interface ApplyOptions {
  /** 目标是文件夹：没有扩展名概念，扩展名规则跳过，scope=ext 按整体处理 */
  isDirectory?: boolean;
}

export function applyRule(parts: FileParts, rule: Rule, ctx: EvalCtx, options: ApplyOptions = {}): FileParts {
  const p = rule.params ?? {};

  const isDir = options.isDirectory === true;
  // 文件夹没有扩展名：跳过扩展名规则；ext 作用域按整体（name）处理
  if (isDir && rule.type === 'extension') return parts;
  const scope: Scope = isDir && rule.scope === 'ext' ? 'name' : (rule.scope ?? 'name');

  const run = (fn: (s: string) => string) => withScope(parts, scope, fn);

  try {
    switch (rule.type) {
      case 'insert':
        return run((s) => applyInsert(s, p));
      case 'replace':
        return run((s) => applyReplace(s, p));
      case 'remove':
        return run((s) => applyRemove(s, p));
      case 'case':
        return run((s) => applyCase(s, p));
      case 'strip':
        return run((s) => applyStrip(s, p));
      case 'cleanup':
        return run((s) => applyCleanup(s, p));
      case 'randomize':
        return run((s) => applyRandomize(s, p, ctx));
      case 'padding':
        return run((s) => applyPadding(s, p));
      case 'rearrange':
        return run((s) => applyRearrange(s, p));
      case 'pinyin':
        return run((s) => applyPinyin(s, p));
      case 'date':
        return run((s) => applyDate(s, p));
      case 'meta':
        return withScope(parts, scope, (s) => applyMeta(s, p, ctx));
      case 'script':
        return withScope(parts, scope, (s) => applyScript(s, p, ctx));
      case 'regex': {
        const pattern = String(p.pattern ?? '');
        const flags = String(p.flags ?? 'g');
        if (!pattern) return parts;
        let re: RegExp;
        try {
          re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
        } catch (e: any) {
          throw new Error(`正则表达式无效: ${e.message}`);
        }
        return run((s) => s.replace(re, String(p.replacement ?? '')));
      }
      case 'extension': {
        // 扩展名规则始终作用于扩展名，忽略 scope
        const mode = p.mode ?? 'set';
        if (mode === 'remove') return { ...parts, ext: '' };
        if (mode === 'lower') return { ...parts, ext: parts.ext.toLowerCase() };
        if (mode === 'upper') return { ...parts, ext: parts.ext.toUpperCase() };
        const value = String(p.value ?? '').replace(/^\./, '');
        // 对齐 ReNamer「Append to the original filename」：保留原扩展名，追加在后面
        if (mode === 'append') {
          return { ...parts, ext: parts.ext ? `${parts.ext}.${value}` : value };
        }
        return { ...parts, ext: value };
      }
      case 'serialize': {
        const start = Number(p.start ?? 1);
        const step = Number(p.step ?? 1);
        const padding = Math.max(0, Number(p.padding ?? 0));
        const resetPerDir = !!p.resetPerDir;
        // 对齐 ReNamer「Repeat」：每个号重复用 N 次
        const repeat = Math.max(1, Math.floor(Number(p.repeat ?? 1) || 1));
        const n = resetPerDir ? ctx.dirIndex : ctx.index;
        const seq = start + Math.floor((n - 1) / repeat) * step;
        const value = formatNumber(seq, String(p.system ?? 'decimal'), padding);
        const mode = p.mode ?? 'suffix';
        return withScope(parts, scope, (s) => {
          if (mode === 'prefix') return value + s;
          if (mode === 'replace') return value;
          if (mode === 'index') {
            let at = Number(p.at ?? 0);
            if (Number.isNaN(at)) at = 0;
            if (at < 0) at = Math.max(0, s.length + at);
            at = Math.min(at, s.length);
            return s.slice(0, at) + value + s.slice(at);
          }
          return s + value;
        });
      }
      case 'userinput': {
        // 对齐 ReNamer「User Input」：每行一个名字，按文件顺序对应
        const lines = String(p.lines ?? '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const line = lines[ctx.index - 1];
        const mode = p.mode ?? 'replace';
        return withScope(parts, scope, (s) => {
          if (line === undefined) return s;
          if (mode === 'prefix') return line + s;
          if (mode === 'suffix') return s + line;
          return line;
        });
      }
      default:
        return parts;
    }
  } catch (e: any) {
    throw new RuleError(rule.id, e.message ?? String(e));
  }
}

/** 依次应用规则，返回新的文件名（文件夹传 options.isDirectory） */
export function applyRules(filename: string, rules: Rule[], ctx: EvalCtx, options: ApplyOptions = {}): string {
  let parts: FileParts = options.isDirectory ? { name: filename, ext: '' } : splitName(filename);
  for (const rule of rules) {
    if (!rule.enabled) continue;
    parts = applyRule(parts, rule, ctx, options);
  }
  return joinName(parts);
}
