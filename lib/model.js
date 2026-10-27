'use strict';

// Pure logic (no vscode dependency) so it can be unit-tested with plain node.

const HEADER_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// A queued cell is shown as queued only while the notebook is busy or shortly after it was queued.
// This hides cells whose metadata was reset by "Clear All Outputs" (looks identical to queueing).
const QUEUED_VISIBLE_MS = 3000;
// Queued entries of an idle notebook are forgotten after this long.
const QUEUED_DROP_MS = 120000;

function cleanInline(text) {
    // Code spans are kept verbatim: pull them out before stripping emphasis, put them back after.
    const spans = [];
    return text
        .replace(/`([^`]*)`/g, (m, code) => '\u0000' + (spans.push(code) - 1) + '\u0000')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<\/?[A-Za-z][^>]*>/g, '')
        // emphasis only: ** / * anywhere, __ / _ only at word boundaries (so BANNER_ID keeps its underscore)
        .replace(/(\*\*|\*)(?=\S)(.+?)(?<=\S)\1/g, '$2')
        .replace(/(^|[^\w])(__|_)(?=\S)(.+?)(?<=\S)\2(?!\w)/g, '$1$3')
        .replace(/\\([\\`*_{}\[\]()#+\-.!<>])/g, '$1')
        .replace(/\u0000(\d+)\u0000/g, (m, i) => spans[i])
        .trim();
}

function parseHeaders(text) {
    const headers = [];
    let fence = null;
    for (const line of text.split(/\r?\n/)) {
        const f = FENCE_RE.exec(line);
        if (f) {
            if (!fence) {
                fence = f[1];
            } else if (f[1][0] === fence[0] && f[1].length >= fence.length) {
                fence = null;
            }
            continue;
        }
        if (fence) {
            continue;
        }
        const m = HEADER_RE.exec(line);
        if (m) {
            const label = cleanInline(m[2]);
            if (label) {
                headers.push({ level: m[1].length, text: label });
            }
        }
    }
    return headers;
}

/** Letters and digits as Unicode bold sans-serif: tree labels can't be styled bold, but these glyphs look bold. */
function boldText(text) {
    return text.replace(/[A-Za-z0-9]/g, ch => {
        const c = ch.charCodeAt(0);
        const base = c >= 97 ? 0x1D5EE - 97 : c >= 65 ? 0x1D5D4 - 65 : 0x1D7EC - 48;
        return String.fromCodePoint(c + base);
    });
}

function firstLine(text) {
    const line = text.split(/\r?\n/).find(l => l.trim()) || '<empty cell>';
    const trimmed = line.trim();
    return trimmed.length > 80 ? trimmed.slice(0, 79) + '…' : trimmed;
}

/**
 * cells: [{ kind: 'markup' | 'code', text, key }]
 * opts: { showMarkdownHeadersOnly, showCodeCells, showCodeCellSymbols, symbolsOf(cellKey) -> [{ name, kind, range, children }] }
 * Returns { roots, cellParent: Map<codeCellKey, headerNode|null>, cellNode: Map<codeCellKey, cellNode>,
 *           anchor: Map<anyCellKey, node> (tree item that represents the cell, used by Follow Cursor) }
 * Node kinds: 'header', 'markdown' (markdown cell without a header), 'cell', 'symbol'.
 */
