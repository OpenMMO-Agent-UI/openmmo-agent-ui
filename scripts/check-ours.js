'use strict'

/// Run the submodule client's `npm run check` and decide whether its errors
/// are ours to fix.
///
///   node scripts/check-ours.js <submodule-root> <base-sha>
///
/// Same policy the Rust and prettier gates in Step 3 already use, one level
/// down: block on what we ship and customize, report what is upstream's and
/// keep going. `cargo clippy` is scoped to the three crates we ship because
/// `large-enum-variant` in Julian's `server/` blocked the v0.38.0 sync;
/// prettier is scoped to our changed files because four of Julian's own
/// files blocked v0.39.0. `npm run check` was still whole-tree, and on
/// 2026-09-03 upstream's own `events.test.ts` mock — missing `eatMeal` after
/// upstream 5230934 changed the interface without updating that one mock —
/// blocked the protocol-51 sync for 5.5 hours while every player sat locked
/// out of a v51 server.
///
/// Ownership is decided by `git diff <base>..HEAD`, not by severity or by
/// which directory a file sits in: a file this branch touches is ours even
/// if upstream wrote it first, and a file we never touch is upstream's even
/// when the error looks trivial. That cuts the right way in both directions.
/// The duplicate-key case is why: if we ever carry a patch to an upstream
/// file and upstream later fixes the same bug differently, the rebase
/// silently produces `eatMeal: vi.fn(),` twice, and `npm run check` is the
/// *only* gate that catches it — `npm test` (622 passing) and `npm run lint`
/// (exit 0) both sail past a duplicate object key. Because that file would
/// then be one we touch, it stays blocking. Measured, not assumed.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const [submoduleRoot, baseSha] = process.argv.slice(2)
if (!submoduleRoot || !baseSha) {
  console.error('usage: node scripts/check-ours.js <submodule-root> <base-sha>')
  process.exit(2)
}

const root = path.resolve(submoduleRoot)
const clientDir = path.join(root, 'client')

/// Files this branch changed, relative to `client/` — the same pathspec and
/// the same `sed` the prettier gate uses, so the two gates agree on what
/// "ours" means.
function ourClientFiles() {
  const out = execFileSync(
    'git',
    ['-C', root, 'diff', '--name-only', `${baseSha}..HEAD`, '--', 'client/**'],
    { encoding: 'utf8' }
  )
  return new Set(
    out
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^client\//, ''))
  )
}

/// svelte-check prints a location line then a severity line:
///   /abs/path/client/src/lib/foo.ts:12:34
///   Error: Argument of type ...
/// Only `Error:` blocks; `Warn:` never has and is not made to here.
function errorFiles(output) {
  const lines = output.split('\n')
  const files = new Set()
  for (let i = 0; i < lines.length - 1; i++) {
    const loc = lines[i].match(/^(.*?):(\d+):(\d+)$/)
    if (!loc) continue
    if (!/^Error:/.test(lines[i + 1])) continue
    const abs = loc[1]
    // Paths are absolute and rooted at the client dir; anything else is not
    // a file we can attribute, so treat it as upstream's rather than guess.
    const rel = path.relative(clientDir, abs)
    files.add(rel.startsWith('..') ? abs : rel)
  }
  return files
}

let output = ''
try {
  output = execFileSync('npm', ['run', 'check'], {
    cwd: clientDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
  console.log('npm run check: clean')
  process.exit(0)
} catch (err) {
  // Non-zero exit is the normal "there are errors" path, not a crash.
  output = `${err.stdout || ''}${err.stderr || ''}`
  if (!output.trim()) {
    console.error('npm run check failed with no parseable output — treating as blocking')
    console.error(String(err.message || err))
    process.exit(1)
  }
}

const ours = ourClientFiles()
const failing = errorFiles(output)

if (failing.size === 0) {
  // check exited non-zero but printed no attributable Error lines. Do not
  // guess it is upstream's; that is how a broken gate reads as a pass.
  console.error('npm run check failed but no error locations were parsed — treating as blocking')
  console.error(output.slice(-4000))
  process.exit(1)
}

const mine = [...failing].filter((f) => ours.has(f)).sort()
const theirs = [...failing].filter((f) => !ours.has(f)).sort()

if (theirs.length) {
  console.log(`npm run check: ${theirs.length} upstream-owned file(s) with errors — not ours to fix:`)
  for (const f of theirs) console.log(`  upstream  ${f}`)
}

if (mine.length) {
  console.error(`npm run check: ${mine.length} file(s) this branch changed have errors — blocking:`)
  for (const f of mine) console.error(`  ours      ${f}`)
  console.error('')
  console.error(output.slice(-8000))
  process.exit(1)
}

console.log('npm run check: no errors in files this branch changed — continuing.')
process.exit(0)
