'use strict'

/// Run the submodule client's `npm test` and decide whether the failures are ours.
///
///   node scripts/client-test-ours.js <submodule-root> <base-sha>
///
/// The fourth ownership-scoped gate, and the last unscoped one in Step 3.
/// `clippy-ours.js`, `check-ours.js` and the prettier pathspec all block only
/// on files this branch changed; `npm test` next to them was still whole-tree,
/// and on 2026-10-10 that stalled the protocol-118 sync for the whole morning
/// while the live server refused every player.
///
/// What stalled it was upstream's own gap, introduced in the release being
/// synced: Julian's `41471fcb` adds a selectable ranger face and a test for it,
/// but the shipped `client/public/models/characters/modular_male/face_*.glb`
/// were never added to `assets.lock` — only the Tripo *source* assets under
/// `assets/modular_human_male_01/faces/` are pinned. Upstream's CI never sees
/// it because it fetches two unrelated models, `base.glb` stays absent, and the
/// suite's own `describe.skipIf` guard skips the file wholesale. Our broader
/// asset fetch is what makes the latent bug fire. No commit of ours touches
/// `client/src/lib/utils/characterModel.test.ts`.
///
/// Scoped the same way as its three siblings, and strict in the same way
/// `test-ours.js` is: a failing test reports where the assertion lives, not
/// what broke it, so file ownership alone would wave through exactly the case
/// where our rebase breaks an upstream test. A failure is excused only when
/// BOTH hold:
///
///   1. the failing test file is not one this branch changed, and
///   2. it also fails on the pristine release base, with none of our commits.
///
/// (2) is what carries the argument — a direct measurement of "would this have
/// failed without us?". It costs a second vitest run over just the failing
/// files, and only when something already failed, so the green path pays
/// nothing.
///
/// A base worktree shares `node_modules`, the generated `src/lib/wasm` and
/// `public/` with the checkout under test, because all three are build outputs
/// rather than source. That sharing is only honest while our branch leaves the
/// dependency manifests alone, so touching either one blocks instead.

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/// Build outputs, not source: safe to share with the base worktree.
const SHARED = ['node_modules', 'src/lib/wasm', 'public']

/// Touching either means the base cannot borrow our `node_modules`.
const MANIFESTS = ['client/package.json', 'client/package-lock.json']

const [submoduleRoot, baseSha] = process.argv.slice(2)
if (!submoduleRoot || !baseSha) {
  console.error('usage: node scripts/client-test-ours.js <submodule-root> <base-sha>')
  process.exit(2)
}

const root = path.resolve(submoduleRoot)
const clientDir = path.join(root, 'client')
const CLEAN_ENV = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }

function ourFiles() {
  const out = execFileSync('git', ['-C', root, 'diff', '--name-only', `${baseSha}..HEAD`], {
    encoding: 'utf8',
  })
  return new Set(out.split('\n').filter(Boolean))
}

/// `npm test` is `generate:csv && vitest run`; appending the reporter flags
/// lands them on `vitest run`, so the generator still runs exactly as the
/// unscoped gate ran it. The default reporter stays on so a human reading the
/// log sees the same failure text as before.
function runTests(cwd, files = []) {
  const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'client-test-')), 'r.json')
  const args = [
    'test',
    '--',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${outputFile}`,
    ...files,
  ]
  const r = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: CLEAN_ENV,
  })
  let report = null
  try {
    report = JSON.parse(fs.readFileSync(outputFile, 'utf8'))
  } catch {
    // Left null: the caller decides, because "no report" is not "no failures".
  }
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status, report }
}

/// Failing suites, as repo-relative paths. A suite that fails to *collect* (a
/// missing module, a throwing import) is reported the same way as a failing
/// assertion, which is what we want — it is still a red gate.
function failedSuites(report, dir) {
  const files = new Set()
  for (const suite of report?.testResults || []) {
    if (suite.status !== 'failed') continue
    const rel = path.relative(dir, suite.name)
    files.add(rel.startsWith('..') ? suite.name : `client/${rel}`)
  }
  return [...files]
}

console.log(`client-test-ours: running the scoped client test gate in ${clientDir}`)
const first = runTests(clientDir)

if (first.code === 0) {
  console.log('npm test: all green.')
  process.exit(0)
}

if (!first.report) {
  console.error('npm test failed and wrote no JSON report — treating as blocking.')
  console.error(first.out.slice(-8000))
  process.exit(1)
}

const failures = failedSuites(first.report, clientDir)
if (failures.length === 0) {
  console.error('npm test exited non-zero but no failing suite was parsed — treating as blocking.')
  console.error(first.out.slice(-8000))
  process.exit(1)
}

const ours = ourFiles()
const mine = failures.filter((f) => ours.has(f))

if (mine.length) {
  console.error(`npm test: ${mine.length} failing suite(s) in files this branch changed — blocking:`)
  for (const f of mine) console.error(`  ours      ${f}`)
  console.error('')
  console.error(first.out.slice(-8000))
  process.exit(1)
}

const touchedManifest = MANIFESTS.filter((f) => ours.has(f))
if (touchedManifest.length) {
  console.error(
    `npm test: ${failures.length} failing suite(s) upstream owns, but this branch changed ${touchedManifest.join(' and ')} —`,
  )
  console.error('the base cannot share our node_modules, so "would it fail without us?" cannot be')
  console.error('answered honestly here. Blocking rather than guessing:')
  for (const f of failures) console.error(`  unverifiable  ${f}`)
  process.exit(1)
}

console.log(`npm test: ${failures.length} failing suite(s), all in upstream-owned files:`)
for (const f of failures) console.log(`  upstream  ${f}`)
console.log(`Re-running just those on the pristine base ${baseSha} to confirm we did not cause them.`)

const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'client-test-base-'))
let base
try {
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', wt, baseSha], { stdio: 'ignore' })
  for (const rel of SHARED) {
    const from = path.join(clientDir, rel)
    if (!fs.existsSync(from)) continue
    const to = path.join(wt, 'client', rel)
    fs.rmSync(to, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.symlinkSync(from, to)
  }
  // A suite upstream deleted or renamed since the base cannot be run there;
  // it is upstream's by construction, so drop it from the comparison.
  const present = failures.filter((f) => fs.existsSync(path.join(wt, f)))
  const gone = failures.filter((f) => !present.includes(f))
  for (const f of gone) console.log(`  (absent on the base, so not ours: ${f})`)
  base = present.length
    ? runTests(path.join(wt, 'client'), present.map((f) => f.replace(/^client\//, '')))
    : { code: 1, report: { testResults: [] }, out: '' }
  if (present.length && !base.report) {
    console.error('the base run wrote no JSON report — blocking rather than guessing.')
    console.error(base.out.slice(-8000))
    process.exit(1)
  }
  const stillFailing = new Set(failedSuites(base.report, path.join(wt, 'client')))
  const causedByUs = present.filter((f) => !stillFailing.has(f))
  if (causedByUs.length) {
    console.error(
      `npm test: ${causedByUs.length} of those pass on the base — our rebase broke them, not upstream. Blocking:`,
    )
    for (const f of causedByUs) console.error(`  ours-by-effect  ${f}`)
    process.exit(1)
  }
} catch (err) {
  console.error('could not build the base worktree to compare against — blocking rather than guessing.')
  console.error(String(err.message || err))
  process.exit(1)
} finally {
  try {
    execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', wt], { stdio: 'ignore' })
  } catch {}
}

console.log('npm test: every failure reproduces on the pristine base — upstream’s, not ours. Continuing.')
process.exit(0)
