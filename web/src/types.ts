export type RuleType =
  | 'insert'
  | 'replace'
  | 'remove'
  | 'case'
  | 'extension'
  | 'serialize'
  | 'strip'
  | 'regex'
  | 'cleanup'
  | 'randomize'
  | 'padding'
  | 'rearrange'
  | 'pinyin'
  | 'date'
  | 'meta'
  | 'script'
  | 'userinput';

export type Scope = 'name' | 'ext' | 'full';

export interface Rule {
  id: string;
  type: RuleType;
  enabled: boolean;
  label?: string;
  scope: Scope;
  params: Record<string, any>;
}

export interface RuleSet {
  id: string;
  name: string;
  folder: string | null;
  rules: Rule[];
  createdAt: string;
  updatedAt: string;
}

export type PlanStatus = 'ok' | 'conflict' | 'invalid' | 'unchanged' | 'skipped';

export interface PlanItem {
  src: string;
  dst: string;
  srcName: string;
  dstName: string;
  status: PlanStatus;
  reason?: string;
  /** 展示用路径（含根目录名），例如 photos/2024/01/a.jpg */
  srcDisplay?: string;
  /** 目标文件的展示用路径 */
  dstDisplay?: string;
}

export interface PlanSummary {
  total: number;
  ok: number;
  unchanged: number;
  conflict: number;
  invalid: number;
  canApply: boolean;
}

export interface PlanResult {
  root: string;
  items: PlanItem[];
  summary: PlanSummary;
}

export interface ApplyResult {
  journalId: string | null;
  renamed: { from: string; to: string }[];
  failed: { from: string; to: string; error: string }[];
  usedStaging: boolean;
}

export interface BrowseEntry {
  name: string;
  path: string;
  /** 展示路径（含根目录名） */
  display: string;
  dir: boolean;
  size: number;
  mtime: number;
  hidden: boolean;
}

export interface BrowseResult {
  path: string;
  display: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export interface JournalEntry {
  from: string;
  to: string;
}

export interface Journal {
  id: string;
  root: string;
  createdAt: string;
  entries: JournalEntry[];
  undone: boolean;
}

export interface WatchConfig {
  enabled: boolean;
  paths: string[];
  ruleSetId: string | null;
  stabilityMs: number;
  recursive: boolean;
  recordHistory: boolean;
  lastRunAt: string | null;
  lastRunSummary: string | null;
}

export interface Settings {
  watch: WatchConfig;
  theme: 'dark' | 'light';
}

/* --------------------------------- 登录 --------------------------------- */

export interface AuthStatus {
  authenticated: boolean;
  username: string | null;
  /** 仍在使用出厂默认密码 */
  defaultCredentials: boolean;
  retryAfterSec?: number;
}

export interface AuthPolicyInfo {
  maxAttempts: number;
  windowSec: number;
  lockSec: number;
  lockMaxSec: number;
  delayBaseMs: number;
  delayMaxMs: number;
  sessionTtlSec: number;
}

export interface AuthMe {
  authenticated: boolean;
  username: string;
  isDefault: boolean;
  passwordUpdatedAt: string | null;
  activeSessions: number;
  policy: AuthPolicyInfo;
}

/* --------------------------- 规则元数据（后端下发） --------------------------- */

export type FieldType = 'text' | 'number' | 'select' | 'checkbox' | 'textarea';

export interface RuleField {
  key: string;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  width?: 'full' | 'half';
}

export interface RuleTypeMeta {
  type: RuleType;
  label: string;
  description: string;
  scope: boolean;
  defaults: Record<string, any>;
  fields: RuleField[];
}

export interface AppConfig {
  roots: { path: string; name: string }[];
  configDir: string;
  watch: { active: boolean; config: WatchConfig; watchedPaths: string[] };
  settings: Settings;
}

export interface QueueItem {
  path: string;
  name: string;
  size: number;
  dir: string;
  /** 展示路径（含子目录），例如 photos/2024/01/a.jpg */
  display: string;
}

/* --------------------------- 目录扫描（递归添加） --------------------------- */

export interface ScanFile {
  path: string;
  name: string;
  /** 相对扫描目录的路径，例如 2024/01/a.jpg */
  rel: string;
  size: number;
  mtime: number;
  display: string;
}

export interface ScanResult {
  path: string;
  display: string;
  recursive: boolean;
  includeHidden: boolean;
  limit: number;
  files: ScanFile[];
  /** 跳过的符号链接 / 特殊文件 / 无权限条目数 */
  skipped: number;
  /** 因隐藏而未添加的条目数 */
  hiddenSkipped: number;
  truncated: boolean;
}
