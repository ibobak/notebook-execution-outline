'use strict';

const vscode = require('vscode');
const { buildTree, sortNodes, computeMarks, boldText, ExecutionTracker } = require('./lib/model');

const VIEW_ID = 'notebookExecutionOutline';
const SCHEME = 'nbexec';
const COLOR = {
    executing: new vscode.ThemeColor('notebookExecutionOutline.executingForeground'),
    queued: new vscode.ThemeColor('notebookExecutionOutline.queuedForeground'),
    failed: new vscode.ThemeColor('notebookExecutionOutline.failedForeground'),
};

const BADGE = { executing: '▶', failed: '✗' };

// Codicon ids in vscode.SymbolKind order (File = 0 ... TypeParameter = 25).
const SYMBOL_ICONS = [
    'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum',
    'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key',
    'null', 'enum-member', 'struct', 'event', 'operator', 'type-parameter',
].map(name => 'symbol-' + name);

function cellKey(cell) {
    return cell.document.uri.toString();
}

function config() {
    const c = vscode.workspace.getConfiguration('notebookExecutionOutline');
    return {
        showMarkdownHeadersOnly: c.get('showMarkdownHeadersOnly', true),
        showCodeCells: c.get('showCodeCells', true),
        showCodeCellSymbols: c.get('showCodeCellSymbols', true),
        highlightQueued: c.get('highlightQueued', false),
        revealExecuting: c.get('revealExecuting', true),
        followCursor: c.get('followCursor', true),
        sortBy: c.get('sortBy', 'position'),
    };
}

class OutlineProvider {
    constructor(tracker) {
        this.tracker = tracker;
        this.notebook = undefined;
        this.tree = undefined;
        this.marks = new Map();
        this.cellDocs = new Set();
        this.symbolCache = new Map();   // cellKey -> { version, symbols }
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this._onDidChangeFileDecorations = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    }

    setNotebook(notebook) {
        this.notebook = notebook;
        this._symbolRetries = 0;
        this.rebuild();
    }

    rebuild() {
        const nb = this.notebook;
        if (!nb || nb.isClosed) {
            this.notebook = undefined;
            this.tree = undefined;
            this.cellDocs = new Set();
        } else {
            const cells = nb.getCells().map(c => ({
                kind: c.kind === vscode.NotebookCellKind.Markup ? 'markup' : 'code',
                text: c.document.getText(),
                key: cellKey(c),
            }));
            const cfg = config();
            this.tree = buildTree(cells, {
                ...cfg,
                symbolsOf: key => (this.symbolCache.get(key) || {}).symbols,
            });
            this.cellDocs = new Set(cells.map(c => c.key));
            if (cfg.showCodeCells && cfg.showCodeCellSymbols) {
                this.fetchSymbols(nb);
            }
        }
        this.refreshMarks();
    }

    /** Asks the language server for symbols of changed code cells, then rebuilds if any changed. */
    async fetchSymbols(nb) {
        const stale = nb.getCells().filter(c => c.kind === vscode.NotebookCellKind.Code
            && (this.symbolCache.get(cellKey(c)) || {}).version !== c.document.version);
        if (!stale.length) {
            return;
        }
        let changed = false;
        let missing = false;
        await Promise.all(stale.map(async cell => {
            let result;
            try {
                result = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', cell.document.uri);
            } catch (e) {
                result = undefined;
            }
            if (!result) {
                missing = true;   // no provider yet (language server still starting): retry later
                return;
            }
            const toSymbol = sym => ({
                name: sym.name,
                kind: sym.kind,
                range: sym.selectionRange || sym.range || (sym.location && sym.location.range),
                children: (sym.children || []).map(toSymbol),
            });
            this.symbolCache.set(cellKey(cell), { version: cell.document.version, symbols: result.map(toSymbol) });
            changed = true;
        }));
        if (nb !== this.notebook) {
            return;
        }
        if (changed) {
            this.rebuild();
        }
        if (missing && (this._symbolRetries = (this._symbolRetries || 0) + 1) <= 10) {
            setTimeout(() => nb === this.notebook && this.fetchSymbols(nb), 3000);
        }
    }

    refreshMarks() {
        const showQueued = config().highlightQueued;
        const now = Date.now();
        this.tracker.prune(now);
        this.marks = this.tree
            ? computeMarks(this.tree, key => this.tracker.stateOf(key, now, showQueued))
            : new Map();
        this._onDidChangeTreeData.fire(undefined);
        this._onDidChangeFileDecorations.fire(undefined);
    }

    /** Code cell keys currently executing in the shown notebook, in notebook order. */
    executingKeys() {
        if (!this.tree) {
            return [];
        }
        return [...this.tree.cellParent.keys()].filter(k => this.tracker.stateOf(k, Date.now(), false) === 'executing');
    }

