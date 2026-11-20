// Run with: npm test
// Lane assignment for the commit graph (src/graph.ts; Node strips the types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANE_COLORS, MAIN_COLOR_BY_GROUP, computeGraph, findMainLines } from '../src/graph.ts';

const c = (hash, ...parents) => ({ hash, parents, author: 'a', email: 'a@b.c', date: 0, refsRaw: '', subject: hash });
const cols = (data) => Object.fromEntries(data.rows.map((r) => [r.commit.hash, r.col]));
const group = (name) => (name === 'dev' ? 0 : name === 'main' ? 1 : 2);
const signature = (name) => MAIN_COLOR_BY_GROUP[group(name)];

// a feature branch (F2, F1) cut from dev's D2, while dev moved on to D3. Newest first.
const history = [c('F2', 'F1'), c('F1', 'D2'), c('D3', 'D2'), c('D2', 'D1'), c('D1')];

test('without options the graph is the plain lane layout', () => {
  const g = computeGraph(history);
  assert.equal(g.hasMain, false);
  assert.ok(g.rows.every((r) => !r.main && r.segs.every((s) => !s.main)));
  assert.deepEqual(cols(g), { F2: 0, F1: 0, D3: 1, D2: 0, D1: 0 }, 'dev jumps between lanes: D3 sits right of D2');
  // a linear history stays in one lane
  assert.deepEqual(Object.values(cols(computeGraph([c('3', '2'), c('2', '1'), c('1')]))), [0, 0, 0]);
});

test('main lines follow the first parents of each main branch tip, newest tip first', () => {
  const { main, primary } = findMainLines(history, [
    { name: 'dev', hash: 'D3' },
    { name: 'main', hash: 'D1' },
    { name: 'nowhere', hash: 'not-loaded' },
  ]);
  assert.deepEqual([...main.entries()], [['D3', 'dev'], ['D2', 'dev'], ['D1', 'dev']], 'the first tip claims the shared history');
  assert.deepEqual([...primary].sort(), ['D1', 'D2', 'D3']);
  assert.equal(main.has('F1'), false);
});

test('a merge brings in a second main line, which keeps its own name', () => {
  // dev merges main (second parent): M -> D1 (first) and M2
  const list = [c('M', 'D1', 'X2'), c('D1', 'D0'), c('X2', 'X1'), c('X1', 'D0'), c('D0')];
  const { main } = findMainLines(list, [{ name: 'dev', hash: 'M' }, { name: 'main', hash: 'X2' }]);
  assert.equal(main.get('D1'), 'dev');
  assert.equal(main.get('X2'), 'main');
  assert.equal(main.get('X1'), 'main');
  assert.equal(main.get('D0'), 'dev', 'the shared ancestor goes to whichever line reached it first');
});

test('pinning keeps the main line in lane 0, whatever feature branches do', () => {
  const { main, primary } = findMainLines(history, [{ name: 'dev', hash: 'D3' }]);
  const g = computeGraph(history, { main, pin: primary });
  assert.deepEqual(cols(g), { F2: 1, F1: 1, D3: 0, D2: 0, D1: 0 });
  assert.equal(g.hasMain, true);
  assert.deepEqual(g.rows.map((r) => !!r.main), [false, false, true, true, true]);
});

test('segments know whether they belong to a main line', () => {
  const { main, primary } = findMainLines(history, [{ name: 'dev', hash: 'D3' }]);
  const g = computeGraph(history, { main, pin: primary });
  const row = (h) => g.rows.find((r) => r.commit.hash === h);
  // F1: the feature lane passes through and nothing is main yet
  assert.ok(row('F1').segs.every((s) => !s.main));
  // D3 is the dev tip: the feature lane passing beside it is thin, its own line down is main
  const d3 = row('D3');
  assert.ok(d3.segs.some((s) => s.x1 === 1 && s.x2 === 1 && s.main === false), 'the feature lane stays ordinary');
  assert.ok(d3.segs.some((s) => s.x1 === 0 && s.y1 === 0.5 && s.main === true), 'dev continues as the main line');
  // D2: the feature lane merges into the main line; only the main line itself is thick
  const d2 = row('D2');
  const joining = d2.segs.find((s) => s.x1 === 1 && s.x2 === 0);
  assert.equal(joining.main, false, 'the feature branch joining is not a main line');
  assert.ok(d2.segs.some((s) => s.x1 === 0 && s.y1 === 0 && s.main === true), 'dev lane entering from above is main');
});

