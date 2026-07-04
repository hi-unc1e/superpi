// Headless smoke test of the pure main-process logic. The Electron GUI can't
// run here (no display), but these modules are now free of the electron
// dependency and can be exercised directly in Node.
//
//   HOME=$(mktemp -d) node --experimental-strip-types scripts/smoke-test.ts

import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeManager, linkNodeModules } from '../src/main/worktree'
import { StatusWatcher } from '../src/main/status'
import { getWorktreeDiff, getWorktreeUnifiedDiff } from '../src/main/git'
import { workbenchReducer, EMPTY_WORKBENCH, type WorkbenchState } from '../src/renderer/src/lib/workbench'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  \u2713 ${name}`)
  } else {
    console.log(`  \u2717 ${name} ${detail}`)
    failures++
  }
}

/** git via arg array — no shell, so %(refname:short) etc. are safe. */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim()
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

function appendEvent(file: string, type: string, data: Record<string, unknown> = {}): void {
  writeFileSync(file, JSON.stringify({ ts: Date.now(), type, data }) + '\n', { flag: 'a' })
}

async function testWorktree(): Promise<void> {
  console.log('WorktreeManager')
  const repo = mkdtempSync(join(tmpdir(), 'pidesk-repo-'))
  git(['init', '-q'], repo)
  git(['config', 'user.email', 't@t.tt'], repo)
  git(['config', 'user.name', 't'], repo)
  try {
    git(['checkout', '-q', '-b', 'main'], repo)
  } catch {
    /* already on a branch */
  }
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'init'], repo)

  const wm = new WorktreeManager()
  const { worktreePath, branch } = await wm.create(repo, 'abc12345')

  check('worktree dir created', existsSync(worktreePath))
  check('worktree checked out file present', existsSync(join(worktreePath, 'README.md')))
  const branches = git(['branch', '--format=%(refname:short)'], repo)
  check('branch created', branches.includes(branch), `want ${branch}`)
  check(
    'worktree branch reads back via rev-parse (not main)',
    git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath) === branch,
    `want ${branch}`
  )
  check('worktree lives under repo .superpi', worktreePath.includes('.superpi'))
  check('local exclude file exists', existsSync(join(repo, '.git', 'info', 'exclude')))

  mkdirSync(join(repo, 'node_modules'), { recursive: true }) // fake deps in workspace
  linkNodeModules(repo, worktreePath)
  check(
    'node_modules linked into worktree',
    lstatSync(join(worktreePath, 'node_modules')).isSymbolicLink()
  )

  await wm.remove(repo, worktreePath, branch)
  check('worktree removed', !existsSync(worktreePath))
  const branchesAfter = git(['branch', '--format=%(refname:short)'], repo)
  check('branch deleted', !branchesAfter.includes(branch))

  rmSync(repo, { recursive: true, force: true })
}

async function testStatus(): Promise<void> {
  console.log('StatusWatcher')
  const dir = mkdtempSync(join(tmpdir(), 'pidesk-status-'))
  const eventsFile = join(dir, 'events.jsonl')
  writeFileSync(eventsFile, '')

  const sw = new StatusWatcher()
  const states: string[] = []
  sw.on('changed', (info) => states.push(info.status))

  sw.watch('s1', dir, eventsFile)
  await sleep(60)

  appendEvent(eventsFile, 'session_start')
  await sleep(400)
  appendEvent(eventsFile, 'agent_start')
  await sleep(400)
  appendEvent(eventsFile, 'tool_call', { tool: 'bash' })
  await sleep(400)
  appendEvent(eventsFile, 'agent_end')
  await sleep(400)

  check('observed working state', states.includes('working'), JSON.stringify(states))
  check('settled to idle', states[states.length - 1] === 'idle', JSON.stringify(states))
  const snap = sw.snapshot('s1')
  check('captured last tool', snap?.lastTool === 'bash', JSON.stringify(snap))

  sw.unwatch('s1')
  rmSync(dir, { recursive: true, force: true })
}

async function testDiff(): Promise<void> {
  console.log('WorktreeDiff parser')
  const repo = mkdtempSync(join(tmpdir(), 'spdiff-'))
  git(['init', '-q'], repo)
  git(['config', 'user.email', 't@t.tt'], repo)
  git(['config', 'user.name', 't'], repo)
  try {
    git(['checkout', '-q', '-b', 'main'], repo)
  } catch {
    /* already on a branch */
  }
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'init'], repo)
  writeFileSync(join(repo, 'a.txt'), 'one\nthree\nfour\nfive\nsix\n')

  const diff = await getWorktreeUnifiedDiff(repo)
  const f = diff.files.find((x) => x.path === 'a.txt')
  check('parsed file a.txt', !!f)
  const lines = f!.hunks.flatMap((h) => h.lines)
  check('counts added=2 deleted=1', f!.added === 2 && f!.deleted === 1)
  check('context line carries old & new numbers',
    lines.find((l) => l.text === 'three')?.oldNo === 3 && lines.find((l) => l.text === 'three')?.newNo === 2)
  check('added lines carry newNo only',
    lines.find((l) => l.text === 'five')?.newNo === 4 && lines.find((l) => l.text === 'five')?.oldNo === undefined)

  git(['commit', '-q', '-am', 'final'], repo)
  check('clean tree yields empty diff', (await getWorktreeUnifiedDiff(repo)).files.length === 0)

  // Untracked files are invisible to `git diff HEAD` but must contribute
  // to the numstat so the UI shows correct line counts for new files.
  writeFileSync(join(repo, 'untracked.txt'), 'line one\nline two\nline three\n')
  const stat = await getWorktreeDiff(repo)
  check('untracked file counted in files', stat.files === 1, String(stat.files))
  check('untracked file lines counted as added', stat.added === 3, String(stat.added))
  check('untracked file has no deletions', stat.deleted === 0)
  check('untracked file sets hasChanges', stat.hasChanges)
  rmSync(repo, { recursive: true, force: true })
}

async function testStatusTodos(): Promise<void> {
  console.log('StatusWatcher todos')
  const dir = mkdtempSync(join(tmpdir(), 'pidesk-todos-'))
  const eventsFile = join(dir, 'events.jsonl')
  writeFileSync(eventsFile, '')

  const sw = new StatusWatcher()
  sw.watch('t1', dir, eventsFile)
  await sleep(60)

  appendEvent(eventsFile, 'todo_state', {
    phases: [
      { name: 'Foundation', tasks: [
        { content: 'Scaffold', status: 'completed' },
        { content: 'Wire', status: 'completed' }
      ] },
      { name: 'Feature', tasks: [
        { content: 'Implement', status: 'in_progress' },
        { content: 'Test', status: 'pending' }
      ] }
    ]
  })
  await sleep(400)
  const snap = sw.snapshot('t1')
  const p = snap?.todoPhases
  check('todo phases parsed', p?.length === 2, JSON.stringify(p))
  check('phase names preserved', p?.[0].name === 'Foundation' && p?.[1].name === 'Feature')
  check('all statuses preserved', p?.[1].tasks[0].status === 'in_progress' && p?.[1].tasks[1].status === 'pending')
  check('completed task preserved', p?.[0].tasks[0].status === 'completed')

  // A malformed payload must not corrupt the last good state.
  appendEvent(eventsFile, 'todo_state', { phases: 'not-an-array' })
  await sleep(400)
  const after = sw.snapshot('t1')
  check('malformed payload ignored', after?.todoPhases?.length === 2, JSON.stringify(after?.todoPhases))

  sw.unwatch('t1')
  rmSync(dir, { recursive: true, force: true })
}

function testWorkbench(): void {
  console.log('Workbench reducer')

  let s: WorkbenchState = workbenchReducer(EMPTY_WORKBENCH, { type: 'open-tab', id: 'a' })
  s = workbenchReducer(s, { type: 'open-tab', id: 'b' })
  s = workbenchReducer(s, { type: 'open-tab', id: 'c' })
  check('open-tab appends in open order', s.tabs.join(',') === 'a,b,c', s.tabs.join(','))
  check('open-tab activates the new tab', s.activeTabId === 'c', String(s.activeTabId))
  const reopened = workbenchReducer(s, { type: 'open-tab', id: 'a' })
  check('re-open does not duplicate the tab', reopened.tabs.join(',') === 'a,b,c', reopened.tabs.join(','))
  check('re-open activates the existing tab', reopened.activeTabId === 'a')

  const active = workbenchReducer(s, { type: 'activate-tab', id: 'b' })
  check('activate-tab switches the active tab', active.activeTabId === 'b')
  check('activate-tab of unknown id is a no-op', workbenchReducer(s, { type: 'activate-tab', id: 'zz' }) === s)

  // Successor choice: closing the active middle tab activates the next by
  // index; closing the active last tab falls back to the previous one.
  const closedMid = workbenchReducer(active, { type: 'close-tab', id: 'b' })
  check('close active middle tab activates next by index', closedMid.activeTabId === 'c' && closedMid.tabs.join(',') === 'a,c', JSON.stringify(closedMid))
  const closedLast = workbenchReducer(closedMid, { type: 'close-tab', id: 'c' })
  check('close active last tab activates previous', closedLast.activeTabId === 'a' && closedLast.tabs.join(',') === 'a', JSON.stringify(closedLast))
  const closedInactive = workbenchReducer(active, { type: 'close-tab', id: 'c' })
  check('close inactive tab preserves active', closedInactive.activeTabId === 'b' && closedInactive.tabs.join(',') === 'a,b', JSON.stringify(closedInactive))
  check('close unknown tab returns same state', workbenchReducer(s, { type: 'close-tab', id: 'zz' }) === s)

  let p = workbenchReducer(s, { type: 'set-panel', id: 'a', panel: 'diff', open: true })
  p = workbenchReducer(p, { type: 'set-panel', id: 'b', panel: 'todo', open: true })
  check('set-panel opens for the right tab', p.panels['a']?.diff === true && p.panels['b']?.todo === true, JSON.stringify(p.panels))
  check('panel state is isolated per tab', p.panels['b']?.diff === undefined && p.panels['a']?.todo === undefined, JSON.stringify(p.panels))
  check('set-panel to current value returns same state', workbenchReducer(p, { type: 'set-panel', id: 'a', panel: 'diff', open: true }) === p)
  check('set-panel closed->false is also a no-op', workbenchReducer(p, { type: 'set-panel', id: 'c', panel: 'conflicts', open: false }) === p)
  const toggledOn = workbenchReducer(p, { type: 'toggle-panel', id: 'a', panel: 'conflicts' })
  check('toggle-panel opens a closed panel', toggledOn.panels['a']?.conflicts === true)
  const toggledOff = workbenchReducer(toggledOn, { type: 'toggle-panel', id: 'a', panel: 'conflicts' })
  check('toggle-panel closes an open panel', toggledOff.panels['a']?.conflicts === false)
  check('toggle-panel preserves sibling panels of the tab', toggledOff.panels['a']?.diff === true, JSON.stringify(toggledOff.panels))

  const closedA = workbenchReducer(p, { type: 'close-tab', id: 'a' })
  check('close-tab drops the closed tab panel entry', !('a' in closedA.panels), JSON.stringify(closedA.panels))
  check('close-tab keeps other tabs panel state', closedA.panels['b']?.todo === true, JSON.stringify(closedA.panels))

  // p: tabs a,b,c (active c), panels a.diff and b.todo open.
  const pruned = workbenchReducer(p, { type: 'prune', alive: ['b'] })
  check('prune removes dead tabs', pruned.tabs.join(',') === 'b', pruned.tabs.join(','))
  check('prune drops dead panels, keeps alive ones', !('a' in pruned.panels) && pruned.panels['b']?.todo === true, JSON.stringify(pruned.panels))
  check('prune falls back active to last remaining tab', pruned.activeTabId === 'b', String(pruned.activeTabId))
  const prunedKeep = workbenchReducer(active, { type: 'prune', alive: ['b', 'c'] })
  check('prune keeps active tab when alive', prunedKeep.activeTabId === 'b' && prunedKeep.tabs.join(',') === 'b,c', JSON.stringify(prunedKeep))
  const prunedAll = workbenchReducer(s, { type: 'prune', alive: [] })
  check('prune of every tab empties active to null', prunedAll.tabs.length === 0 && prunedAll.activeTabId === null, JSON.stringify(prunedAll))
  check('prune with all alive returns same state', workbenchReducer(s, { type: 'prune', alive: ['a', 'b', 'c'] }) === s)

  check('reset returns the empty workbench', workbenchReducer(p, { type: 'reset' }) === EMPTY_WORKBENCH)
}

async function main(): Promise<void> {
  await testWorktree()
  await testStatus()
  await testDiff()
  await testStatusTodos()
  testWorkbench()
  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`)
    process.exit(1)
  }
  console.log('\nall checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
