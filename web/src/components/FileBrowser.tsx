import { useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  ArrowUp,
  CheckSquare,
  Eye,
  EyeOff,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderDown,
  FolderOpen,
  FolderPlus,
  ListFilter,
  Trash2,
  X,
} from 'lucide-react';
import { useStore } from '../store';
import { Empty, Spinner } from './ui';
import { formatBytes } from '../lib/format';

export function FileBrowser() {
  const browse = useStore((s) => s.browse);
  const browsing = useStore((s) => s.browsing);
  const navigate = useStore((s) => s.navigate);
  const addEntries = useStore((s) => s.addEntries);
  const addDirectory = useStore((s) => s.addDirectory);
  const scanningDirectory = useStore((s) => s.scanningDirectory);
  const queue = useStore((s) => s.queue);
  const removeFromQueue = useStore((s) => s.removeFromQueue);
  const clearQueue = useStore((s) => s.clearQueue);
  const [showHidden, setShowHidden] = useState(false);
  const [tab, setTab] = useState<'browse' | 'queue'>('browse');
  /** 递归添加时是否同时加入文件夹本身（用于重命名文件夹） */
  const [includeDirsForScan, setIncludeDirsForScan] = useState(false);

  /** 递归添加目录（含子目录）后切到「待处理」查看结果 */
  const addFolderRecursive = async (targetPath?: string) => {
    const added = await addDirectory(targetPath, { includeDirs: includeDirsForScan });
    if (added > 0) setTab('queue');
  };

  const queued = useMemo(() => new Set(queue.map((q) => q.path)), [queue]);
  const entries = (browse?.entries ?? []).filter((e) => showHidden || !e.hidden);
  const filesInDir = entries.filter((e) => !e.dir);

  const currentPathInQueue = browse
    ? queue.filter((q) => q.path.toLowerCase().startsWith((browse.path + '/').toLowerCase()))
    : [];

  return (
    <section className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* tabs */}
      <div className="flex flex-none items-center gap-1 border-b px-2 pt-2" style={{ borderColor: 'var(--border)' }}>
        <button
          className={clsx('btn btn-ghost btn-sm', tab === 'browse' && '!bg-[var(--panel-2)] !text-[var(--text)]')}
          onClick={() => setTab('browse')}
        >
          <FolderOpen size={14} /> 浏览
        </button>
        <button
          className={clsx('btn btn-ghost btn-sm', tab === 'queue' && '!bg-[var(--panel-2)] !text-[var(--text)]')}
          onClick={() => setTab('queue')}
        >
          <ListFilter size={14} /> 待处理
          {queue.length > 0 && (
            <span className="chip chip-accent !px-1.5 !py-0 !text-[10px]">{queue.length}</span>
          )}
        </button>
        <div className="flex-1" />
        {tab === 'browse' && (
          <button
            className="icon-btn"
            title={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        )}
      </div>

      {tab === 'browse' ? (
        <>
          <div className="flex flex-none items-center gap-1.5 border-b px-2.5 py-2" style={{ borderColor: 'var(--border)' }}>
            <button
              className="icon-btn"
              disabled={!browse?.parent}
              title="上一级"
              onClick={() => browse?.parent && navigate(browse.parent)}
            >
              <ArrowUp size={15} />
            </button>
            <div className="mono min-w-0 flex-1 truncate" title={browse?.path}>
              {browse?.display ?? '—'}
            </div>
            <label
              className="muted flex flex-none cursor-pointer items-center gap-1 text-[11px]"
              title="递归添加时把文件夹本身也加入待处理（用于重命名文件夹）"
            >
              <input
                type="checkbox"
                className="h-3 w-3 accent-[var(--accent)]"
                checked={includeDirsForScan}
                onChange={(e) => setIncludeDirsForScan(e.target.checked)}
              />
              含文件夹
            </label>
            <button
              className="btn btn-sm"
              disabled={filesInDir.length === 0}
              title="只把当前目录下的文件加入列表（不含子目录）"
              onClick={() => addEntries(filesInDir)}
            >
              <FilePlus2 size={13} /> 当前目录
            </button>
            <button
              className="btn btn-sm btn-primary"
              disabled={!browse || scanningDirectory}
              title={includeDirsForScan ? '添加当前目录及所有子目录下的文件和文件夹' : '添加当前目录及所有子目录下的文件'}
              onClick={() => void addFolderRecursive(browse?.path)}
            >
              {scanningDirectory ? <Spinner size={13} /> : <FolderDown size={13} />} 含子目录
            </button>
          </div>

          <div className="scroll-area min-h-0 flex-1">
            {browsing && !browse ? (
              <div className="flex h-full items-center justify-center">
                <Spinner size={18} />
              </div>
            ) : entries.length === 0 ? (
              <Empty icon={<Folder size={26} />} title="这个目录是空的" hint="上传或放入文件后再回来看看。" />
            ) : (
              <ul className="p-1.5">
                {entries.map((e) => {
                  const inQueue = queued.has(e.path);
                  return (
                    <li key={e.path}>
                      <div
                        className={clsx(
                          'row-hover group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5',
                          inQueue && 'bg-[var(--accent-soft)]',
                        )}
                        onClick={() => (e.dir ? navigate(e.path) : addEntries([e]))}
                      >
                        <span className="flex-none" style={{ color: e.dir ? 'var(--accent)' : 'var(--muted)' }}>
                          {e.dir ? <Folder size={16} /> : <FileIcon size={15} />}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13px]">{e.name}</span>
                        {!e.dir && (
                          <span className="muted mono flex-none text-[11px]">{formatBytes(e.size)}</span>
                        )}
                        {e.dir && (
                          <>
                            <button
                              className="icon-btn h-6 w-6 flex-none opacity-0 group-hover:opacity-100"
                              title="把此文件夹加入待处理（重命名文件夹本身）"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                addEntries([{ ...e, isDir: true }]);
                                setTab('queue');
                              }}
                            >
                              <FolderPlus size={13} />
                            </button>
                            <button
                              className="icon-btn h-6 w-6 flex-none opacity-0 group-hover:opacity-100"
                              title="添加此目录及所有子目录下的文件（含文件夹需勾选上方「含文件夹」）"
                              disabled={scanningDirectory}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                void addFolderRecursive(e.path);
                              }}
                            >
                              <FolderDown size={13} />
                            </button>
                          </>
                        )}
                        {inQueue && <CheckSquare size={14} style={{ color: 'var(--accent)' }} className="flex-none" />}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-none items-center justify-between border-b px-2.5 py-2" style={{ borderColor: 'var(--border)' }}>
            <span className="muted text-xs">
              共 {queue.length} 个文件
              {currentPathInQueue.length > 0 && ` · 当前目录 ${currentPathInQueue.length} 个`}
            </span>
            <button className="btn btn-sm btn-danger" disabled={queue.length === 0} onClick={clearQueue}>
              <Trash2 size={13} /> 清空
            </button>
          </div>
          <div className="scroll-area min-h-0 flex-1">
            {queue.length === 0 ? (
              <Empty
                icon={<FilePlus2 size={26} />}
                title="还没有待处理的文件"
                hint="在「浏览」里点击文件/文件夹，或点「当前目录」「含子目录」把内容加进来；文件夹行的按钮可单独加入文件夹本身。"
              />
            ) : (
              <ul className="p-1.5">
                {queue.map((q) => (
                  <li key={q.path}>
                    <div className="row-hover group flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                      {q.isDir ? (
                        <Folder size={15} className="flex-none" style={{ color: 'var(--accent)' }} />
                      ) : (
                        <FileIcon size={15} className="muted flex-none" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]" title={q.path}>
                          {q.name}
                        </div>
                        <div className="muted truncate text-[11px]" title={q.display || q.path}>
                          {q.isDir ? '文件夹' : formatBytes(q.size)} · {q.display || q.path}
                        </div>
                      </div>
                      <button className="icon-btn h-6 w-6 opacity-0 group-hover:opacity-100" onClick={() => removeFromQueue(q.path)}>
                        <X size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