test('main lanes entering a row are listed with their branch name, for the chips', () => {
  const { main, primary } = findMainLines(history, [{ name: 'dev', hash: 'D3' }]);
  const g = computeGraph(history, { main, pin: primary });
  assert.deepEqual(g.rows[0].mainLanes, [], 'nothing above the dev tip');
  assert.deepEqual(g.rows[3].mainLanes.map((l) => [l.lane, l.name]), [[0, 'dev']], 'D2 is entered by the dev lane');
});

test('fixed colours: main lines keep their signature colour and ordinary lanes never borrow it', () => {
  const list = [c('F3', 'F2'), c('F2', 'F1'), c('G2', 'G1'), c('F1', 'D2'), c('G1', 'D2'), c('D3', 'D2'), c('D2', 'D1'), c('D1')];
  const { main, primary } = findMainLines(list, [{ name: 'dev', hash: 'D3' }]);
  const g = computeGraph(list, { main, pin: primary, fixedColors: signature });
  const reserved = new Set(MAIN_COLOR_BY_GROUP);
  for (const r of g.rows) {
    if (r.main) assert.equal(r.color, signature('dev'), r.commit.hash);
    else assert.ok(!reserved.has(r.color), `${r.commit.hash} must not use a main colour`);
  }
  for (const s of g.rows.flatMap((r) => r.segs).filter((s) => !s.main)) {
    assert.ok(s.color < LANE_COLORS.length);
  }
});

test('without fixed colours the palette rotates as before', () => {
  const { main, primary } = findMainLines(history, [{ name: 'dev', hash: 'D3' }]);
  const plain = computeGraph(history, { main });
  const base = computeGraph(history);
  assert.deepEqual(plain.rows.map((r) => r.color), base.rows.map((r) => r.color));
  assert.ok(primary.size > 0);
});

test('a second pinned line does not disturb the first: only the topmost main tip is pinned', () => {
  // main (X1) lives on its own line; dev (D2) is the topmost tip and gets lane 0
  const list = [c('D2', 'D1'), c('X1', 'X0'), c('D1'), c('X0')];
  const { main, primary } = findMainLines(list, [{ name: 'dev', hash: 'D2' }, { name: 'main', hash: 'X1' }]);
  assert.deepEqual([...primary].sort(), ['D1', 'D2']);
  const g = computeGraph(list, { main, pin: primary });
  assert.equal(g.rows[0].col, 0);
  assert.equal(g.rows[1].col, 1, 'main is a main line but not pinned: it takes the next lane');
  assert.equal(g.rows[1].main, true);
});

test('a repository with no main branch loaded behaves like the plain graph', () => {
  const { main, primary } = findMainLines(history, []);
  assert.equal(main.size, 0);
  const g = computeGraph(history, { main, pin: primary.size ? primary : undefined, fixedColors: signature });
  assert.equal(g.hasMain, false);
  assert.deepEqual(cols(g).F2, 0);
});

test('pinning: the main tip goes to lane 0 even when a feature branch was cut from that very commit', () => {
  // F2 -> F1 -> D3 (dev tip, the feature branch started here) -> D2 -> D1; a stash-like row also hangs off D3
  const list = [c('S', 'D3'), c('F2', 'F1'), c('F1', 'D3'), c('D3', 'D2'), c('D2', 'D1'), c('D1')];
  const { main, primary } = findMainLines(list, [{ name: 'dev', hash: 'D3' }]);
  const g = computeGraph(list, { main, pin: primary });
  const col = cols(g);
  assert.equal(col.D3, 0, 'the main tip must not land on the feature branch lane');
  assert.equal(col.D2, 0);
  assert.equal(col.D1, 0);
  assert.ok(col.S >= 1 && col.F2 >= 1 && col.F1 >= 1, 'nothing else may use lane 0 above the tip');
  // the feature lanes join the main lane at the tip
  const d3 = g.rows.find((r) => r.commit.hash === 'D3');
  assert.ok(d3.segs.some((s) => s.y2 === 0.5 && s.x1 === 1 && s.x2 === 0), 'the waiting lane curves into the node in lane 0');
});

import { bandSpans, branchNamesOf, mergeSourceName } from '../src/graph.ts';

const tip = (hash, refsRaw, ...parents) => ({ ...c(hash, ...parents), refsRaw });

// n branches of two commits each, all open at the same time (every tip is listed before any second commit)
const parallel = (n, name = (i) => undefined) => [
  ...Array.from({ length: n }, (_, i) => tip(`T${i}`, name(i) ?? '', `U${i}`)),
  ...Array.from({ length: n }, (_, i) => c(`U${i}`, 'B')),
  c('B'),
];
const tipRows = (g, n) => g.rows.filter((r) => r.commit.hash.startsWith('T')).slice(0, n);

