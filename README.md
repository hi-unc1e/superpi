<p align="center">
  <img src="favicon.svg" width="128" alt="superpi logo" />
</p>

# superpi

A desktop workspace manager that runs parallel AI coding agents — each in its own git worktree with a live terminal. Built on [oh-my-pi](https://github.com/ohnoprompt/oh-my-pi) (`omp`).

## Features

- **Parallel agents** — launch multiple `omp` coding agents or plain shell terminals, each sandboxed in its own git worktree under `.superpi/<id>/`
- **Live terminals** — xterm.js PTY per agent with full scrollback, resize, and web link detection
- **Read-only status** — passive monitoring of each agent's lifecycle (starting → working → idle), last tool invoked, and last assistant message, derived from `omp`'s monitor hook
- **Agent configs** — save launch presets (model, thinking mode, extra CLI args) and pick one when creating an agent
- **Git integration** — per-agent branch graph (commits ahead/behind main), unstaged line diff, commit/merge/rebase with inline error feedback
- **Workspace-aware** — remembers recent folders; git log panel for the main branch
- **Worktree isolation** — `node_modules` symlinked from workspace into each worktree so agents can typecheck/build/test without `npm install`
- **Session revival** — re-opening a workspace re-spawns all agents and restores their terminal PTYs

## Prerequisites

- **Node.js** ≥ 20
- **git** ≥ 2.30 (worktree support)
- **`omp`** on `PATH` — the agent binary launched in each worktree
- **Linux** or **macOS** (node-pty; Windows requires WSL)

## Quick start

```bash
git clone https://github.com/ohnoprompt/superpi.git
cd superpi
npm install          # also rebuilds node-pty for Electron's ABI
npm run dev          # launches Electron with Vite HMR
```

Open a folder (`File > Open Folder` or `superpi /path/to/project`), click **+ New Agent**, and an `omp` session starts in a fresh worktree.

## Usage

### CLI

```bash
# Open a specific folder as the workspace
superpi ~/Projects/my-app

# Launch the app (then use File > Open Folder)
superpi
```

### Creating agents

Press **+ New Agent** in the sidebar or **+ Terminal** for a plain shell. You can also right-click an existing agent to open a terminal alongside it. Each agent gets:

- A dedicated git branch (`superpi/<short-id>`)
- An isolated worktree checkout under `<workspace>/.superpi/<id>/`
- Its `node_modules` symlinked from the workspace root
- `SUPERPI_WORKTREE` set to the worktree path (agents use relative paths — they never touch files outside their sandbox)

### Agent states

| State | Meaning |
|-------|---------|
| `starting` | PTY spawned, waiting for `omp` to initialize |
| `working` | Agent is in a turn (tool calls / model response active) |
| `idle` | Agent is waiting for input |
| `stopped` | Process exited or was killed |
| `error` | Agent encountered an error (shown red) |

### Git workflow

Each agent's terminal header shows:

- Branch graph: commits ahead of `main` and commits behind
- Unstaged changes: `+N/-M` lines
- **Commit** — stage everything and commit on the worktree branch
- **Merge** — merge the worktree branch into `main` (available when there are commits ahead)
- **Rebase** — rebase the worktree branch onto `main` (available when behind)

### Agent configurations

Manage presets via the gear icon in the sidebar. Each config can set:

- **Model** — passed as `--model <name>` to `omp`
- **Thinking** — passed as `--thinking <level>`
- **Extra args** — arbitrary additional CLI flags (whitespace-separated; single/double quotes supported)
- **First message** — initial prompt sent to `omp` on launch

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Main Process                   │
│  WorkspaceController  AgentStore  ConfigStore    │
│  WorktreeManager      TerminalManager            │
│  StatusWatcher (300ms poll)                      │
│       │  node-pty  │  simple-git                 │
└───────┼────────────┼─────────────────────────────┘
        │ IPC        │
┌───────┼────────────┼─────────────────────────────┐
│  Preload (contextBridge)                         │
│  window.superpi — typed SuperpiAPI contract       │
└───────┼──────────────────────────────────────────┘
        │
┌───────┼──────────────────────────────────────────┐
│  Renderer (React 18 · Tailwind · xterm.js)        │
│  AgentSidebar  TerminalPane  WorktreeHeader       │
│  StatusBar     ConfigsDialog  GitLog              │
└──────────────────────────────────────────────────┘
```

Three-process Electron split with strict sandbox: renderer has no Node access, only the typed `window.superpi` API exposed by the preload. The IPC contract lives in `src/shared/types.ts` — the single source of truth for all channels.

### Per-agent files

```
~/.superpi/
├── agents.json          # all agents across workspaces
├── configs.json         # launch presets
├── workspace.json       # last open folder
└── sessions/
    └── <agent-id>/
        ├── session.jsonl    # omp session log
        ├── events.jsonl     # monitor hook lifecycle events
        └── lock             # PID lock file (prevents double-spawn)
```

Worktrees live inside the workspace at `<workspace>/.superpi/<agent-id>/`.

## Development

```bash
npm run dev             # Electron + Vite HMR
npm run build           # production build → out/
npm run typecheck       # tsc on node + web projects (must be clean)
npm test                # headless smoke test (WorktreeManager + StatusWatcher)
npm run build:dist      # production build + electron-builder directory
```

### Project layout

```
src/
├── shared/types.ts      # IPC contract shared by all three processes
├── main/
│   ├── index.ts         # app bootstrap, window, event wiring
│   ├── ipc.ts           # all invoke/handle registrations
│   ├── agents.ts        # AgentStore (persistent CRUD)
│   ├── configs.ts       # ConfigStore (launch presets)
│   ├── workspace.ts     # WorkspaceController
│   ├── worktree.ts      # WorktreeManager (git worktree add/remove)
│   ├── terminal.ts      # TerminalManager (node-pty lifecycle)
│   ├── status.ts        # StatusWatcher (event polling)
│   ├── pi.ts            # omp launch config / argv builder
│   ├── git.ts           # git log, diff, graph, commit, merge, rebase
│   ├── paths.ts         # disk paths (APP_DIR, session dirs, etc.)
│   └── resources.ts     # bundled monitor hook path
├── preload/
│   ├── index.ts         # contextBridge.exposeInMainWorld
│   └── index.d.ts       # global Window augmentation
└── renderer/src/
    ├── App.tsx           # root: Welcome → GitInit → workspace
    ├── main.tsx          # React entry (no StrictMode)
    ├── lib/
    │   └── terminalBus.ts  # per-id terminal data fan-out
    └── components/
        ├── AgentSidebar.tsx   # agent list, git log, create/rename/delete
        ├── TerminalPane.tsx   # xterm.js terminal with fit + web links
        ├── WorktreeHeader.tsx # branch graph, commit/merge/rebase controls
        ├── WorktreeGraph.tsx  # ahead/behind visual graph
        ├── ConfigsDialog.tsx  # agent config preset editor
        ├── StatusBar.tsx      # bottom status bar (state, last tool, context)
        ├── GitInitBanner.tsx  # prompt to git init a non-git folder
        ├── Welcome.tsx        # landing page with Open Folder + recent
        └── TrafficLights.tsx  # macOS-style window controls
```

### Architecture invariants

- Renderer is **sandboxed**: `contextIsolation: true`, `nodeIntegration: false`
- The preload is the **only bridge** — never expose `ipcRenderer` directly
- One workspace at a time; agents are worktrees inside it
- Status is **read-only**, derived from the monitor hook's append-only `events.jsonl`
- `omp` is launched via a login shell: `sh -lc "exec omp …"` — full PATH/profile, PTY closes on exit
- Worktree isolation: agents use relative paths; `SUPERPI_WORKTREE` env signals the sandbox root
- `node_modules` symlink into worktrees — not copied, not re-installed

### Smoke test (no display needed)

```bash
HOME=$(mktemp -d) npx tsx scripts/smoke-test.ts
```

Tests the WorktreeManager lifecycle and StatusWatcher event parsing in plain Node — no Electron or X11 required.

### Native module note

`node-pty` is rebuilt against Electron's ABI on `postinstall`. When bumping the Electron major version, re-run `npm install` (or `npx electron-rebuild -f -w node-pty`).

## License

MIT
