// Headless smoke test of the pure main-process logic. The Electron GUI can't
// run here (no display), but these modules are now free of the electron
// dependency and can be exercised directly in Node.
//
//   HOME=$(mktemp -d) node --experimental-strip-types scripts/smoke-test.ts

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeManager, linkNodeModules } from '../src/main/worktree'
import { StatusWatcher } from '../src/main/status'
import { getWorktreeDiff, getWorktreeUnifiedDiff, readWorktreeFile, resolveConflictFile } from '../src/main/git'
import { workbenchReducer, EMPTY_WORKBENCH, type WorkbenchState } from '../src/renderer/src/lib/workbench'
import {
  isAllowedDevRendererUrl,
  isAllowedExternalUrl,
  normalizeAgentConfig,
  safeLaunchEnv,
  isManagedWorktreePath,
  expectedSessionPaths
} from '../src/main/security'
import { buildPiShellCommand } from '../src/main/pi'
import { eventsFileFor, sessionDirFor } from '../src/main/paths'
import { randomUUID } from 'node:crypto'

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

/** A valid RFC 4122 UUID for tests that need one. */
const TEST_UUID = '01234567-89ab-4def-9234-456789abcdef'

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
  const { worktreePath, branch } = await wm.create(repo, TEST_UUID)

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

  await wm.remove(repo, TEST_UUID, branch)
  check('worktree removed', !existsSync(worktreePath))
  const branchesAfter = git(['branch', '--format=%(refname:short)'], repo)
  check('branch deleted', !branchesAfter.includes(branch))

  rmSync(repo, { recursive: true, force: true })
}