    /** Key of the failed code cell in the shown notebook, or undefined. */
    failedKey() {
        return this.notebook && this.tree
            ? this.tracker.failedCell(this.notebook.uri.toString())
            : undefined;
    }

    getChildren(node) {
        if (!this.tree) {
            return [];
        }
        return sortNodes(node ? node.children : this.tree.roots, config().sortBy);
    }

    getParent(node) {
        return node.parent || undefined;
    }

    getTreeItem(node) {
        const state = this.marks.get(node.id);
        const item = new vscode.TreeItem(
            state === 'executing' ? boldText(node.label) : node.label,
            node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
        );
        item.id = node.id;
        // The resourceUri is what lets the FileDecorationProvider below color the label.
        item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: '/' + node.kind, query: node.id });
        item.tooltip = node.label + (state ? ` (${state})` : '');
        if (node.kind === 'symbol') {
            item.iconPath = new vscode.ThemeIcon(SYMBOL_ICONS[node.symbolKind] || 'symbol-misc');
        } else if (node.kind === 'markdown') {
            item.iconPath = new vscode.ThemeIcon('markdown');
        } else if (state === 'failed') {
            item.iconPath = new vscode.ThemeIcon('error', COLOR.failed);
        } else if (state === 'executing') {
            item.iconPath = new vscode.ThemeIcon('debug-start', COLOR.executing);
        } else if (node.kind === 'header') {
            item.iconPath = state ? new vscode.ThemeIcon('circle-filled', COLOR[state]) : new vscode.ThemeIcon('markdown');
        } else if (state === 'queued') {
            item.iconPath = new vscode.ThemeIcon('watch', COLOR.queued);
        } else {
            item.iconPath = new vscode.ThemeIcon('code');
        }
        item.contextValue = node.kind;
        item.command = { command: 'notebookExecutionOutline.revealCell', title: 'Reveal Cell', arguments: [node] };
        return item;
    }

    provideFileDecoration(uri) {
        if (uri.scheme !== SCHEME) {
            return undefined;
        }
        const state = this.marks.get(uri.query);
        if (!state) {
            return undefined;
        }
        return new vscode.FileDecoration(BADGE[state], state, COLOR[state]);
    }
}

