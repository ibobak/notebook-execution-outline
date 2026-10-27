'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseHeaders, boldText, buildTree, sortNodes, computeMarks, ExecutionTracker, QUEUED_VISIBLE_MS, QUEUED_DROP_MS } = require('../lib/model');

const SHOW = { showMarkdownHeadersOnly: true, showCodeCells: true, showCodeCellSymbols: true };
const md = (key, text) => ({ kind: 'markup', key, text });
const code = (key, text = 'x = 1') => ({ kind: 'code', key, text });

// A header
// - B header
// - C header
// -- cell 1
// -- cell 2
// - D
const CELLS = [
    md('m1', '# A header'),
    md('m2', '## B header'),
    md('m3', '## C header'),
    code('c1'),
    code('c2'),
    md('m4', '## D'),
    code('c3'),
];

const queued = { executionOrder: null, success: null, timing: undefined };
const started = order => ({ executionOrder: order, success: null, timing: undefined });
const finished = order => ({ executionOrder: order, success: true, timing: { startTime: 1, endTime: 2 } });

function labelsOf(tree, marks) {
    const out = [];
    const walk = nodes => nodes.forEach(n => {
        if (marks.has(n.id)) {
            out.push(n.label);
        }
        walk(n.children);
    });
    walk(tree.roots);
    return out;
}

test('parseHeaders skips fenced code and strips inline markup', () => {
    const text = '# **Top** `x`\n```\n# not a header\n```\n### [Link](http://a) ##\n#nospace';
    assert.deepStrictEqual(parseHeaders(text), [
        { level: 1, text: 'Top x' },
        { level: 3, text: 'Link' },
    ]);
});

test('tree nests headers by level and places code cells under the last header', () => {
    const tree = buildTree(CELLS, SHOW);
    assert.strictEqual(tree.roots.length, 1);
    const a = tree.roots[0];
    assert.deepStrictEqual(a.children.map(n => n.label), ['B header', 'C header', 'D']);
    assert.strictEqual(a.children[1].children.length, 2);
    assert.strictEqual(tree.cellParent.get('c2').label, 'C header');
    assert.strictEqual(tree.cellParent.get('c3').label, 'D');
});

test('executing cell 2 highlights C and A (and the cell), not B or D', () => {
    const tree = buildTree(CELLS, SHOW);
    const t = new ExecutionTracker();
    t.update('c2', 'nb', queued, 0);
    t.update('c2', 'nb', started(5), 10);
    const marks = computeMarks(tree, k => t.stateOf(k, 20, false));
    assert.deepStrictEqual(labelsOf(tree, marks), ['A header', 'C header', 'x = 1']);
    assert.strictEqual(marks.get('c2'), 'executing');
    assert.ok(!marks.has('c1'));
});

test('highlights ancestors even when code cells are hidden', () => {
    const tree = buildTree(CELLS, { ...SHOW, showCodeCells: false });
    const t = new ExecutionTracker();
    t.update('c2', 'nb', queued, 0);
    t.update('c2', 'nb', started(5), 10);
    const marks = computeMarks(tree, k => t.stateOf(k, 20, false));
    assert.deepStrictEqual(labelsOf(tree, marks), ['A header', 'C header']);
});

test('finishing execution clears the highlight', () => {
    const t = new ExecutionTracker();
    t.update('c2', 'nb', queued, 0);
    t.update('c2', 'nb', started(5), 10);
    t.update('c2', 'nb', finished(5), 30);
    assert.strictEqual(t.stateOf('c2', 40, true), undefined);
});

const failedSummary = order => ({ executionOrder: order, success: false, timing: { startTime: 1, endTime: 2 } });

test('a failing cell is marked (with its headers) after a multi-cell run', () => {
    const tree = buildTree(CELLS, SHOW);
    const t = new ExecutionTracker();
    t.update('c1', 'nb', queued, 0);
    t.update('c2', 'nb', queued, 0);
    t.update('c1', 'nb', started(1), 1);
    t.update('c1', 'nb', finished(1), 2);
    t.update('c2', 'nb', started(2), 3);
    assert.strictEqual(t.update('c2', 'nb', failedSummary(2), 4), true);
    const marks = computeMarks(tree, k => t.stateOf(k, 5, false));
    assert.deepStrictEqual(labelsOf(tree, marks), ['A header', 'C header', 'x = 1']);
    assert.strictEqual(marks.get('c2'), 'failed');
    assert.ok(!marks.has('c1'));
    assert.strictEqual(t.failedCell('nb'), 'c2');
});