async function testStatus(): Promise<void> {
  console.log('StatusWatcher')
  const id = randomUUID()
  const eventsFile = eventsFileFor(id)
  mkdirSync(sessionDirFor(id), { recursive: true })
  writeFileSync(eventsFile, '')

  const sw = new StatusWatcher()
  const states: string[] = []
  sw.on('changed', (info) => states.push(info.status))

  sw.watch(id)
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
  const snap = sw.snapshot(id)
  check('captured last tool', snap?.lastTool === 'bash', JSON.stringify(snap))

  sw.unwatch(id)
  rmSync(sessionDirFor(id), { recursive: true, force: true })
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
  const id = randomUUID()
  const eventsFile = eventsFileFor(id)
  mkdirSync(sessionDirFor(id), { recursive: true })
  writeFileSync(eventsFile, '')

  const sw = new StatusWatcher()
  sw.watch(id)
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
  const snap = sw.snapshot(id)
  const p = snap?.todoPhases
  check('todo phases parsed', p?.length === 2, JSON.stringify(p))
  check('phase names preserved', p?.[0].name === 'Foundation' && p?.[1].name === 'Feature')
  check('all statuses preserved', p?.[1].tasks[0].status === 'in_progress' && p?.[1].tasks[1].status === 'pending')
  check('completed task preserved', p?.[0].tasks[0].status === 'completed')

  // A malformed payload must not corrupt the last good state.
  appendEvent(eventsFile, 'todo_state', { phases: 'not-an-array' })
  await sleep(400)
  const after = sw.snapshot(id)
  check('malformed payload ignored', after?.todoPhases?.length === 2, JSON.stringify(after?.todoPhases))

  sw.unwatch(id)
  rmSync(sessionDirFor(id), { recursive: true, force: true })
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

function testSecurityHelpers(): void {
  console.log('Security helpers')

  // Dev renderer URL
  check('dev localhost allowed', isAllowedDevRendererUrl('http://localhost:5173/') === 'http://localhost:5173/')
  check('dev 127.0.0.1 allowed', isAllowedDevRendererUrl('http://127.0.0.1:5173') !== null)
  check('dev example.com rejected', isAllowedDevRendererUrl('https://example.com') === null)
  check('dev file rejected', isAllowedDevRendererUrl('file:///etc/passwd') === null)
  check('dev undefined rejected', isAllowedDevRendererUrl(undefined) === null)

  // External URL
  check('external https allowed', isAllowedExternalUrl('https://example.com'))
  check('external file rejected', !isAllowedExternalUrl('file:///etc/passwd'))
  check('external javascript rejected', !isAllowedExternalUrl('javascript:alert(1)'))
  check('external custom scheme rejected', !isAllowedExternalUrl('superpi://x'))
  check('external empty rejected', !isAllowedExternalUrl(''))

  // safeLaunchEnv
  const env = safeLaunchEnv(
    { PATH: '/usr/bin', HOME: '/h', OPENAI_API_KEY: 'sk-leak', AWS_SECRET_ACCESS_KEY: 'leak', ELECTRON_RENDERER_URL: 'http://x', LC_CTYPE: 'UTF-8', LC_FOO: 'bar' },
    { SUPERPI: '1', SUPERPI_WORKTREE: '/wt' }
  )
  check('env keeps PATH', env.PATH === '/usr/bin')
  check('env keeps HOME', env.HOME === '/h')
  check('env keeps LC_CTYPE', env.LC_CTYPE === 'UTF-8')
  check('env keeps LC_FOO', env.LC_FOO === 'bar')
  check('env drops OPENAI_API_KEY', !('OPENAI_API_KEY' in env))
  check('env drops AWS_SECRET_ACCESS_KEY', !('AWS_SECRET_ACCESS_KEY' in env))
  check('env drops ELECTRON_RENDERER_URL', !('ELECTRON_RENDERER_URL' in env))
  check('env adds SUPERPI', env.SUPERPI === '1')
  check('env adds SUPERPI_WORKTREE', env.SUPERPI_WORKTREE === '/wt')
}

function testConfigValidation(): void {
  console.log('Config validation')

  // Legacy extraArgs dropped
  const withExtra = normalizeAgentConfig({ id: 'default', name: 'Default', extraArgs: '-e /tmp/backdoor.ts', isDefault: true })
  check('extraArgs dropped', withExtra !== null && !('extraArgs' in withExtra), JSON.stringify(withExtra))

  // Invalid thinking rejected
  check('invalid thinking rejected', normalizeAgentConfig({ id: 'x', name: 'n', thinking: 'EVIL' }) === null)
  check('valid thinking accepted', normalizeAgentConfig({ id: 'x', name: 'n', thinking: 'minimal' })?.thinking === 'minimal')

  // Valid config survives
  const valid = normalizeAgentConfig({ id: 'x', name: 'n', model: 'anthropic/claude', thinking: 'high', firstMessage: 'do stuff' })
  check('valid config survives', valid?.model === 'anthropic/claude' && valid?.thinking === 'high', JSON.stringify(valid))

  // Empty name rejected
  check('empty name rejected', normalizeAgentConfig({ id: 'x', name: '' }) === null)
}

function testAgentDescriptorValidation(): void {
  console.log('Agent descriptor validation')

  const ws = '/test/workspace'

  // Valid OMP descriptor
  const validId = TEST_UUID
  check('managed worktree accepted', isManagedWorktreePath(ws, validId, `${ws}/.superpi/${validId}`))

  // OMP worktree outside managed path rejected
  check('outside worktree rejected', !isManagedWorktreePath(ws, validId, '/tmp/evil'))

  // Prefix-only match rejected
  check('prefix match rejected', !isManagedWorktreePath(ws, validId, `${ws}/.superpi/${validId}-evil`))

  // Non-UUID id rejected
  check('non-uuid id rejected', (() => { try { expectedSessionPaths('../bad'); return false } catch { return true } })())

  // Derived session paths
  const paths = expectedSessionPaths(validId)
  check('session dir derived', paths.sessionDir.includes(validId))
  check('events file derived', paths.eventsFile.endsWith('events.jsonl'))
}

function testLaunchQuoting(): void {
  console.log('Launch quoting')

  const cmd = buildPiShellCommand(['hello; touch x', '$(id)', "a'b"])
  // Each metacharacter payload must be inside single quotes — no unquoted
  // shell command separators outside quotes.
  check('semicolon payload quoted', cmd.includes("'hello; touch x'"))
  check('command substitution quoted', cmd.includes("'$(id)'"))
  check('single-quote payload escaped', cmd.includes("'a'\\''b'"))
  // The exec prefix and binary name are the only unquoted parts.
  check('starts with exec', cmd.startsWith('exec omp '))
}

async function testWorktreeSymlinkSafety(): Promise<void> {
  console.log('Worktree symlink safety')
  const repo = mkdtempSync(join(tmpdir(), 'spsymlink-'))
  git(['init', '-q'], repo)
  git(['config', 'user.email', 't@t.tt'], repo)
  git(['config', 'user.name', 't'], repo)
  try { git(['checkout', '-q', '-b', 'main'], repo) } catch { /* already on branch */ }
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(['add', '-A'], repo)
  git(['commit', '-q', '-m', 'init'], repo)

  // Place a symlink inside the worktree pointing to an outside file.
  const outsideFile = join(tmpdir(), 'symlink-target-' + Date.now() + '.txt')
  writeFileSync(outsideFile, 'SECRET')
  const linkPath = join(repo, 'evil-link.txt')
  try { symlinkSync(outsideFile, linkPath) } catch { /* platform may not support */ }

  // readWorktreeFile must reject the symlink.
  let threw = false
  try { readWorktreeFile(repo, 'evil-link.txt') } catch { threw = true }
  check('symlink read rejected', threw)

  // resolveConflictFile must reject the symlink.
  threw = false
  try { await resolveConflictFile(repo, 'evil-link.txt', { content: 'overwritten' }) } catch { threw = true }
  check('symlink write rejected', threw)

  // The outside target must be unchanged.
  check('outside target unchanged', readFileSync(outsideFile, 'utf8') === 'SECRET')

  // Untracked symlink diff counting: counted as a file but not read.
  const stat = await getWorktreeDiff(repo)
  check('symlink counted as changed file', stat.files >= 1, String(stat.files))

  // Cleanup
  try { rmSync(linkPath) } catch { /* ignore */ }
  rmSync(repo, { recursive: true, force: true })
  rmSync(outsideFile)
}

async function testStatusBoundedPaths(): Promise<void> {
  console.log('Status bounded paths')

  const sw = new StatusWatcher()

  // Non-UUID watch is rejected silently.
  sw.watch('../bad')
  check('non-uuid watch rejected', sw.snapshot('../bad') === null)

  // Malformed oversized event line is ignored without corrupting status.
  const id = randomUUID()
  const eventsFile = eventsFileFor(id)
  mkdirSync(sessionDirFor(id), { recursive: true })
  writeFileSync(eventsFile, '')
  sw.watch(id)
  await sleep(60)

  // Write a valid event first.
  appendEvent(eventsFile, 'session_start')
  await sleep(400)

  // Write a massive line (>64 KiB) that should be skipped.
  const huge = 'x'.repeat(70_000)
  writeFileSync(eventsFile, JSON.stringify({ ts: Date.now(), type: 'agent_start', data: { huge } }) + '\n', { flag: 'a' })
  await sleep(400)

  // Status should still be idle (from session_start), not corrupted.
  const snap = sw.snapshot(id)
  check('oversized line ignored', snap?.status === 'idle', JSON.stringify(snap?.status))

  sw.unwatch(id)
  rmSync(sessionDirFor(id), { recursive: true, force: true })
}

async function main(): Promise<void> {
  await testWorktree()
  await testStatus()
  await testDiff()
  await testStatusTodos()
  testWorkbench()
  testSecurityHelpers()
  testConfigValidation()
  testAgentDescriptorValidation()
  testLaunchQuoting()
  await testWorktreeSymlinkSafety()
  await testStatusBoundedPaths()
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
