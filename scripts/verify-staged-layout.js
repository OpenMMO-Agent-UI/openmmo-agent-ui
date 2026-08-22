'use strict'

/// Does what we staged actually speak the dungeon layout we stamped into
/// build-info.json?
///
///   node scripts/verify-staged-layout.js <staged-dir> <expected-fingerprint>
///
/// The pieces of a package carry that fingerprint from different places:
/// build-info.json gets it from scripts/layout-version.js, while the
/// agent-client binary and the web client's wasm carry whatever
/// `shared/build.rs` computed when cargo and wasm-pack built them. Those agree
/// only as long as the Rust and JS sides hash identically — and they did not
/// on Windows, where `read_dir` spells its entries `src/dungeon\gen.rs` and
/// the path bytes go into the hash. v0.33.0 shipped a Windows package stamped
/// 42152d4091619267 whose binary and wasm both said a40deade30f81320: the
/// desktop app's own pre-flight passed, and every handshake that mattered was
/// refused with "This build's dungeon layouts differ from the server's".
///
/// Nothing else in the release gates on this. `npm test` runs on Linux, where
/// the two sides agree, so a host-dependent fingerprint stays invisible until
/// a user on that host cannot log in. Reading it back out of the staged bytes
/// is the only check that runs on the machine that built them.
///
/// `+layout.` and the fingerprint are separate string constants — the binary
/// only joins them at run time (shared/src/lib.rs stamp_layout_version) — so
/// the tag marks a file as one that stamps, and the fingerprint is looked for
/// on its own.

const fs = require('node:fs')
const path = require('node:path')

const TAG = Buffer.from('+layout.')
/// Bounded so the fingerprint is not read out of the middle of a longer hex
/// run. Rust packs rodata without separators — the stamp sits between a NUL
/// and the next literal — so this is about the neighbours, not delimiters.
const CANDIDATE = /(?<![0-9a-fA-F])[0-9a-f]{16}(?![0-9a-fA-F])/g

/// Files under `dir` that stamp a layout fingerprint at all: the agent-client
/// binary, and the shared wasm the web client loads. draco and basis ride
/// along in dist/ and have no fingerprint to disagree about.
function stampingFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return stampingFiles(file)
    if (!entry.isFile()) return []
    return fs.readFileSync(file).includes(TAG) ? [file] : []
  })
}

/// What `file` looks like it was stamped with, for a failure message. A whole
/// binary yields a handful of these; the wrong one is normally among them.
function candidates(file) {
  const text = fs.readFileSync(file).toString('latin1')
  return [...new Set(Array.from(text.matchAll(CANDIDATE), (m) => m[0]))]
}

/// Problems with the staged tree, as lines. Empty means every piece that
/// stamps a fingerprint stamps `expected`.
function check(stagedDir, expected) {
  const agentDir = path.join(stagedDir, 'agent-client')
  const binary = ['agent-client', 'agent-client.exe']
    .map((name) => path.join(agentDir, name))
    .find((candidate) => fs.existsSync(candidate))
  if (!binary) return [`no agent-client binary staged under ${agentDir}`]

  // The binary is named separately from the sweep below: a binary carrying no
  // tag at all predates the stamp, which the server refuses just as flatly as
  // a wrong one — and this tree claims a fingerprint, so the two came from
  // different checkouts.
  const stamping = stampingFiles(path.join(stagedDir, 'client'))
  if (fs.readFileSync(binary).includes(TAG)) stamping.unshift(binary)
  else return [`${binary} carries no +layout stamp, but this build claims ${expected}`]

  const wanted = Buffer.from(expected)
  const problems = stamping
    .filter((file) => !fs.readFileSync(file).includes(wanted))
    .map((file) => `${file} does not carry layout ${expected}`)
  if (problems.length) problems.push(`these were built stamped with: ${sharedCandidates(stamping)}`)
  return problems
}

/// What the offending build was stamped with instead, for the failure
/// message. A whole binary holds a few dozen hex runs that merely look like a
/// fingerprint; the real one is in every piece built from the same sources at
/// once, so intersecting them is what narrows the list to something readable.
function sharedCandidates(files) {
  const shared = files
    .map((file) => new Set(candidates(file)))
    .reduce((a, b) => new Set([...a].filter((hex) => b.has(hex))))
  return [...shared].join(', ') || 'nothing that looks like a fingerprint'
}

module.exports = { check, stampingFiles, candidates }

if (require.main === module) {
  const [stagedDir, expected] = process.argv.slice(2)
  if (!stagedDir || !/^[0-9a-f]{16}$/.test(expected ?? '')) {
    process.stderr.write('usage: verify-staged-layout.js <staged-dir> <expected-fingerprint>\n')
    process.exit(2)
  }
  const problems = check(stagedDir, expected)
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`${problem}\n`)
    process.stderr.write(
      'This package would be refused at the handshake. Rebuild the pinned\n' +
        'checkout on this machine so cargo and wasm-pack restamp LAYOUT_VERSION:\n' +
        '  scripts/build-resources.sh <checkout>\n',
    )
    process.exit(1)
  }
  process.stdout.write(`staged layout ${expected} confirmed in ${stagedDir}\n`)
}
