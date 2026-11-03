/**
 * 规则引擎 / 执行器冒烟测试：node --import tsx src/smoke.ts
 * 覆盖：基础规则、序列号、仅改大小写、交换（成环）、冲突检测、撤销、递归扫描目录。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { initDb, getJournal, markJournalUndone } from './db.js';
import { buildPlan } from './rename/planner.js';
import { applyPlan, undoJournal } from './rename/executor.js';
import { scanDirectory } from './scan.js';
import type { PlanItem, Rule } from './types.js';
import type { RuleType } from './types.js';

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`  \u2713 ${name}`);
}

function rule(type: RuleType, params: Record<string, any>, extra: Partial<Rule> = {}): Rule {
  return { id: `${type}-${Math.random().toString(16).slice(2)}`, type, enabled: true, scope: extra.scope ?? 'name', params, ...extra };
}

async function newWorkspace(): Promise<{ dir: string; roots: string[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renamer-smoke-'));
  return { dir, roots: [dir] };
}

function touch(dir: string, ...names: string[]): string[] {
  return names.map((n) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, 'x');
    return p;
  });
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'renamer-cfg-'));
  initDb(tmpRoot);

  /* ---------- 1. 基础规则：替换 + 大小写 + 扩展名 ---------- */
  console.log('1) 基础规则（替换 / 大小写 / 扩展名）');
  {
    const { dir, roots } = await newWorkspace();
    const files = touch(dir, 'Hello World.TXT');
    const rules: Rule[] = [
      rule('replace', { find: 'World', replaceWith: 'ReNamer', regex: false, caseSensitive: true }),
      rule('case', { mode: 'lower' }),
      rule('extension', { mode: 'lower' }),
    ];
    const plan = await buildPlan(files, rules, roots);
    assert.strictEqual(plan.items[0].dstName, 'hello renamer.txt');
    assert.strictEqual(plan.summary.canApply, true);
    const res = applyPlan(plan.items, plan.root, true);
    assert.strictEqual(res.renamed.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'hello renamer.txt')));
    ok('替换 + 小写 + 扩展名 → hello renamer.txt');
  }

  /* ---------- 2. 序列号 ---------- */
  console.log('2) 序列号（补零 / 后缀）');
  {
    const { dir, roots } = await newWorkspace();
    const files = touch(dir, 'a.txt', 'b.txt', 'c.txt');
    const rules: Rule[] = [rule('serialize', { mode: 'suffix', start: 1, step: 1, padding: 3 })];
    const plan = await buildPlan(files, rules, roots);
    const names = plan.items.map((i) => i.dstName).sort();
    assert.deepStrictEqual(names, ['a001.txt', 'b002.txt', 'c003.txt']);
    ok('a/b/c.txt → a001/b002/c003.txt');
  }

  /* ---------- 3. 仅改大小写（需要两阶段） ---------- */
  console.log('3) 仅改大小写（大小写不敏感文件系统陷阱）');
  {
    const { dir, roots } = await newWorkspace();
    const files = touch(dir, 'Report.TXT');
    const rules: Rule[] = [rule('case', { mode: 'lower' }), rule('extension', { mode: 'lower' })];
    const plan = await buildPlan(files, rules, roots);
    const res = applyPlan(plan.items, plan.root, false);
    assert.strictEqual(res.usedStaging, true, '应走两阶段');
    assert.strictEqual(res.failed.length, 0);
    const entries = fs.readdirSync(dir);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0], 'report.txt');
    ok('Report.TXT → report.txt（两阶段）');
  }

  /* ---------- 4. 交换（成环） ---------- */
  console.log('4) 文件交换（A↔B 成环）');
  {
    const { dir, roots } = await newWorkspace();
    const [a, b] = touch(dir, 'A.txt', 'B.txt');
    const items: PlanItem[] = [
      { src: a, dst: path.join(dir, 'B.txt'), srcName: 'A.txt', dstName: 'B.txt', status: 'ok' },
      { src: b, dst: path.join(dir, 'A.txt'), srcName: 'B.txt', dstName: 'A.txt', status: 'ok' },
    ];
    const res = applyPlan(items, dir, false);
    assert.strictEqual(res.usedStaging, true);
    assert.strictEqual(res.renamed.length, 2);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['A.txt', 'B.txt']);
    ok('A.txt ↔ B.txt 无覆盖丢失');
  }

  /* ---------- 5. 冲突检测 ---------- */
  console.log('5) 冲突检测（多个文件撞名）');
  {
    const { dir, roots } = await newWorkspace();
    const files = touch(dir, 'x-1.txt', 'x-2.txt');
    // 把数字抹掉后两个文件都会变成 x-.txt → 撞名
    const rules: Rule[] = [rule('regex', { pattern: '\\d+', replacement: '', flags: 'g' })];
    const plan = await buildPlan(files, rules, roots);
    assert.strictEqual(plan.summary.conflict, 2);
    assert.strictEqual(plan.summary.canApply, false);
    ok('撞名时阻止执行');
  }

  /* ---------- 6. 正则捕获组 ---------- */
  console.log('6) 正则捕获组');
  {
    const { dir, roots } = await newWorkspace();
    const files = touch(dir, 'S01E05.mkv');
    const rules: Rule[] = [rule('regex', { pattern: '^S(\\d+)E(\\d+)$', replacement: '第$1季-第$2集', flags: 'i' })];
    const plan = await buildPlan(files, rules, roots);
    assert.strictEqual(plan.items[0].dstName, '第01季-第05集.mkv');
    ok('S01E05.mkv → 第01季-第05集.mkv');
  }

  /* ---------- 7. 撤销 ---------- */
  console.log('7) 撤销');
  {
    const { dir, roots } = await newWorkspace();
    const files = touch(dir, 'one.txt', 'two.txt');
    const rules: Rule[] = [rule('insert', { position: 'prefix', text: 'new_' })];
    const plan = await buildPlan(files, rules, roots);
    const res = applyPlan(plan.items, plan.root, true);
    assert.ok(res.journalId);
    assert.ok(fs.existsSync(path.join(dir, 'new_one.txt')));

    const journal = getJournal(res.journalId!);
    assert.ok(journal);
    const undone = undoJournal(journal!.entries);
    markJournalUndone(journal!.id);
    assert.strictEqual(undone.renamed.length, 2);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['one.txt', 'two.txt']);
    ok('执行后可完整还原');
  }

  /* ---------- 8. 重排 ---------- */
  console.log('8) 重排（片段模板 / 倒序）');
  {
    const { dir, roots } = await newWorkspace();
    const files = touch(dir, '会议纪要 2024.txt');
    const rules: Rule[] = [
      rule('rearrange', { mode: 'template', delimiter: ' ', pattern: '$2 $1', appendRest: true }),
    ];
    const plan = await buildPlan(files, rules, roots);
    assert.strictEqual(plan.items[0].dstName, '2024 会议纪要.txt');

    const files2 = touch(dir, 'a-b-c.txt');
    const rules2: Rule[] = [rule('rearrange', { mode: 'reverse', delimiter: '-', join: '-' })];
    const plan2 = await buildPlan(files2, rules2, roots);
    assert.strictEqual(plan2.items[0].dstName, 'c-b-a.txt');

    // 片段不足：保留原名，而不是拼出带悬空分隔符的坏名字
    const files3 = touch(dir, '你好世界.txt');
    const plan3 = await buildPlan(files3, rules, roots);
    assert.strictEqual(plan3.items[0].status, 'unchanged');
    ok('「会议纪要 2024」→「2024 会议纪要」；a-b-c → c-b-a；片段不足不动');
  }

  /* ---------- 9. 拼音转写 ---------- */
  console.log('9) 拼音转写（全拼 / 首字母）');
  {
    const { dir, roots } = await newWorkspace();
    const files = touch(dir, '你好世界.txt');
    const full = await buildPlan(
      files,
      [rule('pinyin', { mode: 'full', tone: 'none', separator: ' ', keepNonChinese: true, lowercase: true, v: true })],
      roots,
    );
    assert.strictEqual(full.items[0].dstName, 'ni hao shi jie.txt');

    const initials = await buildPlan(
      files,
      [rule('pinyin', { mode: 'initials', tone: 'none', keepNonChinese: true, lowercase: true })],
      roots,
    );
    assert.strictEqual(initials.items[0].dstName, 'nhsj.txt');
    ok('你好世界 → ni hao shi jie / nhsj');
  }

  /* ---------- 10. 日期重格式化 ---------- */
  console.log('10) 日期重格式化（自动识别 / 自定义源格式）');
  {
    const { dir, roots } = await newWorkspace();
    const files = touch(dir, 'IMG_20241007_draft.jpg');
    const auto = await buildPlan(files, [rule('date', { mode: 'replace', pattern: '', output: 'YYYY-MM-DD' })], roots);
    assert.strictEqual(auto.items[0].dstName, 'IMG_2024-10-07_draft.jpg');

    const cn = touch(dir, '会议2024年10月7日纪要.txt');
    const custom = await buildPlan(
      cn,
      [rule('date', { mode: 'replace', pattern: 'YYYY年M月D日', output: 'YYYY-MM-DD' })],
      roots,
    );
    assert.strictEqual(custom.items[0].dstName, '会议2024-10-07纪要.txt');

    const prefix = touch(dir, 'holiday 2024-10-07.txt');
    const moved = await buildPlan(
      prefix,
      [rule('date', { mode: 'prefix', pattern: 'YYYY-MM-DD', output: 'YYYY-MM-DD', join: '_' })],
      roots,
    );
    assert.strictEqual(moved.items[0].dstName, '2024-10-07_holiday.txt');
    ok('20241007 → 2024-10-07；中文日期 → 2024-10-07；日期移到开头');
  }

  /* ---------- 11. 对齐 ReNamer 补齐的选项 ---------- */
  console.log('11) ReNamer 对齐（remove-last / replace-last / 负引用 / 编号系统 / 用户输入等）');
  {
    const { dir, roots } = await newWorkspace();

    // remove：指定文本，仅最后一个（用户举例的 ReNamer「Last」）
    const f1 = touch(dir, 'track 01 - remix 01.mp3');
    const p1 = await buildPlan(f1, [rule('remove', { mode: 'text', text: '01', occurrences: 'last' })], roots);
    assert.strictEqual(p1.items[0].dstName, 'track 01 - remix .mp3');
    // remove：仅第一个 + 不区分大小写 + 全词
    const f1b = touch(dir, 'Abc abc ABC.txt');
    const p1b = await buildPlan(f1b, [rule('remove', { mode: 'text', text: 'abc', occurrences: 'first', caseSensitive: false })], roots);
    assert.strictEqual(p1b.items[0].dstName, ' abc ABC.txt');
    const f1c = touch(dir, 'catch cat.txt');
    const p1c = await buildPlan(f1c, [rule('remove', { mode: 'text', text: 'cat', occurrences: 'all', wholeWord: true })], roots);
    assert.strictEqual(p1c.items[0].dstName, 'catch .txt');
    const p1d = await buildPlan(f1c, [rule('remove', { mode: 'text', text: 'cat', occurrences: 'all', wholeWord: false })], roots);
    assert.strictEqual(p1d.items[0].dstName, 'ch .txt');

    // replace：仅最后一个
    const f2 = touch(dir, 'a-b-b.txt');
    const p2 = await buildPlan(f2, [rule('replace', { find: '-', replaceWith: '+', occurrences: 'last' })], roots);
    assert.strictEqual(p2.items[0].dstName, 'a-b+b.txt');

    // insert：在文本之后 / 之前 / 替换主名
    const f3 = touch(dir, '第01集.mkv');
    const p3 = await buildPlan(f3, [rule('insert', { position: 'afterText', text: '_NH', anchor: '第01集' })], roots);
    assert.strictEqual(p3.items[0].dstName, '第01集_NH.mkv');
    const f3b = touch(dir, 'report.docx');
    const p3b = await buildPlan(f3b, [rule('insert', { position: 'beforeText', text: '2024-', anchor: 'report' })], roots);
    assert.strictEqual(p3b.items[0].dstName, '2024-report.docx');
    const p3c = await buildPlan(f3b, [rule('insert', { position: 'replace', text: '结论' })], roots);
    assert.strictEqual(p3c.items[0].dstName, '结论.docx');

    // rearrange：负引用 $-1
    const f4 = touch(dir, 'A B C.txt');
    const p4 = await buildPlan(f4, [rule('rearrange', { mode: 'template', delimiter: ' ', pattern: '$-1 $1' })], roots);
    assert.strictEqual(p4.items[0].dstName, 'C A B.txt');

    // serialize：重复 + 字母 / 罗马数字
    const f5 = touch(dir, 'a.txt', 'b.txt', 'c.txt', 'd.txt');
    const p5 = await buildPlan(f5, [rule('serialize', { mode: 'prefix', start: 1, step: 1, repeat: 2, system: 'letters' })], roots);
    const names5 = p5.items.map((i) => i.dstName).sort();
    assert.deepStrictEqual(names5, ['aa.txt', 'ab.txt', 'bc.txt', 'bd.txt']);
    const p5b = await buildPlan(f5, [rule('serialize', { mode: 'suffix', start: 1, step: 1, system: 'roman' })], roots);
    const names5b = p5b.items.map((i) => i.dstName).sort();
    assert.deepStrictEqual(names5b, ['aI.txt', 'bII.txt', 'cIII.txt', 'dIV.txt']);

    // extension：追加
    const p6 = await buildPlan(f3b, [rule('extension', { mode: 'append', value: 'bak' })], roots);
    assert.strictEqual(p6.items[0].dstName, 'report.docx.bak');

    // strip：仅删开头的字符
    const f7 = touch(dir, '__hello__.txt');
    const p7 = await buildPlan(f7, [rule('strip', { trim: false, collapseSpaces: false, removeChars: '_', where: 'leading' })], roots);
    assert.strictEqual(p7.items[0].dstName, 'hello__.txt');

    // cleanup：括号内容 + 驼峰加空格
    const f8 = touch(dir, 'video (1080p) [x264] CamelCase.txt');
    const p8 = await buildPlan(f8, [rule('cleanup', { replaceWith: '_', collapse: false, trimEnds: false, stripBrackets: true, camelSpace: true })], roots);
    assert.strictEqual(p8.items[0].dstName, 'video   Camel Case.txt');

    // padding：去前导零
    const f9 = touch(dir, '007.txt');
    const p9 = await buildPlan(f9, [rule('padding', { length: 0, char: '0', align: 'left', stripZeros: true })], roots);
    assert.strictEqual(p9.items[0].dstName, '7.txt');

    // case：首字母大写（保留其余）
    const f10 = touch(dir, 'hello WORLD foo.txt');
    const p10 = await buildPlan(f10, [rule('case', { mode: 'capitalize' })], roots);
    assert.strictEqual(p10.items[0].dstName, 'Hello WORLD Foo.txt');

    // userinput：按行替换
    const f11 = touch(dir, 'IMG_0001.jpg', 'IMG_0002.jpg');
    const p11 = await buildPlan(f11, [rule('userinput', { mode: 'replace', lines: '日落\n日出' })], roots);
    const names11 = p11.items.map((i) => i.dstName).sort();
    assert.deepStrictEqual(names11, ['日出.jpg', '日落.jpg']);

    // remove：区间删到末尾（长度留空）
    const f12 = touch(dir, 'name_suffix.txt');
    const p12 = await buildPlan(f12, [rule('remove', { mode: 'range', from: 5, count: 0 })], roots);
    assert.strictEqual(p12.items[0].dstName, 'name.txt');

    ok('remove/last、replace/last、insert 锚点、$-1、letters/roman 编号、追加扩展名、strip 位置、括号清理、去零、用户输入、区间删到末尾');
  }

  /* ---------- 12. 递归扫描目录（本次 fork 的新增能力） ---------- */
  console.log('12) 递归扫描目录（含子目录 / 隐藏文件 / 符号链接 / 上限 / 跨目录重命名）');
  {
    const { dir, roots } = await newWorkspace();
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.hiddenDir'), { recursive: true });
    touch(dir, 'root.txt', '.hidden.txt');
    touch(path.join(dir, 'a'), 'x.txt');
    touch(path.join(dir, 'a', 'b'), 'y.txt');
    touch(path.join(dir, '.hiddenDir'), 'h.txt');

    // 非递归：只收集当前目录下的文件
    const nonRecursive = scanDirectory(dir, roots, { recursive: false });
    assert.deepStrictEqual(nonRecursive.files.map((f) => f.rel), ['root.txt']);

    // 递归 + 默认跳过隐藏文件；结果按相对路径稳定排序
    const rec = scanDirectory(dir, roots);
    assert.deepStrictEqual(rec.files.map((f) => f.rel).sort(), ['a/b/y.txt', 'a/x.txt', 'root.txt'].sort());
    assert.strictEqual(rec.hiddenSkipped, 2, '应记下 1 个隐藏文件 + 1 个隐藏目录');
    assert.strictEqual(rec.truncated, false);
    // 展示路径带根目录名，便于前端区分
    assert.strictEqual(rec.files[0].display.split('/')[0], path.basename(dir));

    // 显式包含隐藏文件
    const withHidden = scanDirectory(dir, roots, { includeHidden: true });
    assert.deepStrictEqual(
      withHidden.files.map((f) => f.rel).sort(),
      ['.hidden.txt', '.hiddenDir/h.txt', 'a/b/y.txt', 'a/x.txt', 'root.txt'].sort(),
    );

    // 符号链接：跳过，避免逃逸根目录、环和重复收集
    let linkMade = false;
    try {
      fs.symlinkSync(path.join(dir, 'root.txt'), path.join(dir, 'link-to-root.txt'));
      fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'link-to-a'));
      linkMade = true;
    } catch {
      /* 某些文件系统/权限下不允许建符号链接，跳过该子测试 */
    }
    if (linkMade) {
      const linked = scanDirectory(dir, roots);
      assert.ok(!linked.files.some((f) => f.name === 'link-to-root.txt'), '符号链接文件不应被收集');
      assert.strictEqual(linked.files.filter((f) => f.rel === 'a/x.txt').length, 1, '符号链接目录不应重复收集');
    }

    // 数量上限
    const limited = scanDirectory(dir, roots, { limit: 2 });
    assert.strictEqual(limited.files.length, 2);
    assert.strictEqual(limited.truncated, true);

    // 跨子目录同名文件：不是冲突（目标仍在各自目录里），且能正常执行 / 撤销
    fs.mkdirSync(path.join(dir, 'c1'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'c2'), { recursive: true });
    const f1 = touch(path.join(dir, 'c1'), 'same.txt')[0];
    const f2 = touch(path.join(dir, 'c2'), 'same.txt')[0];
    const scanAll = scanDirectory(dir, roots);
    const same = scanAll.files.filter((f) => f.name === 'same.txt');
    assert.strictEqual(same.length, 2);

    const plan = await buildPlan(same.map((f) => f.path), [rule('insert', { position: 'prefix', text: 'n_' })], roots);
    assert.strictEqual(plan.summary.conflict, 0, '不同目录下的同名文件不应互相冲突');
    assert.strictEqual(plan.summary.canApply, true);
    assert.strictEqual(plan.items.length, 2);
    // 预览项的展示路径带上了子目录，前端可区分
    assert.ok(plan.items.every((i) => i.srcDisplay?.includes('/c1/') || i.srcDisplay?.includes('/c2/')));

    const applied = applyPlan(plan.items, plan.root, true);
    assert.strictEqual(applied.renamed.length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'c1', 'n_same.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'c2', 'n_same.txt')));

    const journal = getJournal(applied.journalId!);
    assert.ok(journal);
    const undone = undoJournal(journal!.entries);
    markJournalUndone(journal!.id);
    assert.strictEqual(undone.renamed.length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'c1', 'same.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'c2', 'same.txt')));

    ok('递归扫描 + 隐藏文件开关 + 符号链接跳过 + 上限截断 + 跨目录同名可正常改名/撤销');
  }

  console.log(`\n全部通过：${passed} 项\n`);
}

main().catch((e) => {
  console.error('\n冒烟测试失败：', e);
  process.exit(1);
});
