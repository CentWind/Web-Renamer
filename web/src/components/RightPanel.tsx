import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  Folder,
  History,
  Info,
  MinusCircle,
  Play,
  Plus,
  RadioTower,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  XCircle,
} from 'lucide-react';
import { useStore } from '../store';
import { Chip, Empty, Field, Panel, Spinner, Toggle } from './ui';
import { formatTime, relativeTime } from '../lib/format';
import type { PlanStatus, WatchConfig } from '../types';

/* -------------------------------- 预览 -------------------------------- */

const STATUS_META: Record<PlanStatus, { label: string; tone: 'default' | 'ok' | 'warn' | 'danger' | 'accent'; icon: any }> = {
  ok: { label: '将改名', tone: 'accent', icon: ArrowRight },
  unchanged: { label: '无变化', tone: 'default', icon: MinusCircle },
  conflict: { label: '冲突', tone: 'warn', icon: AlertTriangle },
  invalid: { label: '非法', tone: 'danger', icon: XCircle },
  skipped: { label: '已跳过', tone: 'default', icon: MinusCircle },
};

/** 取展示路径的目录部分，例如 photos/2024/01/a.jpg → photos/2024/01 */
function parentOfDisplay(display?: string): string {
  if (!display) return '';
  const i = display.lastIndexOf('/');
  return i > 0 ? display.slice(0, i) : '';
}

