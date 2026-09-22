'use strict'

/// Fold a sync's adaptation commits back into the logical commits they belong
/// to, so `tweak-agent-client` stays a fixed-size patch stack.
///
///   node scripts/fold-tweak-fixups.js <submodule-root> <base-sha> <logical-sha>...
///
/// `tweak-agent-client` is our customizations rebased onto each upstream
/// release. It should hold exactly the features we carry — today two:
/// the observer/spectator client and the rule-based workers. It does not,
/// because every release that breaks a patch gets its fix recorded as a new
/// commit on top instead of folded into the feature it repairs. Measured at
/// the protocol tags, the stack went 2 → 3 → 5 → 6 → 7 → 8 → 10 between v79
/// and v93 before Tony squashed it back by hand.
///
/// That growth is not cosmetic. Every rebase replays every commit, and a fix
/// usually touches the same lines as the commit it repairs — so the same
/// hunk conflicts again on each release, and conflicts are where an
/// unattended rebase is most likely to choose wrong (the protocol-57 sync
/// hit one in `shared/build.rs`, which computes the dungeon layout
/// fingerprint: resolve that wrong and every gate stays green while every
/// player is refused). The intermediate commits are also unbuildable on
/// their own — `rule-based workers` alone still referenced `Monster.owner_id`
/// after upstream removed it, and only compiled once a later fixup landed —
/// so bisect, cherry-pick and reviewing one commit all stop meaning anything.
///
/// Ownership: a fix belongs to the logical commit that last touched the files
/// it changes, and that is transitive — once a fix is folded into a commit,
/// the files it touched belong to that commit too, so a later fix landing on
/// a file an earlier fix introduced resolves instead of looking unowned.
///
/// A fix whose files are *all* upstream's is the one case with no honest
/// answer from ownership alone. It falls back to the top-level area it lives
/// in, and is reported: folding it silently would hide that we now carry a
/// patch on a file we do not own, and carrying one is what makes that file
/// ours to keep gating on forever (see check-ours.js). Anything still
/// ambiguous stops the run rather than guessing.
///
/// The invariant, asserted at the end: folding must not change the tree by
/// one byte. Verified against protocol-v93-r1 — ten commits folded to two,
/// `git diff` against the pre-fold tip empty.

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/// Which feature owns a top-level directory, for the upstream-file fallback.
const AREA_OF = { client: 0, 'agent-client': 1 }

const [root, base, ...logical] = process.argv.slice(2)
if (!root || !base || logical.length === 0) {
  console.error(
    'usage: node scripts/fold-tweak-fixups.js <submodule-root> <base-sha> <logical-sha>...'
  )
  process.exit(2)
}
const repo = path.resolve(root)

const git = (...args) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const filesOf = (sha) =>
  git('show', '--name-only', '--format=', sha)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

const full = (sha) => git('rev-parse', sha).trim()

if (process.env.FOLD_TODO) {
  // Re-entry: git is asking us to edit the rebase todo.
  const plan = JSON.parse(fs.readFileSync(process.env.FOLD_TODO, 'utf8'))
  const todoPath = process.argv[process.argv.length - 1]
  const picks = new Map()
  for (const line of fs.readFileSync(todoPath, 'utf8').split('\n')) {
    if (line.startsWith('pick ')) picks.set(full(line.split(' ')[1]), line)
  }
  const out = []
  for (const [sha, line] of picks) {
    if (!plan.logical.includes(sha)) continue
    out.push(line)
    for (const f of plan.attach[sha] || []) out.push(`fixup ${picks.get(f).split(' ').slice(1).join(' ')}`)
  }
  fs.writeFileSync(todoPath, out.join('\n') + '\n')
  process.exit(0)
}

const logicalFull = logical.map(full)
const owner = new Map()
logicalFull.forEach((lc) => filesOf(lc).forEach((f) => owner.set(f, lc)))

const order = git('rev-list', '--reverse', `${base}..HEAD`)
  .split('\n')
  .filter(Boolean)

const attach = {}
const carried = []
const unresolved = []
for (const sha of order) {
  if (logicalFull.includes(sha)) continue
  const changed = filesOf(sha)
  const targets = new Set(changed.map((f) => owner.get(f)).filter(Boolean))
  let target = null
  if (targets.size === 1) {
    target = [...targets][0]
  } else if (targets.size === 0) {
    const areas = new Set(changed.map((f) => f.split('/')[0]))
    if (areas.size === 1 && AREA_OF[[...areas][0]] !== undefined) {
      target = logicalFull[AREA_OF[[...areas][0]]]
      carried.push({ sha: sha.slice(0, 8), files: changed })
    }
  }
  if (!target) {
    unresolved.push({ sha: sha.slice(0, 8), spans: [...targets].map((s) => s.slice(0, 8)), changed })
    continue
  }
  ;(attach[target] ||= []).push(sha)
  changed.forEach((f) => owner.has(f) || owner.set(f, target))
}

for (const c of carried) {
  console.log(`carrying a patch on upstream-owned file(s) — folded into its area: ${c.sha}`)
  for (const f of c.files) console.log(`    ${f}`)
}

if (unresolved.length) {
  console.error('cannot attribute these commits to one logical commit — stopping rather than guessing:')
  for (const u of unresolved) {
    console.error(`  ${u.sha}  spans [${u.spans.join(', ') || 'nothing we own'}]`)
    for (const f of u.changed.slice(0, 6)) console.error(`      ${f}`)
  }
  process.exit(1)
}

const before = git('rev-parse', 'HEAD').trim()
if (Object.values(attach).every((v) => v.length === 0)) {
  console.log(`nothing to fold: already ${logicalFull.length} logical commit(s).`)
  process.exit(0)
}

const planFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fold-')), 'plan.json')
fs.writeFileSync(planFile, JSON.stringify({ logical: logicalFull, attach }))

const r = spawnSync('git', ['-C', repo, 'rebase', '-i', base], {
  encoding: 'utf8',
  env: {
    ...process.env,
    FOLD_TODO: planFile,
    GIT_SEQUENCE_EDITOR: `node ${__filename} ${repo} ${base} ${logical.join(' ')}`,
  },
})
if (r.status !== 0) {
  console.error('rebase failed while folding; the branch is left for inspection.')
  console.error(`${r.stdout || ''}${r.stderr || ''}`.slice(-4000))
  process.exit(1)
}

// The whole point: folding rearranges history, never content.
const diff = spawnSync('git', ['-C', repo, 'diff', '--quiet', before, 'HEAD'])
if (diff.status !== 0) {
  console.error('folding changed the tree — this must never happen. Inspect before pushing:')
  console.error(git('diff', '--stat', before, 'HEAD'))
  process.exit(1)
}

const left = git('rev-list', '--count', `${base}..HEAD`).trim()
console.log(`folded to ${left} logical commit(s); tree identical to ${before.slice(0, 8)}.`)
if (Number(left) !== logicalFull.length) {
  console.error(`expected ${logicalFull.length} — something was not folded.`)
  process.exit(1)
}
process.exit(0)