test('there is at most one failure marker per notebook; a later failure replaces the earlier one', () => {
    const t = new ExecutionTracker();
    t.update('c1', 'nb', failedSummary(1), 0);
    t.update('c2', 'nb', failedSummary(2), 1);
    assert.strictEqual(t.stateOf('c1', 2, false), undefined);
    assert.strictEqual(t.stateOf('c2', 2, false), 'failed');
    t.update('x1', 'other', failedSummary(1), 3);
    assert.strictEqual(t.failedCell('nb'), 'c2', 'another notebook does not affect it');
    assert.strictEqual(t.update('x1', 'other', failedSummary(1), 4), false, 'same failure repeated is not a change');
});

test('a cell starting to execute clears the failure marker (queued alone does not)', () => {
    const t = new ExecutionTracker();
    t.update('c1', 'nb', failedSummary(1), 0);
    t.update('c3', 'nb', queued, 1);
    assert.strictEqual(t.stateOf('c1', 2, false), 'failed');
    assert.strictEqual(t.update('c3', 'nb', started(2), 3), true);
    assert.strictEqual(t.failedCell('nb'), undefined);
    assert.strictEqual(t.stateOf('c1', 4, false), undefined);

    // re-running the failed cell itself also clears it
    t.update('c1', 'nb', failedSummary(3), 5);
    t.update('c1', 'nb', queued, 6);
    t.update('c1', 'nb', started(4), 7);
    assert.strictEqual(t.failedCell('nb'), undefined);
});

test('failure marker is dropped when the cell is deleted, the notebook closed, or state reset', () => {
    const t = new ExecutionTracker();
    t.update('c1', 'nb', failedSummary(1), 0);
    t.forget('c1');
    assert.strictEqual(t.failedCell('nb'), undefined);
    t.update('c1', 'nb', failedSummary(1), 0);
    t.forgetNotebook('nb');
    assert.strictEqual(t.failedCell('nb'), undefined);
    t.update('c1', 'nb', failedSummary(1), 0);
    t.reset();
    assert.strictEqual(t.failedCell('nb'), undefined);
});

test('metadata edit on a cell that was never queued is not treated as executing', () => {
    const t = new ExecutionTracker();
    // e.g. renderDuration update on a cell loaded from the .ipynb file
    assert.strictEqual(t.update('c1', 'nb', started(3), 0), false);
    assert.strictEqual(t.stateOf('c1', 1, true), undefined);
});

test('output streaming while executing keeps the executing state', () => {
    const t = new ExecutionTracker();
    t.update('c1', 'nb', queued, 0);
    t.update('c1', 'nb', started(7), 1);
    assert.strictEqual(t.update('c1', 'nb', started(7), 2), false);
    assert.strictEqual(t.stateOf('c1', 3, false), 'executing');
});

test('queued cells are visible while notebook is busy, fade when idle, but can still start', () => {
    const t = new ExecutionTracker();
    t.update('c1', 'nb', queued, 0);
    t.update('c2', 'nb', queued, 0);
    t.update('c1', 'nb', started(1), 5);
    assert.strictEqual(t.stateOf('c2', 10 * QUEUED_VISIBLE_MS, true), 'queued');
    assert.strictEqual(t.stateOf('c2', 10, false), undefined, 'queued hidden unless the setting is on');

    // "Clear All Outputs" resets metadata like queueing does; it fades once the notebook is idle
    t.update('c9', 'nb2', queued, 0);
    assert.strictEqual(t.stateOf('c9', 1, true), 'queued');
    assert.strictEqual(t.stateOf('c9', QUEUED_VISIBLE_MS + 1, true), undefined);

    // kernel slow to start: a faded queued cell still becomes executing
    t.update('c9', 'nb2', started(1), QUEUED_VISIBLE_MS + 100);
    assert.strictEqual(t.stateOf('c9', QUEUED_VISIBLE_MS + 200, false), 'executing');
});

test('stale queued entries of an idle notebook are pruned', () => {
    const t = new ExecutionTracker();
    t.update('c1', 'nb', queued, 0);
    t.prune(QUEUED_DROP_MS + 1);
    assert.strictEqual(t.update('c1', 'nb', started(1), QUEUED_DROP_MS + 2), false);
});

