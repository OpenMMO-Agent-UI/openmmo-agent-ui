'use strict'

/// The dungeon layout fingerprint OpenMMO's `shared/build.rs` stamps into
/// every server and client build (`LAYOUT_VERSION`), recomputed here
/// bit-for-bit so the desktop app's own handshakes can carry the same stamp
/// the bundled agent-client does. Layouts never travel the wire — both sides
/// generate them from the entrance id — so since agent-client v0.32.0 the
/// server refuses any ClientInfo whose version string lacks
/// `+layout.<fingerprint>` or carries a different one. A desktop build that
/// stamped only the protocol number was refused at the profile test and the
/// pre-flight session, while the agent-client it shipped beside was fine.
///
///   node scripts/layout-version.js [path/to/OpenMMO checkout]
///
/// Mirrors shared/build.rs exactly: FNV-1a 64 over `../data-src/dungeons.csv`
/// plus `src/dungeon/*.rs` minus `tests.rs`, sorted by path as seen from the
/// shared/ crate, each file's path bytes then its contents with CR dropped.
/// Prints the 16-hex-digit fingerprint; exits 2 when the checkout lacks the
/// inputs (a build predating the stamp).

const fs = require('node:fs')
const path = require('node:path')

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = (1n << 64n) - 1n

function fnv1a64(seed, bytes) {
  let hash = seed
  for (const b of bytes) {
    hash ^= BigInt(b)
    hash = (hash * FNV_PRIME) & MASK64
  }
  return hash
}

/// Fingerprint of the checkout at `root` (the OpenMMO repo root), or null if
/// it has no dungeon generator to fingerprint.
function layoutVersion(root) {
  const shared = path.join(root, 'shared')
  const dungeonDir = path.join(shared, 'src', 'dungeon')
  if (!fs.existsSync(dungeonDir)) return null
  // Paths as build.rs sees them, relative to shared/ — the path bytes are part
  // of the hash, so spelling must match, separators included.
  const inputs = ['../data-src/dungeons.csv']
  for (const name of fs.readdirSync(dungeonDir)) {
    if (name.endsWith('.rs') && name !== 'tests.rs') inputs.push(`src/dungeon/${name}`)
  }
  inputs.sort()
  let hash = FNV_OFFSET
  for (const rel of inputs) {
    const bytes = fs.readFileSync(path.join(shared, rel))
    hash = fnv1a64(hash, Buffer.from(rel, 'utf8'))
    hash = fnv1a64(hash, bytes.filter((b) => b !== 0x0d))
  }
  return hash.toString(16).padStart(16, '0')
}

module.exports = { layoutVersion, fnv1a64, FNV_OFFSET }

if (require.main === module) {
  const root = process.argv[2] || path.join(__dirname, '..', 'deps', 'OpenMMO')
  const v = layoutVersion(root)
  if (!v) {
    console.error(`no dungeon generator under ${root}/shared/src/dungeon`)
    process.exit(2)
  }
  process.stdout.write(`${v}\n`)
}