function PreviewTab() {
  const preview = useStore((s) => s.preview);
  const previewing = useStore((s) => s.previewing);
  const queue = useStore((s) => s.queue);
  const applyNow = useStore((s) => s.applyNow);
  const clearQueue = useStore((s) => s.clearQueue);

  if (queue.length === 0) {
    return (
      <Empty
        icon={<Eye size={26} />}
        title="先添加文件并配置规则"
        hint="左侧把文件加入「待处理」，中间配好规则链，这里会实时显示改名预览。"
      />
    );
  }

  const s = preview?.summary;

  return (
    <div className="flex h-full w-full min-w-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-1.5 border-b px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
        {previewing && <Spinner size={13} />}
        <Chip tone="accent">将改名 {s?.ok ?? 0}</Chip>
        <Chip>无变化 {s?.unchanged ?? 0}</Chip>
        {(s?.conflict ?? 0) > 0 && <Chip tone="warn">冲突 {s!.conflict}</Chip>}
        {(s?.invalid ?? 0) > 0 && <Chip tone="danger">非法 {s!.invalid}</Chip>}
        <div className="ml-auto flex items-center gap-1.5">
          <button className="btn btn-sm" disabled={queue.length === 0} onClick={clearQueue}>
            <Trash2 size={13} /> 清空
          </button>
          <button
            className="btn btn-sm btn-primary"
            disabled={!s?.canApply || previewing}
            onClick={applyNow}
            title={s?.canApply ? '' : '存在冲突或非法项，或没有需要改名的文件'}
          >
            <Play size={13} /> 执行重命名
          </button>
        </div>
      </div>

      <div className="scroll-area min-h-0 flex-1">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-10">
            <tr style={{ background: 'var(--panel-2)' }}>
              <th className="muted px-3 py-2 text-left font-semibold">原文件名</th>
              <th className="muted px-3 py-2 text-left font-semibold">新文件名</th>
              <th className="muted w-[92px] px-3 py-2 text-left font-semibold">状态</th>
            </tr>
          </thead>
          <tbody>
            {preview?.items.map((it, i) => {
              const meta = STATUS_META[it.status];
              const Icon = meta.icon;
              return (
                <tr
                  key={it.src + i}
                  className="row-hover border-b"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <td className="max-w-0 px-3 py-2">
                    <div className="flex items-center gap-1" title={it.src}>
                      {it.isDir && (
                        <Folder size={11} className="flex-none" style={{ color: 'var(--accent)' }} />
                      )}
                      <span className="mono truncate">{it.srcName}</span>
                    </div>
                    {parentOfDisplay(it.srcDisplay) && (
                      <div className="muted truncate text-[10.5px]" title={it.srcDisplay}>
                        {parentOfDisplay(it.srcDisplay)}
                      </div>
                    )}
                  </td>
                  <td className="max-w-0 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={clsx('mono truncate', it.status === 'unchanged' && 'muted')}
                        title={it.dstName}
                      >
                        {it.dstName}
                      </span>
                    </div>
                    {it.reason && (
                      <div
                        className="mt-0.5 text-[11px]"
                        style={{ color: it.status === 'conflict' ? 'var(--warn)' : 'var(--danger)' }}
                      >
                        {it.reason}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={clsx('chip', `chip-${meta.tone}`)}>
                      <Icon size={11} />
                      {meta.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* -------------------------------- 历史 -------------------------------- */

function HistoryTab() {
  const history = useStore((s) => s.history);
  const undo = useStore((s) => s.undo);
  const clearHistory = useStore((s) => s.clearHistory);

  return (
    <div className="flex h-full w-full min-w-0 flex-1 flex-col">
      <div className="flex flex-none items-center justify-between border-b px-3 py-2.5" style={{ borderColor: 'var(--border)' }}>
        <span className="muted text-xs">每次执行都可一键还原，最多保留最近 100 条</span>
        <button className="btn btn-sm" disabled={history.length === 0} onClick={clearHistory}>
          <Trash2 size={13} /> 清空历史
        </button>
      </div>
      <div className="scroll-area min-h-0 flex-1 p-2.5">
        {history.length === 0 ? (
          <Empty icon={<History size={26} />} title="暂无操作记录" hint="执行重命名后，这里会出现可撤销的记录。" />
        ) : (
          <div className="flex flex-col gap-2">
            {history.map((j) => (
              <div
                key={j.id}
                className="panel !shadow-none flex items-center gap-3 px-3 py-2.5"
                style={{ background: 'var(--panel-2)' }}
              >
                <Clock size={15} className="muted flex-none" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">
                    重命名 {j.entries.length} 个文件
                    {j.undone && <span className="muted ml-2 text-[11px]">已撤销</span>}
                  </div>
                  <div className="muted mono truncate text-[11px]" title={j.entries[0]?.to}>
                    {formatTime(j.createdAt)} · 例如 {j.entries[0]?.to?.split(/[\\/]/).pop()}
                  </div>
                </div>
                <button
                  className="btn btn-sm"
                  disabled={j.undone}
                  onClick={() => undo(j.id)}
                  title="还原这批改名"
                >
                  <Undo2 size={13} /> 撤销
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- 监听 -------------------------------- */

function WatchTab() {
  const config = useStore((s) => s.config);
  const presets = useStore((s) => s.presets);
  const saveWatch = useStore((s) => s.saveWatch);
  const browse = useStore((s) => s.browse);

  const current = config?.watch.config;
  const [draft, setDraft] = useState<WatchConfig | null>(current ?? null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (current) setDraft(current);
  }, [current?.enabled, current?.ruleSetId, current?.paths, current?.stabilityMs]);

  const dirty = useMemo(() => {
    if (!draft || !current) return false;
    return JSON.stringify(draft) !== JSON.stringify(current);
  }, [draft, current]);

  if (!draft) return <Empty title="加载中…" />;

  const update = (patch: Partial<WatchConfig>) => setDraft({ ...draft, ...patch });

  const addPath = (p?: string) => {
    const target = p ?? browse?.path;
    if (!target) return;
    if (draft.paths.includes(target)) return;
    update({ paths: [...draft.paths, target] });
  };

  const commit = async (patch?: Partial<WatchConfig>) => {
    setSaving(true);
    try {
      await saveWatch({ ...draft, ...patch });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="scroll-area h-full w-full min-w-0 flex-1 p-3">
      <div className="flex flex-col gap-4">
        <div
          className="flex items-center gap-3 rounded-xl border px-3.5 py-3"
          style={{ borderColor: 'var(--border-strong)', background: 'var(--panel-2)' }}
        >
          <RadioTower size={18} className="flex-none" style={{ color: draft.enabled ? 'var(--ok)' : 'var(--muted)' }} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">开启目录监听自动改名</div>
            <div className="muted text-[11px] leading-snug">
              开启后，往监听目录里丢进新文件就会自动套用下面的规则集改名。
            </div>
          </div>
          <Toggle
            on={draft.enabled}
            disabled={saving}
            onChange={(v) => {
              update({ enabled: v });
              void commit({ enabled: v });
            }}
          />
        </div>

        <Field label="自动套用的规则集">
          <select
            className="field"
            value={draft.ruleSetId ?? ''}
            onChange={(e) => update({ ruleSetId: e.target.value || null })}
          >
            <option value="">请选择一个预设…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.folder ? `${p.folder} / ` : ''}
                {p.name}（{p.rules.length} 条规则）
              </option>
            ))}
          </select>
        </Field>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="field-label !mb-0">监听目录</span>
            <button className="btn btn-sm" onClick={() => addPath()}>
              <Plus size={13} /> 加入当前目录
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            {draft.paths.length === 0 && (
              <div className="muted rounded-lg border border-dashed px-3 py-2.5 text-[12px]" style={{ borderColor: 'var(--border-strong)' }}>
                还没有监听目录。先进到目标目录，再点「加入当前目录」。
              </div>
            )}
            {draft.paths.map((p) => (
              <div
                key={p}
                className="mono flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]"
                style={{ borderColor: 'var(--border)', background: 'var(--panel-2)' }}
              >
                <span className="min-w-0 flex-1 truncate" title={p}>
                  {p}
                </span>
                <button
                  className="icon-btn h-6 w-6"
                  onClick={() => update({ paths: draft.paths.filter((x) => x !== p) })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="稳定等待（毫秒）" help="文件写入完成后再处理">
            <input
              type="number"
              className="field"
              value={draft.stabilityMs}
              onChange={(e) => update({ stabilityMs: Number(e.target.value) })}
            />
          </Field>
          <div className="flex flex-col justify-center gap-2.5 pt-5">
            <label className="flex cursor-pointer select-none items-center gap-2 text-[13px]">
              <Toggle on={draft.recursive} onChange={(v) => update({ recursive: v })} />
              包含子目录
            </label>
            <label className="flex cursor-pointer select-none items-center gap-2 text-[13px]">
              <Toggle on={draft.recordHistory} onChange={(v) => update({ recordHistory: v })} />
              记录到历史（可撤销）
            </label>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => commit()}>
            {saving ? <Spinner size={13} /> : <Save size={14} />} 保存监听设置
          </button>
          <button className="btn" disabled={!dirty} onClick={() => setDraft(current!)}>
            <RotateCcw size={13} /> 重置
          </button>
        </div>

        <div
          className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-[12px]"
          style={{ background: 'var(--accent-soft)', color: 'var(--text-2)' }}
        >
          <Info size={14} className="mt-0.5 flex-none" style={{ color: 'var(--accent)' }} />
          <div>
            上次自动运行：{relativeTime(draft.lastRunAt)}
            {draft.lastRunSummary && <> · {draft.lastRunSummary}</>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 容器 ------------------------------ */

export function RightPanel() {
  const [tab, setTab] = useState<'preview' | 'history' | 'watch'>('preview');
  const historyCount = useStore((s) => s.history.length);
  const watchActive = useStore((s) => s.config?.watch.active);

  const tabBtn = (key: typeof tab, label: string, icon: any, badge?: number) => (
    <button
      className={clsx('btn btn-ghost btn-sm', tab === key && '!bg-[var(--panel-2)] !text-[var(--text)]')}
      onClick={() => setTab(key)}
    >
      {icon}
      {label}
      {badge ? <span className="chip chip-accent !px-1.5 !py-0 !text-[10px]">{badge}</span> : null}
    </button>
  );

  return (
    <Panel
      className="flex-1"
      title={
        <div className="flex items-center gap-1">
          {tabBtn('preview', '预览', <Eye size={14} />)}
          {tabBtn('history', '历史', <History size={14} />, historyCount)}
          {tabBtn('watch', '监听', <RadioTower size={14} />)}
          {watchActive && <span className="ml-1 h-1.5 w-1.5 rounded-full" style={{ background: 'var(--ok)' }} />}
        </div>
      }
      bodyClassName="min-h-0 flex"
    >
      <div className="flex min-h-0 w-full flex-1">
        {tab === 'preview' && <PreviewTab />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'watch' && <WatchTab />}
      </div>
    </Panel>
  );
}
