/**
 * 共享类型定义 —— 规则、规则集、预览/执行计划、历史
 */

export type RuleType =
  | 'insert' // 插入文本（前缀 / 后缀 / 指定位置）
  | 'replace' // 查找替换（支持正则）
  | 'remove' // 移除字符 / 区间 / 分隔符之间的内容
  | 'case' // 大小写转换
  | 'extension' // 扩展名处理
  | 'serialize' // 序列号
  | 'strip' // 去空白 / 去指定字符
  | 'regex' // 正则替换（捕获组）
  | 'cleanup' // 清理非法字符
  | 'randomize' // 随机字符串
  | 'padding' // 补位 / 截断
  | 'rearrange' // 片段重排
  | 'pinyin' // 中文转拼音
  | 'date' // 日期重格式化
  | 'meta' // 元标签（音乐 / 图片）
  | 'script' // JavaScript 脚本
  | 'userinput'; // 用户输入（每行一个名字）

/** 规则作用对象：主名 / 扩展名 / 整个文件名 */
export type Scope = 'name' | 'ext' | 'full';

export interface Rule {
  id: string;
  type: RuleType;
  enabled: boolean;
  /** 用户自定义备注（可选） */
  label?: string;
  scope: Scope;
  params: Record<string, any>;
}

export interface RuleSet {
  id: string;
  name: string;
  /** 预设分组目录，null 表示根 */
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
  /** 稳定等待（毫秒），文件写入完成后才处理 */
  stabilityMs: number;
  /** 是否递归子目录 */
  recursive: boolean;
  /** 是否把改名结果也写进历史（可撤销） */
  recordHistory: boolean;
  lastRunAt: string | null;
  lastRunSummary: string | null;
}

export interface Settings {
  watch: WatchConfig;
  theme: 'dark' | 'light';
}
