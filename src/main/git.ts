import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import simpleGit from 'simple-git'
import type { ConflictInfo, ConflictResolution, GitLogEntry, WorktreeCommit, WorktreeDiff, WorktreeDiffFile, WorktreeDiffHunk, WorktreeDiffStat, WorktreeGraph } from '@shared/types'


/** True if <path> is inside a git working tree. */
export async function checkIsRepo(path: string): Promise<boolean> {
  try {
    return await simpleGit(path).checkIsRepo()
  } catch {
    return false
  }
}

/** `git init` a folder and seed an initial empty commit so worktrees have a base. */
export async function initRepo(path: string): Promise<void> {
  const git = simpleGit(path)
  await git.init()
  try {
    await git.raw(['config', 'user.email', 'superpi@local'])
  } catch {
    /* may already be set globally */
  }
  try {
    await git.raw(['config', 'user.name', 'superpi'])
  } catch {
    /* may already be set globally */
  }
  // An initial commit is required: git worktree add -b needs a real start ref.
  await git.raw(['commit', '--allow-empty', '-q', '-m', 'superpi init'])
}

/** Return recent commits from the workspace repo for the git log panel. */
export async function getLog(repoPath: string, maxCount = 50): Promise<GitLogEntry[]> {
  const git = simpleGit(repoPath)
  const out = await git.raw([
    'log',
    '--max-count', String(maxCount),
    '--format=%H%x00%an%x00%aI%x00%s%x00%D'
  ])
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, message, refs] = line.split('\0')
      return { hash, author, date, message, refs: refs ?? '' }
    })
}

/** Resolve the integration branch: main > master > origin's default. Null if none. */
export async function resolveMainBranch(repoPath: string): Promise<string | null> {
  const git = simpleGit(repoPath)
  const local = (await git.raw(['branch', '--format=%(refname:short)']))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (local.includes('main')) return 'main'
  if (local.includes('master')) return 'master'
  try {
    const sym = (await git.raw(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).trim()
    const mapped = sym.replace(/^origin\//, '')
    if (mapped && local.includes(mapped)) return mapped
  } catch {
    /* no origin/HEAD — ignore */
  }
  return null
}

/** Position of the worktree's branch relative to main, for the header graph. */
export async function getWorktreeGraph(
  worktreePath: string,
  fallbackMain?: string
): Promise<WorktreeGraph> {
  const git = simpleGit(worktreePath)
  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim() || 'HEAD'
  const mainBranch = (await resolveMainBranch(worktreePath)) ?? fallbackMain
  if (!mainBranch) throw new Error('No main/master branch found to compare against.')
  const aheadCount =
    parseInt((await git.raw(['rev-list', '--count', `${mainBranch}..HEAD`])).trim(), 10) || 0
  const behind =
    parseInt((await git.raw(['rev-list', '--count', `HEAD..${mainBranch}`])).trim(), 10) || 0
  const ahead: WorktreeCommit[] =
    aheadCount > 0
      ? (await git.raw(['log', `${mainBranch}..HEAD`, '--format=%h%x00%s']))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [hash, subject] = line.split('\0')
            return { hash, subject }
          })
      : []
  const baseRaw = (await git.raw(['merge-base', mainBranch, 'HEAD'])).trim()
  return { branch, mainBranch, ahead, behind, baseHash: baseRaw.slice(0, 7) }
}

export async function getWorktreeDiff(worktreePath: string): Promise<WorktreeDiffStat> {
  const git = simpleGit(worktreePath)
  const out = await git.raw(['diff', 'HEAD', '--numstat'])
  let added = 0
  let deleted = 0
  let files = 0
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d] = line.split('\t')
    files++
    if (a && a !== '-') added += parseInt(a, 10) || 0
    if (d && d !== '-') deleted += parseInt(d, 10) || 0
  }
  // Untracked files are invisible to `git diff HEAD`; count their lines
  // separately so new files contribute to the diff stat shown in the UI.
  const untracked = await git.raw(['ls-files', '--others', '--exclude-standard'])
  for (const name of untracked.split('\n').filter(Boolean)) {
    try {
      const content = readFileSync(join(worktreePath, name), 'utf8')
      // Count lines: split on \n; a trailing empty string after the
      // final newline does not represent a line. Match wc -l semantics.
      const lines = content.split('\n')
      const count = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
      added += count
      files++
    } catch {
      // binary or unreadable — skip
    }
  }
  const status = await git.raw(['status', '--porcelain'])
  return { added, deleted, files, hasChanges: status.trim().length > 0 }
}