test('lanes running side by side never share a colour while the palette lasts', () => {
  const n = 10;
  for (const fixed of [undefined, signature]) {
    const g = computeGraph(parallel(n), { fixedColors: fixed });
    const colors = tipRows(g, n).map((r) => r.color);
    assert.equal(new Set(g.rows.slice(0, n).map((r) => r.col)).size, n, 'really ten lanes at once');
    assert.equal(new Set(colors).size, n, 'all ten lanes have their own colour');
    if (fixed) assert.ok(colors.every((x) => !MAIN_COLOR_BY_GROUP.includes(x)), 'and none borrows a main colour');
  }
});

test('when the palette runs out colours repeat, but only then', () => {
  const n = LANE_COLORS.length + 3;
  const g = computeGraph(parallel(n));
  const colors = tipRows(g, n).map((r) => r.color);
  assert.equal(colors.every((x) => x >= 0 && x < LANE_COLORS.length), true);
  assert.equal(new Set(colors.slice(0, LANE_COLORS.length)).size, LANE_COLORS.length, 'the first lanes use every colour once');
});

test('a colour is free again once its lane has ended', () => {
  // A and B run side by side; A ends; C then starts and may reuse A's colour
  const list = [tip('A2', 'x', 'A1'), tip('B2', 'y', 'B1'), c('A1'), tip('C1', 'z', 'C0'), c('B1'), c('C0')];
  const g = computeGraph(list);
  const color = (h) => g.rows.find((r) => r.commit.hash === h).color;
  assert.notEqual(color('A2'), color('B2'));
  assert.ok(color('C1') >= 0);
});

test('the same branch name starts from the same colour in every graph', () => {
  const one = computeGraph([tip('F2', 'feature/RH/add_user', 'F1'), c('F1')]);
  const two = computeGraph([c('X1', 'X0'), tip('F9', 'origin/feature/RH/add_user, feature/RH/add_user', 'F8'), c('F8'), c('X0')], { remotes: ['origin'] });
  assert.equal(one.rows[0].color, two.rows.find((r) => r.commit.hash === 'F9').color);
});

test('branch names are read from decorations, local first, without the remote prefix', () => {
  assert.deepEqual(branchNamesOf('HEAD -> dev, tag: v1, origin/dev, origin/feature/x, feature/y', ['origin']), ['dev', 'feature/y', 'feature/x']);
  assert.deepEqual(branchNamesOf('', ['origin']), []);
  assert.deepEqual(branchNamesOf('tag: v1', ['origin']), []);
});

test('a merge commit message names the branch it brought in', () => {
  assert.equal(mergeSourceName("Merge branch 'feature/x' into dev", []), 'feature/x');
  assert.equal(mergeSourceName("Merge remote-tracking branch 'origin/feature/x'", ['origin']), 'feature/x');
  assert.equal(mergeSourceName('Merge pull request #12 from alice/feature/login', []), 'feature/login');
  assert.equal(mergeSourceName('Merged PR 1703: Appsettings', []), undefined);
  assert.equal(mergeSourceName('Fix things', []), undefined);
});

test('every row and segment knows its branch, for the hover label', () => {
  const list = [
    tip('F2', 'feature/x', 'F1'),
    tip('D3', 'dev', 'D2'),
    c('F1', 'D2'),
    c('D2', 'D1'),
    c('D1'),
  ];
  const g = computeGraph(list);
  const row = (h) => g.rows.find((r) => r.commit.hash === h);
  assert.equal(row('F2').branch, 'feature/x');
  assert.equal(row('F1').branch, 'feature/x', 'the lane keeps its name down to where it joins');
  assert.equal(row('D3').branch, 'dev');
  assert.equal(row('D2').branch, 'dev', 'where two lanes meet, the commit is on the lane it sits on');
  assert.ok(row('F1').segs.every((s) => s.name === 'feature/x' || s.name === 'dev'));
  // merged branches without a tip are named after the merge message
  const merged = computeGraph([{ ...c('M', 'P', 'Q'), subject: "Merge branch 'feature/gone' into dev" }, c('P'), c('Q')]);
  assert.equal(merged.rows.find((r) => r.commit.hash === 'Q').branch, 'feature/gone');
});