test('sortNodes: position keeps notebook order, name is alphabetical, category puts headers first', () => {
    const tree = buildTree([md('m0', '# Z'), code('c0', 'b = 2'), md('m1', '# A'), code('c1', 'a = 1')], SHOW);
    assert.deepStrictEqual(sortNodes(tree.roots, 'position').map(n => n.label), ['Z', 'A']);
    assert.deepStrictEqual(sortNodes(tree.roots, 'name').map(n => n.label), ['A', 'Z']);
    const mixed = buildTree([code('c0', 'x0'), md('m1', '# H'), code('c2', 'x2')], SHOW).roots;
    assert.deepStrictEqual(sortNodes(mixed, 'category').map(n => n.label), ['H', 'x0']);
    assert.deepStrictEqual(sortNodes(mixed, 'position').map(n => n.label), ['x0', 'H']);
});

test('anchor maps every cell to the tree item Follow Cursor should select', () => {
    const cells = [...CELLS, md('m5', 'plain text, no header')];
    const shown = buildTree(cells, SHOW);
    assert.strictEqual(shown.anchor.get('c2').id, 'c2');
    assert.strictEqual(shown.anchor.get('m3').label, 'C header');
    assert.strictEqual(shown.anchor.get('m5').label, 'D');
    const hidden = buildTree(cells, { ...SHOW, showCodeCells: false });
    assert.strictEqual(hidden.anchor.get('c2').label, 'C header');
});

test('Markdown Headers Only off lists markdown cells without headers', () => {
    const cells = [md('m1', '# A'), md('m2', 'Some **notes** here\nmore'), code('c1')];
    assert.deepStrictEqual(buildTree(cells, SHOW).roots[0].children.map(n => n.label), ['x = 1']);
    const tree = buildTree(cells, { ...SHOW, showMarkdownHeadersOnly: false });
    assert.deepStrictEqual(tree.roots[0].children.map(n => [n.kind, n.label]), [['markdown', 'Some notes here'], ['cell', 'x = 1']]);
    assert.strictEqual(tree.anchor.get('m2').kind, 'markdown');
});

test('Code Cell Symbols adds nested symbols under code cells only when enabled', () => {
    const symbols = { c1: [{ name: 'Model', kind: 4, range: 'r1', children: [{ name: 'fit', kind: 5, range: 'r2' }] }, { name: 'df', kind: 12, range: 'r3' }] };
    const opts = { ...SHOW, symbolsOf: k => symbols[k] };
    const cell = buildTree(CELLS, opts).cellNode.get('c1');
    assert.deepStrictEqual(cell.children.map(n => n.label), ['Model', 'df']);
    assert.deepStrictEqual(cell.children[0].children.map(n => [n.kind, n.label, n.range]), [['symbol', 'fit', 'r2']]);
    assert.strictEqual(buildTree(CELLS, { ...opts, showCodeCellSymbols: false }).cellNode.get('c1').children.length, 0);
    // category sort: symbols by kind (Class=4 before Variable=12); name sort alphabetical
    assert.deepStrictEqual(sortNodes([...cell.children].reverse(), 'category').map(n => n.label), ['Model', 'df']);
    assert.deepStrictEqual(sortNodes(cell.children, 'name').map(n => n.label), ['df', 'Model']);
});

test('header labels keep underscores and other literal characters', () => {
    const labels = t => parseHeaders(t).map(h => h.text);
    assert.deepStrictEqual(labels('# BANNER_ID aggregates'), ['BANNER_ID aggregates']);
    assert.deepStrictEqual(labels('## RC_BANNER_TRAIN and __init__ `__x__`'), ['RC_BANNER_TRAIN and init __x__']);
    assert.deepStrictEqual(labels('# _italic_ and __bold__ and *x* and **y**'), ['italic and bold and x and y']);
    assert.deepStrictEqual(labels('# x < y > z, a\\_b'), ['x < y > z, a_b']);
});

test('boldText maps ASCII letters and digits to bold sans-serif and leaves the rest', () => {
    assert.strictEqual(boldText('Az09 _x!é'), '𝗔𝘇𝟬𝟵 _𝘅!é');
});