/** Full unified-diff content of the worktree vs HEAD, parsed into files/hunks/lines
 * for the IDE-style diff panel. Tracked changes only (matches the header's numstat). */
export async function getWorktreeUnifiedDiff(worktreePath: string): Promise<WorktreeDiff> {
  const git = simpleGit(worktreePath)
  const out = await git.raw(['diff', 'HEAD', '--no-color'])
  return parseUnifiedDiff(out)
}

/** Parse `git diff` unified output into structured files. Robust to renames,
 * binary files, and the "\ No newline at end of file" marker. */
function parseUnifiedDiff(diff: string): WorktreeDiff {
  const files: WorktreeDiffFile[] = []
  let file: WorktreeDiffFile | null = null
  let hunk: WorktreeDiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (file) files.push(file)
      file = { path: '', added: 0, deleted: 0, binary: false, hunks: [] }
      hunk = null
      continue
    }
    if (!file) continue
    // Deletion: '+++ /dev/null' — fall back to the '---' path already captured.
    if (line.startsWith('--- ')) {
      if (!file.path) {
        const p = line.slice(4)
        if (p !== '/dev/null') file.path = p.startsWith('a/') ? p.slice(2) : p
      }
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4)
      if (p !== '/dev/null') file.path = p.startsWith('b/') ? p.slice(2) : p
      continue
    }
    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) { oldNo = +m[1]; newNo = +m[2] }
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (line.startsWith('Binary files')) {
      file.binary = true
      continue
    }
    if (!hunk || line === '' || line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      hunk.lines.push({ type: 'add', newNo: newNo++, text: line.slice(1) })
      file.added++
    } else if (line.startsWith('-')) {
      hunk.lines.push({ type: 'del', oldNo: oldNo++, text: line.slice(1) })
      file.deleted++
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text: line.slice(1) })
    }
  }
  if (file) files.push(file)
  return { files }
}

/** Stage everything and commit to the worktree branch. */
export async function commitWorktree(worktreePath: string, message: string): Promise<void> {
  const git = simpleGit(worktreePath)
  await git.raw(['add', '-A'])
  // simpleGit.raw does not reject on "nothing to commit"; treat it as a no-op
  // (the UI gates the button on hasChanges, so this is just a race fallback).
  const staged = await git.raw(['diff', '--cached', '--numstat'])
  if (!staged.trim()) return
  await git.raw(['commit', '-q', '-m', message])
}

/** Merge the worktree branch into main, run from the main working tree. */
export async function mergeWorktreeToMain(
  workspacePath: string,
  branch: string,
  mainBranch: string
): Promise<void> {
  const git = simpleGit(workspacePath)
  const cur = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
  if (!cur || cur === 'HEAD') {
    throw new Error(`Main working tree is in detached HEAD. Check out ${mainBranch} first.`)
  }
  if (cur !== mainBranch) {
    throw new Error(`Main working tree is on '${cur}', not '${mainBranch}'. Switch to ${mainBranch} first.`)
  }
  // simpleGit.raw does not reject on a conflicted merge (no "error:" marker),
  // so detect unmerged paths explicitly and abort to keep the tree usable.
  let hardErr: unknown = null
  try {
    await git.raw(['merge', '--no-edit', branch])
  } catch (e) {
    hardErr = e
  }
  const conflict = (await git.raw(['diff', '--name-only', '--diff-filter=U'])).trim().length > 0
  if (conflict || hardErr) {
    try {
      await git.raw(['merge', '--abort'])
    } catch {
      /* not in a merge state */
    }
    if (conflict) {
      throw new Error(
        `Merge aborted: ${branch} conflicts with ${mainBranch}. Rebase this worktree first (conflicts open in the Conflicts panel), then merge.`
      )
    }
    throw hardErr
  }
}

