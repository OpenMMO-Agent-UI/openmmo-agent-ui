'use strict'

/// Run the submodule's clippy gate and decide whether its lints are ours.
///
///   node scripts/clippy-ours.js <submodule-root> <base-sha>
///
/// The Rust sibling of `check-ours.js`, and it exists for a failure the
/// existing mitigations could not catch. Step 3 already scopes clippy to the
/// three crates we ship, and `release-sync.yml` already pins the toolchain to
/// 1.97.1 precisely because "a fresh stable that ships a new lint blocks every
/// sync until Julian adapts". Neither helped on 2026-09-06: the protocol-57
/// sync aborted because upstream's own new fence code (Julian's `d63f4ce0`,
/// committed that day) tripped `cloned_ref_to_slice_refs` — a lint already in
/// the pinned toolchain — in `shared/src/fence.rs` and
/// `agent-client/src/state/tests/world_tests.rs`. Both crates are ones we
/// ship, so crate scoping had nothing to exclude, and the toolchain pin had
/// nothing to hold back. Ownership is the only axis that separates them.
///
/// So: block on lints in files this branch changed, report the rest as
/// upstream's, exactly as `check-ours.js` does one language over.
///
/// Two deliberate asymmetries with the type-check gate:
///
///   * Clippy runs WITHOUT `-D warnings` here. With it, the first lint fails
///     the compile and the remaining crates never get analysed, so we would be
///     deciding ownership from a truncated list. Without it, clippy reports
///     everything and exits 0; the exit code carries no signal and the JSON
///     is the whole answer. Blocking is reconstructed from ownership instead.
///   * A `level: "error"` always blocks, whoever owns the file. A lint is a
///     style opinion we can decline on upstream's behalf; a compile error
///     means the tree does not build, and there is no version of shipping it.

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const CRATES = ['agent-client', 'onlinerpg-shared', 'onlinerpg-terrain']

const [submoduleRoot, baseSha] = process.argv.slice(2)
if (!submoduleRoot || !baseSha) {
  console.error('usage: node scripts/clippy-ours.js <submodule-root> <base-sha>')
  process.exit(2)
}

const root = path.resolve(submoduleRoot)

/// Paths as cargo reports them: relative to the workspace root, which is also
/// how `git diff --name-only` spells them from `-C root`.
function ourFiles() {
  const out = execFileSync('git', ['-C', root, 'diff', '--name-only', `${baseSha}..HEAD`], {
    encoding: 'utf8',
  })
  return new Set(out.split('\n').filter(Boolean))
}

function runClippy() {
  const args = ['clippy', '--locked', '--all-targets', '--message-format=json']
  for (const c of CRATES) args.push('-p', c)
  try {
    return execFileSync('cargo', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
  } catch (err) {
    // A hard compile failure exits non-zero but still emits its diagnostics on
    // stdout. Keep them: the errors below are what we want to report.
    const out = `${err.stdout || ''}`
    if (!out.trim()) {
      console.error('cargo clippy produced no parseable output — treating as blocking')
      console.error(String(err.stderr || err.message || err))
      process.exit(1)
    }
    return out
  }
}

/// One entry per (file, line, lint), because the same lint is reported once
/// per target that compiles the file — lib and test both hit fence.rs.
function diagnostics(out) {
  const seen = new Map()
  for (const line of out.split('\n')) {
    if (!line.startsWith('{')) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.reason !== 'compiler-message' || !msg.message) continue
    const { level, spans = [], code } = msg.message
    if (level !== 'error' && level !== 'warning') continue
    const primary = spans.find((s) => s.is_primary)
    // No span means no file to attribute it to (a bare `error: could not
    // compile ...` summary). Those follow a real diagnostic we already have.
    if (!primary) continue
    const lint = code && code.code ? code.code : level
    const key = `${primary.file_name}:${primary.line_start}:${lint}`
    if (seen.has(key)) continue
    seen.set(key, {
      file: primary.file_name,
      line: primary.line_start,
      level,
      lint,
      text: (msg.message.message || '').split('\n')[0],
    })
  }
  return [...seen.values()]
}

const ours = ourFiles()
const found = diagnostics(runClippy())

const errors = found.filter((d) => d.level === 'error')
const mine = found.filter((d) => d.level === 'warning' && ours.has(d.file))
const theirs = found.filter((d) => d.level === 'warning' && !ours.has(d.file))

if (theirs.length) {
  console.log(`clippy: ${theirs.length} lint(s) in upstream-owned files — not ours to fix:`)
  for (const d of theirs) console.log(`  upstream  ${d.file}:${d.line}  ${d.lint}  ${d.text}`)
}

if (errors.length) {
  console.error(`clippy: ${errors.length} compile error(s) — blocking regardless of ownership:`)
  for (const d of errors) console.error(`  error     ${d.file}:${d.line}  ${d.text}`)
}

if (mine.length) {
  console.error(`clippy: ${mine.length} lint(s) in files this branch changed — blocking:`)
  for (const d of mine) console.error(`  ours      ${d.file}:${d.line}  ${d.lint}  ${d.text}`)
}

if (errors.length || mine.length) process.exit(1)

console.log(`clippy: no errors, and no lints in the ${ours.size} file(s) this branch changed.`)
process.exit(0)