test('the band follows the main line only: it starts at its first commit and ends at its last', () => {
  const { main, primary } = findMainLines(history, [{ name: 'dev', hash: 'D3' }]);
  const g = computeGraph(history, { main, pin: primary });
  const spans = (h) => bandSpans(g.rows.find((r) => r.commit.hash === h)).map((s) => [s.lane, s.from, s.to]);
  assert.deepEqual(spans('F2'), [], 'nothing above the tip');
  assert.deepEqual(spans('F1'), []);
  assert.deepEqual(spans('D3'), [[0, 0.5, 1]], 'starts in the middle of the first commit');
  assert.deepEqual(spans('D2'), [[0, 0, 0.5], [0, 0.5, 1]], 'runs through');
  assert.deepEqual(spans('D1'), [[0, 0, 0.5]], 'stops in the middle of the last commit');
});

import { colorDistance } from '../src/graph.ts';

test('lanes side by side get colours that are clearly different, not just different numbers', () => {
  const n = 6;
  const g = computeGraph(parallel(n, (i) => `feature/team${i}/work_item_${i}`), { fixedColors: signature });
  const colors = tipRows(g, n).map((r) => r.color);
  assert.equal(new Set(g.rows.slice(0, n).map((r) => r.col)).size, n, 'six lanes at once');
  let worst = Infinity;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) worst = Math.min(worst, colorDistance(colors[i], colors[j]));
  assert.ok(worst >= 60, `the two most alike of six lanes are ${Math.round(worst)} apart`);
  assert.equal(colorDistance(2, 2), 0);
  assert.ok(colorDistance(2, 4) > 90, 'orange and blue are clearly different');
});

// ---- a lane is coloured by the lowest (oldest) branch on it ----

/** the colour of the row of commit `h` */
const colorOf = (g, h) => g.rows.find((r) => r.commit.hash === h).color;
// a lone branch: the colour its name gives it when nothing else is around
const alone = (name) => computeGraph([tip('S2', name, 'S1'), c('S1')]).rows[0].color;

test('stacking a branch on top of another leaves the lane in the lower branch\'s colour', () => {
  const base = computeGraph([tip('S2', 'feature/base', 'S1'), c('S1', 'D'), c('D')]);
  const stacked = computeGraph([
    tip('T2', 'feature/top', 'T1'),
    c('T1', 'S2'),
    tip('S2', 'feature/base', 'S1'),
    c('S1', 'D'),
    c('D'),
  ]);
  const colors = ['T2', 'T1', 'S2', 'S1', 'D'].map((h) => colorOf(stacked, h));
  assert.equal(new Set(colors).size, 1, 'one lane, one colour from top to bottom');
  assert.equal(colors[0], colorOf(base, 'S2'), 'the colour the base branch had before anything was stacked on it');
  assert.equal(colors[0], alone('feature/base'));
});

test('the name of the branch on top has no say in the colour', () => {
  const stackedWith = (top) => computeGraph([tip('T2', top, 'T1'), c('T1', 'S2'), tip('S2', 'feature/base', 'S1'), c('S1')]);
  const expected = alone('feature/base');
  for (const top of ['feature/top', 'fix/other', 'origin/feature/zzz', 'a', 'feature/JSM/add_telemetry_units_page']) {
    assert.equal(colorOf(stackedWith(top), 'T2'), expected, top);
  }
});

test('with several branches stacked, the lowest one decides', () => {
  const g = computeGraph([tip('C1', 'c', 'B2'), tip('B2', 'b', 'B1'), tip('B1', 'a', 'A1'), c('A1')]);
  const expected = alone('a');
  for (const h of ['C1', 'B2', 'B1', 'A1']) assert.equal(colorOf(g, h), expected, h);
});

test('a lane keeps one colour in its rows and in the segments drawn through them', () => {
  const g = computeGraph([tip('T2', 'feature/top', 'T1'), c('T1', 'S2'), tip('S2', 'feature/base', 'S1'), c('S1')]);
  const lane = alone('feature/base');
  for (const row of g.rows) {
    assert.equal(row.color, lane, row.commit.hash);
    for (const s of row.segs) assert.equal(s.color, lane, `${row.commit.hash} segment`);
  }
});

test('a lane with no branch name at all is coloured from the merge message, as before', () => {
  const merged = computeGraph([{ ...c('M', 'P', 'Q'), subject: "Merge branch 'feature/gone' into dev" }, c('P'), c('Q')]);
  assert.equal(colorOf(merged, 'Q'), alone('feature/gone'));
});