/** True when a rebase is paused in <worktreePath> (interactive or apply backend). */
export async function isRebasing(worktreePath: string): Promise<boolean> {
  const git = simpleGit(worktreePath)
  const dirs = (await git.raw(['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply']))
    .trim()
    .split('\n')
  return dirs.some((d) => existsSync(resolve(worktreePath, d)))
}

/** Paused-rebase flag + unmerged paths, for the header's Conflicts button. */
export async function getConflictInfo(worktreePath: string): Promise<ConflictInfo> {
  const git = simpleGit(worktreePath)
  const files = (await git.raw(['diff', '--name-only', '--diff-filter=U']))
    .trim()
    .split('\n')
    .filter(Boolean)
  return { rebasing: await isRebasing(worktreePath), files }
}

/** Resolve <file> relative to the worktree, rejecting escapes ('..', absolute). */
function worktreeFilePath(worktreePath: string, file: string): string {
  const abs = resolve(worktreePath, file)
  const root = resolve(worktreePath)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`Path escapes worktree: ${file}`)
  return abs
}

/** Read a worktree file (conflict markers included) for the Conflicts panel. */
export function readWorktreeFile(worktreePath: string, file: string): string {
  return readFileSync(worktreeFilePath(worktreePath, file), 'utf8')
}

/** Resolve one conflicted file — keep a side or write final content — and stage it. */
export async function resolveConflictFile(
  worktreePath: string,
  file: string,
  resolution: ConflictResolution
): Promise<void> {
  const abs = worktreeFilePath(worktreePath, file)
  const git = simpleGit(worktreePath)
  if (resolution === 'ours' || resolution === 'theirs') {
    await git.raw(['checkout', `--${resolution}`, '--', file])
  } else {
    writeFileSync(abs, resolution.content)
  }
  await git.raw(['add', '--', file])
}

/** Rebase the worktree branch onto main. Agent worktrees are routinely dirty,
 * so uncommitted changes are stashed around the rebase (--autostash). On
 * conflict the rebase is left PAUSED for the Conflicts panel to resolve. */
export async function rebaseWorktree(worktreePath: string, mainBranch: string): Promise<void> {
  const git = simpleGit(worktreePath)
  try {
    await git.raw(['rebase', '--autostash', mainBranch])
  } catch (e) {
    if (await isRebasing(worktreePath)) {
      throw new Error(`Conflicts replaying onto ${mainBranch} — resolve them in the Conflicts panel.`)
    }
    throw new Error(`Rebase failed: ${(e instanceof Error ? e.message : String(e)).trim()}`)
  }
}

/** Continue a paused rebase after conflicts were staged. core.editor=true (the
 * no-op binary, a fixed value — hence the unsafe opt-in) keeps the original
 * commit messages instead of blocking on an editor the main process lacks. */
export async function continueRebase(worktreePath: string): Promise<void> {
  const git = simpleGit(worktreePath, { unsafe: { allowUnsafeEditor: true } })
  let detail = ''
  try {
    await git.raw(['-c', 'core.editor=true', 'rebase', '--continue'])
  } catch (e) {
    detail = (e instanceof Error ? e.message : String(e)).trim()
  }
  // git prints "needs merge" to stdout with an empty stderr, which simple-git
  // does not treat as a failure — verify completion by state, not exit code.
  if (!(await isRebasing(worktreePath))) return
  const { files } = await getConflictInfo(worktreePath)
  throw new Error(
    files.length > 0
      ? `Conflicts remain in ${files.length} file(s) — resolve them all, then continue.`
      : `Continue failed: ${detail || 'rebase is still in progress.'}`
  )
}

/** Abort a paused rebase, restoring the branch (and autostash) as it was. */
export async function abortRebase(worktreePath: string): Promise<void> {
  await simpleGit(worktreePath).raw(['rebase', '--abort'])
}