function activate(context) {
    const tracker = new ExecutionTracker();
    const provider = new OutlineProvider(tracker);
    const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: true });

    let rebuildTimer;
    let marksTimer;
    let expiryTimer;
    let lastRevealed;
    let lastFailedRevealed;

    const updateMessage = () => {
        treeView.message = provider.notebook ? undefined : 'Open a notebook to see its outline.';
        treeView.description = provider.notebook ? vscode.workspace.asRelativePath(provider.notebook.uri) : undefined;
    };

    const afterRefresh = () => {
        const nb = provider.notebook;
        clearTimeout(expiryTimer);
        if (nb) {
            const left = tracker.nextQueuedExpiry(nb.uri.toString(), Date.now());
            if (left !== undefined && config().highlightQueued) {
                expiryTimer = setTimeout(refreshMarks, left + 50);
            }
        }
        const executing = provider.executingKeys();
        const failed = provider.failedKey();
        if (!failed) {
            lastFailedRevealed = undefined;
        }
        if (!executing.length) {
            lastRevealed = undefined;
            // Scroll to the failure once, so it is visible without hunting for it.
            if (failed && failed !== lastFailedRevealed && treeView.visible && config().revealExecuting) {
                const target = provider.tree.cellNode.get(failed) || provider.tree.cellParent.get(failed);
                if (target) {
                    lastFailedRevealed = failed;
                    treeView.reveal(target, { select: false, focus: false, expand: false }).then(undefined, () => {});
                }
            }
            return;
        }
        const key = executing[0];
        if (key === lastRevealed || !treeView.visible || !config().revealExecuting) {
            return;
        }
        const target = provider.tree.cellNode.get(key) || provider.tree.cellParent.get(key);
        if (target) {
            lastRevealed = key;
            treeView.reveal(target, { select: false, focus: false, expand: false }).then(undefined, () => {});
        }
    };

    const setConfig = (section, key, value) =>
        vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);

    const followCursor = editor => {
        if (!config().followCursor || !treeView.visible || !provider.tree || !editor || editor.notebook !== provider.notebook) {
            return;
        }
        const sel = editor.selections[0];
        if (!sel || sel.isEmpty) {
            return;
        }
        const cell = editor.notebook.cellAt(sel.start);
        const target = cell && provider.tree.anchor.get(cellKey(cell));
        if (target) {
            treeView.reveal(target, { select: true, focus: false, expand: false }).then(undefined, () => {});
        }
    };

    const rebuild = () => {
        clearTimeout(rebuildTimer);
        provider.rebuild();
        updateMessage();
        afterRefresh();
    };
    const refreshMarks = () => {
        clearTimeout(marksTimer);
        provider.refreshMarks();
        afterRefresh();
    };
    const scheduleRebuild = () => {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(rebuild, 250);
    };
    const scheduleMarks = () => {
        clearTimeout(marksTimer);
        marksTimer = setTimeout(refreshMarks, 30);
    };

    const revealCell = async node => {
        const nb = provider.notebook;
        if (!nb || !node) {
            return;
        }
        const index = nb.getCells().findIndex(c => cellKey(c) === node.cellKey);
        if (index < 0) {
            return;
        }
        if (node.kind === 'symbol' && node.range) {
            await vscode.window.showTextDocument(nb.cellAt(index).document, { selection: node.range, preserveFocus: false });
            return;
        }
        const range = new vscode.NotebookRange(index, index + 1);
        const visible = vscode.window.visibleNotebookEditors.find(e => e.notebook === nb);
        const editor = await vscode.window.showNotebookDocument(nb, {
            viewColumn: visible ? visible.viewColumn : undefined,
            selections: [range],
            preserveFocus: false,
        });
        editor.revealRange(range, vscode.NotebookEditorRevealType.AtTop);
    };

    context.subscriptions.push(
        treeView,
        vscode.window.registerFileDecorationProvider(provider),

        vscode.commands.registerCommand('notebookExecutionOutline.revealCell', revealCell),
        vscode.commands.registerCommand('notebookExecutionOutline.refresh', rebuild),
        // Each menu option is a pair of commands (checked/unchecked title); extension menus have no checkmarks.
        ...['followCursor', 'showMarkdownHeadersOnly', 'showCodeCells', 'showCodeCellSymbols'].flatMap(key => [
            vscode.commands.registerCommand(`notebookExecutionOutline.${key}.on`, () => setConfig('notebookExecutionOutline', key, false)),
            vscode.commands.registerCommand(`notebookExecutionOutline.${key}.off`, () => setConfig('notebookExecutionOutline', key, true)),
        ]),
        // The tree find widget of extension views only honors the global find mode setting.
        vscode.commands.registerCommand('notebookExecutionOutline.filterOnType.on', () =>
            setConfig('workbench.list', 'defaultFindMode', 'highlight')),
        vscode.commands.registerCommand('notebookExecutionOutline.filterOnType.off', () =>
            setConfig('workbench.list', 'defaultFindMode', 'filter')),
        ...['position', 'name', 'category'].flatMap(sortBy => ['on', 'off'].map(suffix =>
            vscode.commands.registerCommand(`notebookExecutionOutline.sortBy.${sortBy}.${suffix}`, () =>
                setConfig('notebookExecutionOutline', 'sortBy', sortBy)))),
        vscode.commands.registerCommand('notebookExecutionOutline.resetExecutionState', () => {
            tracker.reset();
            rebuild();
        }),

        vscode.window.onDidChangeActiveNotebookEditor(editor => {
            // Keep showing the last notebook when focus moves to a non-notebook editor.
            if (editor && editor.notebook !== provider.notebook) {
                lastRevealed = undefined;
                lastFailedRevealed = undefined;
                provider.setNotebook(editor.notebook);
                updateMessage();
                afterRefresh();
            }
        }),

        vscode.workspace.onDidChangeNotebookDocument(e => {
            const nbKey = e.notebook.uri.toString();
            let execChanged = false;
            for (const change of e.cellChanges) {
                if (change.executionSummary !== undefined) {
                    execChanged = tracker.update(cellKey(change.cell), nbKey, change.executionSummary, Date.now()) || execChanged;
                }
            }
            for (const change of e.contentChanges) {
                for (const cell of change.removedCells) {
                    tracker.forget(cellKey(cell));
                }
            }
            if (e.notebook !== provider.notebook) {
                return;
            }
            if (e.contentChanges.length || e.cellChanges.some(c => c.document)) {
                scheduleRebuild();
            }
            if (execChanged) {
                scheduleMarks();
            }
        }),

        vscode.window.onDidChangeNotebookEditorSelection(e => followCursor(e.notebookEditor)),

        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.scheme === 'vscode-notebook-cell' && provider.cellDocs.has(e.document.uri.toString())) {
                scheduleRebuild();
            }
        }),

        vscode.workspace.onDidCloseNotebookDocument(nb => {
            tracker.forgetNotebook(nb.uri.toString());
            if (nb === provider.notebook) {
                provider.setNotebook(undefined);
                updateMessage();
            }
        }),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('notebookExecutionOutline')) {
                rebuild();
            }
        }),

        treeView.onDidChangeVisibility(e => {
            if (e.visible) {
                lastRevealed = undefined;
                afterRefresh();
                followCursor(vscode.window.activeNotebookEditor);
            }
        }),

        { dispose: () => [rebuildTimer, marksTimer, expiryTimer].forEach(clearTimeout) },
    );

    const active = vscode.window.activeNotebookEditor;
    if (active) {
        provider.setNotebook(active.notebook);
    }
    updateMessage();
}

function deactivate() {}

module.exports = { activate, deactivate };