function buildTree(cells, opts) {
    const roots = [];
    const cellParent = new Map();
    const cellNode = new Map();
    const anchor = new Map();
    const stack = [];
    let order = 0;
    const top = () => (stack.length ? stack[stack.length - 1] : null);
    const newNode = (fields, parent) => {
        const node = { ...fields, order: order++, children: [], parent };
        (parent ? parent.children : roots).push(node);
        return node;
    };
    const addSymbols = (symbols, parent, cell, index, path) => {
        (symbols || []).forEach((sym, i) => {
            const node = newNode({
                id: cell.key + '#s' + path + i, kind: 'symbol', label: sym.name, symbolKind: sym.kind,
                range: sym.range, level: 8, cellIndex: index, cellKey: cell.key,
            }, parent);
            addSymbols(sym.children, node, cell, index, path + i + '.');
        });
    };

    cells.forEach((cell, index) => {
        if (cell.kind === 'markup') {
            const headers = parseHeaders(cell.text);
            headers.forEach((h, hi) => {
                while (stack.length && top().level >= h.level) {
                    stack.pop();
                }
                const node = newNode({
                    id: cell.key + '#h' + hi, kind: 'header', label: h.text, level: h.level,
                    cellIndex: index, cellKey: cell.key,
                }, top());
                stack.push(node);
                if (hi === 0) {
                    anchor.set(cell.key, node);
                }
            });
            if (!headers.length) {
                if (!opts.showMarkdownHeadersOnly) {
                    anchor.set(cell.key, newNode({
                        id: cell.key, kind: 'markdown', label: firstLine(cleanInline(cell.text)), level: 7,
                        cellIndex: index, cellKey: cell.key,
                    }, top()));
                } else if (top()) {
                    anchor.set(cell.key, top());
                }
            }
        } else {
            cellParent.set(cell.key, top());
            if (opts.showCodeCells) {
                const node = newNode({
                    id: cell.key, kind: 'cell', label: firstLine(cell.text), level: 7,
                    cellIndex: index, cellKey: cell.key,
                }, top());
                cellNode.set(cell.key, node);
                if (opts.showCodeCellSymbols && opts.symbolsOf) {
                    addSymbols(opts.symbolsOf(cell.key), node, cell, index, '');
                }
            }
            const target = cellNode.get(cell.key) || top();
            if (target) {
                anchor.set(cell.key, target);
            }
        }
    });
    return { roots, cellParent, cellNode, anchor };
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const CATEGORY = { header: 0, markdown: 1, cell: 2, symbol: 3 };

/** sortBy: 'position' (notebook order), 'name' (alphabetical), 'category' (headers, markdown, code cells, symbols by kind). */
function sortNodes(nodes, sortBy) {
    const byPosition = (a, b) => a.order - b.order;
    if (sortBy === 'name') {
        return [...nodes].sort((a, b) => COLLATOR.compare(a.label, b.label) || byPosition(a, b));
    }
    if (sortBy === 'category') {
        const rank = n => CATEGORY[n.kind] * 100 + (n.kind === 'symbol' ? n.symbolKind || 0 : 0);
        return [...nodes].sort((a, b) => rank(a) - rank(b) || byPosition(a, b));
    }
    return nodes;
}

const RANK = { queued: 1, executing: 2, failed: 3 };

/** Returns Map<nodeId, 'executing'|'queued'|'failed'>: the cell node itself plus every header above it. */
function computeMarks(tree, stateOf) {
    const marks = new Map();
    const mark = (node, state) => {
        const prev = marks.get(node.id);
        if (!prev || RANK[state] > RANK[prev]) {
            marks.set(node.id, state);
        }
    };
    for (const [key, parent] of tree.cellParent) {
        const state = stateOf(key);
        if (!state) {
            continue;
        }
        const own = tree.cellNode.get(key);
        if (own) {
            mark(own, state);
        }
        for (let n = parent; n; n = n.parent) {
            mark(n, state);
        }
    }
    return marks;
}

/**
 * Infers cell execution state from executionSummary changes (the stable API has no execution-state event).
 * VS Code resets a cell's run metadata when it is queued; the Jupyter kernel then sets executionOrder
 * when the cell actually starts (execute_input); timing/success appear when it ends.
 *
 * It also remembers the cell that failed (success === false): at most one per notebook, and it is
 * forgotten as soon as any cell of that notebook starts executing.
 */
class ExecutionTracker {
    constructor() {
        this.cells = new Map();     // cellKey -> { state, notebookKey, since }
        this.lastBusy = new Map();  // notebookKey -> time a cell of it was last seen executing
        this.failures = new Map();  // cellKey -> notebookKey (at most one entry per notebook)
    }

    update(cellKey, notebookKey, summary, now) {
        const prev = this.cells.get(cellKey);
        const finished = summary.timing != null || summary.success != null;
        let next;
        if (finished) {
            next = undefined;
        } else if (summary.executionOrder != null) {
            // Only a cell we saw being queued can start; otherwise this is an unrelated metadata edit.
            next = prev ? 'executing' : undefined;
        } else {
            next = 'queued';
        }
        let changed = false;
        if (summary.success === false) {
            changed = this._setFailure(cellKey, notebookKey);
        } else if (next === 'executing') {
            changed = this._clearFailure(notebookKey);
        }
        if (!next) {
            if (prev) {
                if (prev.state === 'executing') {
                    this.lastBusy.set(notebookKey, now);
                }
                this.cells.delete(cellKey);
                return true;
            }
            return changed;
        }
        if (prev && prev.state === next) {
            return changed;
        }
        this.cells.set(cellKey, { state: next, notebookKey, since: now });
        return true;
    }

    /** Key of the cell that failed in this notebook, or undefined. */
    failedCell(notebookKey) {
        for (const [cellKey, nb] of this.failures) {
            if (nb === notebookKey) {
                return cellKey;
            }
        }
        return undefined;
    }

    _setFailure(cellKey, notebookKey) {
        if (this.failedCell(notebookKey) === cellKey) {
            return false;
        }
        this._clearFailure(notebookKey);
        this.failures.set(cellKey, notebookKey);
        return true;
    }

    _clearFailure(notebookKey) {
        let cleared = false;
        for (const [cellKey, nb] of this.failures) {
            if (nb === notebookKey) {
                this.failures.delete(cellKey);
                cleared = true;
            }
        }
        return cleared;
    }

    hasExecuting(notebookKey) {
        for (const e of this.cells.values()) {
            if (e.notebookKey === notebookKey && e.state === 'executing') {
                return true;
            }
        }
        return false;
    }

    /** Visible state of a cell, or undefined. */
    stateOf(cellKey, now, showQueued) {
        if (this.failures.has(cellKey)) {
            return 'failed';
        }
        const e = this.cells.get(cellKey);
        if (!e) {
            return undefined;
        }
        if (e.state === 'executing') {
            return 'executing';
        }
        if (!showQueued) {
            return undefined;
        }
        if (this.hasExecuting(e.notebookKey) || now - this._idleSince(e) < QUEUED_VISIBLE_MS) {
            return 'queued';
        }
        return undefined;
    }

    /** Milliseconds until a queued cell of this idle notebook stops being visible, or undefined. */
    nextQueuedExpiry(notebookKey, now) {
        if (this.hasExecuting(notebookKey)) {
            return undefined;
        }
        let best;
        for (const e of this.cells.values()) {
            if (e.notebookKey === notebookKey && e.state === 'queued') {
                const left = QUEUED_VISIBLE_MS - (now - this._idleSince(e));
                if (left > 0 && (best === undefined || left < best)) {
                    best = left;
                }
            }
        }
        return best;
    }

    prune(now) {
        for (const [key, e] of this.cells) {
            if (e.state === 'queued' && !this.hasExecuting(e.notebookKey) && now - this._idleSince(e) > QUEUED_DROP_MS) {
                this.cells.delete(key);
            }
        }
    }

    forget(cellKey) {
        this.cells.delete(cellKey);
        this.failures.delete(cellKey);
    }

    forgetNotebook(notebookKey) {
        for (const [key, e] of this.cells) {
            if (e.notebookKey === notebookKey) {
                this.cells.delete(key);
            }
        }
        this.lastBusy.delete(notebookKey);
        this._clearFailure(notebookKey);
    }

    reset() {
        this.cells.clear();
        this.lastBusy.clear();
        this.failures.clear();
    }

    _idleSince(entry) {
        return Math.max(entry.since, this.lastBusy.get(entry.notebookKey) || 0);
    }
}

module.exports = { parseHeaders, boldText, buildTree, sortNodes, computeMarks, ExecutionTracker, QUEUED_VISIBLE_MS, QUEUED_DROP_MS };
