# Notebook Execution Outline

A notebook outline view for VS Code. While a cell runs, every markdown header above it and the cell itself get a green ▶ marker, and their text turns green and bold.

```
A header          <- green ▶ bold
  B header
  C header        <- green ▶ bold
    cell 1
    cell 2        <- green ▶ bold (executing)
  D
```

When a cell fails (including a stop/interrupt), the cell and the headers above it get a red ✗ error marker and the tree scrolls to it. There is at most one such marker per notebook, so after a long run you can see where it stopped. The marker is cleared as soon as any cell of that notebook starts executing.

The built-in **Outline** view can't be extended, so this extension adds its own view, **Notebook Execution**, to the Explorer. You can drag it anywhere, for example next to Outline or into the secondary side bar. Click an item to jump to its cell.

The view title bar mirrors the built-in Outline:

- **Filter:** a dropdown with the same toggles as the Outline:
  - **Markdown Headers Only:** when off, markdown cells without a header are listed too.
  - **Code Cells:** shows code cells under their headers.
  - **Code Cell Symbols:** lists functions, classes and variables under each code cell. The symbols come from the language server (Pylance), and clicking one jumps to it.
- **… menu:**
  - **Follow Cursor:** selects the item of the cell the cursor is in.
  - **Filter on Type:** hides non-matching items instead of just highlighting them. This option is tied to the global setting `workbench.list.defaultFindMode`, because extension views can't set their own find mode, so it also affects other trees.
  - **Sort By:** Position, Name or Category (headers, markdown cells, code cells, then symbols by kind).
- **Refresh**, **Reset Execution Highlighting** and **Collapse All**.

Extension menus can't show real checkmarks, so the options that are on have a "✓" in their titles.

## Install

Install **Notebook Execution Outline** from the Extensions view, or run:

```bash
code --install-extension ihor-bobak.notebook-execution-outline
```

To build it from source:

```bash
npx @vscode/vsce package
code --install-extension notebook-execution-outline-0.4.1.vsix
```

## Settings

| Setting | Default | |
|---|---|---|
| `notebookExecutionOutline.showMarkdownHeadersOnly` | `true` | List only headers from markdown cells |
| `notebookExecutionOutline.showCodeCells` | `true` | Show code cells under their headers |
| `notebookExecutionOutline.showCodeCellSymbols` | `true` | Show symbols under code cells |
| `notebookExecutionOutline.highlightQueued` | `false` | Also highlight headers above queued cells (yellow) |
| `notebookExecutionOutline.revealExecuting` | `true` | Scroll the tree to the executing cell |
| `notebookExecutionOutline.followCursor` | `true` | Select the item of the cell the cursor is in |
| `notebookExecutionOutline.sortBy` | `position` | `position`, `name` or `category` |

You can change the colors with `workbench.colorCustomizations`: `notebookExecutionOutline.executingForeground`, `notebookExecutionOutline.failedForeground` and `notebookExecutionOutline.queuedForeground`.

The labels are colored through file decorations, so `explorer.decorations.colors` must stay enabled (it is by default).

## How it detects execution

The stable VS Code API has no "cell is executing" event. The extension works it out from `executionSummary` changes, the same way the Jupyter extension does:

1. When a cell is queued, VS Code resets its run metadata, so it has no execution order, no result and no timing.
2. When the kernel starts the cell, it sets `executionOrder`. This is the kernel's `execute_input` message, and the cell counts as executing from here.
3. When the cell finishes, VS Code sets `timing` and `success`, and the highlight is cleared.

Limitations:

- **Kernels:** this relies on the kernel setting the execution order when a cell starts. Jupyter kernels do; other kernels may not.
- **Clear All Outputs:** it resets metadata the same way queueing does. Those cells can briefly look queued, but only when `highlightQueued` is on.
- **Stuck highlight:** if a highlight ever gets stuck, click **Reset Execution Highlighting** in the view title bar.

## License

[MIT](LICENSE)