test('a branch cut from a commit on another lane keeps its own colour', () => {
  // dev (main line, fixed colour) and a feature branch cut from D1: the feature lane runs on its own down to D1
  const list = [tip('F2', 'feature/x', 'F1'), c('F1', 'D1'), tip('D2', 'dev', 'D1'), c('D1', 'D0'), c('D0')];
  const { main, primary } = findMainLines(list, [{ name: 'dev', hash: 'D2' }]);
  const g = computeGraph(list, { main, pin: primary, fixedColors: signature });
  assert.equal(colorOf(g, 'F2'), alone('feature/x'));
  assert.equal(colorOf(g, 'F1'), alone('feature/x'));
  assert.equal(colorOf(g, 'D2'), signature('dev'));
  assert.equal(colorOf(g, 'D1'), signature('dev'), 'where it joins dev the line is dev\'s again');
});

test('a main line without fixed colours stays in its own colour, whatever older branches sit on it', () => {
  // dev's first-parent line carries an older release/1.0 label further down
  const list = [tip('D3', 'dev', 'D2'), c('D2', 'D1'), tip('D1', 'release/1.0', 'D0'), c('D0')];
  const { main, primary } = findMainLines(list, [{ name: 'dev', hash: 'D3' }]);
  const g = computeGraph(list, { main, pin: primary });
  const expected = alone('dev');
  for (const h of ['D3', 'D2', 'D1', 'D0']) assert.equal(colorOf(g, h), expected, h);
});

test('stacked lanes next to other lanes still get colours that stand out from them', () => {
  // two stacks side by side, bases named so their colours would clash: the neighbour rule still applies
  const names = ['feature/aa/one', 'feature/bb/two', 'feature/cc/three', 'feature/dd/four'];
  const list = [
    ...names.map((n, i) => tip(`T${i}`, `top/${n}`, `M${i}`)),
    ...names.map((n, i) => tip(`M${i}`, n, `B`)),
    c('B'),
  ];
  const g = computeGraph(list);
  const colors = names.map((_, i) => colorOf(g, `T${i}`));
  assert.equal(new Set(colors).size, names.length, 'four lanes at once, four colours');
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) assert.ok(colorDistance(colors[i], colors[j]) >= 60);
});

test('a lane that turns into a main line changes colour where it reaches it', () => {
  // feature/x is cut from D2; without pinning, its lane carries on as dev's line from D2 downwards
  const list = [tip('F2', 'feature/x', 'F1'), c('F1', 'D2'), tip('D3', 'dev', 'D2'), c('D2', 'D1'), c('D1')];
  const { main } = findMainLines(list, [{ name: 'dev', hash: 'D3' }]);
  const g = computeGraph(list, { main, fixedColors: signature });
  const feature = alone('feature/x');
  assert.equal(colorOf(g, 'F2'), feature);
  assert.equal(colorOf(g, 'F1'), feature);
  assert.equal(colorOf(g, 'D3'), signature('dev'));
  assert.equal(colorOf(g, 'D2'), signature('dev'), 'dev\'s signature colour from the commit on dev');
  assert.equal(colorOf(g, 'D1'), signature('dev'));
  assert.notEqual(feature, signature('dev'), 'an ordinary lane never borrows a main colour');
  const d2 = g.rows.find((r) => r.commit.hash === 'D2');
  const into = d2.segs.find((s) => s.x1 === 0 && s.y1 === 0 && s.x2 === 0 && s.y2 === 0.5);
  const out = d2.segs.find((s) => s.x1 === 0 && s.y1 === 0.5 && s.x2 === 0 && s.y2 === 1);
  assert.equal(into.color, feature, 'the line arriving at D2 is still the feature branch\'s');
  assert.equal(out.color, signature('dev'), 'the line leaving it is dev\'s');
});

test('a branch name on a commit beats the branch a merge message names', () => {
  const merge = (subject, qRefs) => computeGraph([{ ...c('M', 'P', 'Q'), subject }, c('P'), { ...c('Q'), refsRaw: qRefs }]);
  const named = colorOf(merge("Merge branch 'feature/other' into dev", 'feature/real'), 'Q');
  const plain = colorOf(merge('Merge', 'feature/real'), 'Q');
  assert.equal(named, plain, 'the merge message is only used when no commit on the lane has a branch name');
  assert.notEqual(alone('feature/other'), alone('feature/real'), 'the two names really do give different colours');
});

test('loading older history can recolour a lane when it brings in a lower branch name', () => {
  // only what is loaded counts: with the older commits the lowest branch on the lane is another one
  const recent = [tip('N2', 'feature/new', 'N1'), c('N1', 'O1')];
  const older = [...recent, tip('O1', 'feature/old', 'O0'), c('O0')];
  assert.notEqual(alone('feature/new'), alone('feature/old'), 'the two names really do give different colours');
  assert.equal(colorOf(computeGraph(recent), 'N2'), alone('feature/new'));
  assert.equal(colorOf(computeGraph(older), 'N2'), alone('feature/old'));
});
