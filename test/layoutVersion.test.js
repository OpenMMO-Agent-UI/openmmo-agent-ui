const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { layoutVersion, dataInputs, fnv1a64, FNV_OFFSET } = require('../scripts/layout-version.js')

/// A stand-in for upstream's shared/build.rs, listing `paths` the way it does.
/// The fingerprint depends on which files it names, so the tests below have to
/// be able to move that list.
function buildRs(paths) {
  const listed = paths.map((p) => `        std::path::PathBuf::from("${p}"),`).join('\n')
  return `fn main() {\n    let mut inputs = vec![\n${listed}\n    ];\n}\n`
}

// shared/build.rs: FNV-1a 64 over the data files it names then src/dungeon/*.rs
// (minus tests.rs), sorted, each as path bytes then CR-stripped contents.
function expected(files) {
  const names = Object.keys(files).sort()
  let h = FNV_OFFSET
  for (const rel of names) {
    h = fnv1a64(h, Buffer.from(rel, 'utf8'))
    h = fnv1a64(h, Buffer.from(files[rel], 'utf8').filter((b) => b !== 0x0d))
  }
  return h.toString(16).padStart(16, '0')
}

test('fnv1a64 matches the reference vector', () => {
  // FNV-1a 64 of "a" is a published test vector.
  assert.equal(fnv1a64(FNV_OFFSET, Buffer.from('a')).toString(16), 'af63dc4c8601ec8c')
})

test('layoutVersion hashes the generator inputs the way shared/build.rs does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-layout-'))
  try {
    fs.mkdirSync(path.join(root, 'shared', 'src', 'dungeon'), { recursive: true })
    fs.mkdirSync(path.join(root, 'data-src'))
    fs.writeFileSync(path.join(root, 'shared', 'build.rs'), buildRs(['../data-src/dungeons.csv']))
    fs.writeFileSync(path.join(root, 'data-src', 'dungeons.csv'), 'id,name\r\nold_crypt,Old Crypt\r\n')
    fs.writeFileSync(path.join(root, 'data-src', 'monsters.csv'), 'id,name\nrat,Rat\n')
    fs.writeFileSync(path.join(root, 'shared', 'src', 'dungeon', 'mod.rs'), 'pub fn gen() {}\n')
    fs.writeFileSync(path.join(root, 'shared', 'src', 'dungeon', 'gen.rs'), 'fn rooms() {}\r\n')
    fs.writeFileSync(path.join(root, 'shared', 'src', 'dungeon', 'tests.rs'), '#[test] fn t() {}\n')
    fs.writeFileSync(path.join(root, 'shared', 'src', 'dungeon', 'notes.md'), 'ignored\n')

    const got = layoutVersion(root)
    assert.match(got, /^[0-9a-f]{16}$/)
    assert.equal(
      got,
      expected({
        '../data-src/dungeons.csv': 'id,name\nold_crypt,Old Crypt\n',
        'src/dungeon/gen.rs': 'fn rooms() {}\n',
        'src/dungeon/mod.rs': 'pub fn gen() {}\n',
      }),
    )
    // tests.rs is excluded on purpose: a test-only edit must not reload the fleet.
    fs.writeFileSync(path.join(root, 'shared', 'src', 'dungeon', 'tests.rs'), 'changed\n')
    assert.equal(layoutVersion(root), got)
    // A generator edit changes the fingerprint.
    fs.writeFileSync(path.join(root, 'shared', 'src', 'dungeon', 'gen.rs'), 'fn rooms() { 1 }\n')
    assert.notEqual(layoutVersion(root), got)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// v0.51.0 added ../data-src/monsters.csv to build.rs's list while this mirror
// still hashed dungeons.csv alone, so every package job failed its staged
// layout check and the release published nothing. The list is read from
// build.rs now; this is the test that says so.
test('layoutVersion follows the data inputs build.rs names, not a copy of the list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-layout-inputs-'))
  try {
    fs.mkdirSync(path.join(root, 'shared', 'src', 'dungeon'), { recursive: true })
    fs.mkdirSync(path.join(root, 'data-src'))
    fs.writeFileSync(path.join(root, 'shared', 'build.rs'), buildRs(['../data-src/dungeons.csv']))
    fs.writeFileSync(path.join(root, 'data-src', 'dungeons.csv'), 'id,name\nold_crypt,Old Crypt\n')
    fs.writeFileSync(path.join(root, 'data-src', 'monsters.csv'), 'id,name\nrat,Rat\n')
    fs.writeFileSync(path.join(root, 'shared', 'src', 'dungeon', 'gen.rs'), 'fn rooms() {}\n')

    const dungeonsOnly = layoutVersion(root)
    // An unlisted data file is not an input, however much it looks like one.
    fs.writeFileSync(path.join(root, 'data-src', 'monsters.csv'), 'id,name\nrat,Dire Rat\n')
    assert.equal(layoutVersion(root), dungeonsOnly)

    // Listing it makes it one, with no edit to this mirror.
    fs.writeFileSync(
      path.join(root, 'shared', 'build.rs'),
      buildRs(['../data-src/dungeons.csv', '../data-src/monsters.csv']),
    )
    const withMonsters = layoutVersion(root)
    assert.notEqual(withMonsters, dungeonsOnly)
    assert.equal(
      withMonsters,
      expected({
        '../data-src/dungeons.csv': 'id,name\nold_crypt,Old Crypt\n',
        '../data-src/monsters.csv': 'id,name\nrat,Dire Rat\n',
        'src/dungeon/gen.rs': 'fn rooms() {}\n',
      }),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('dataInputs refuses a build.rs it cannot read the list out of', () => {
  // Returning [] would hash the generator sources alone and still produce a
  // plausible 16 hex digits — a wrong fingerprint that looks like a right one.
  assert.throws(() => dataInputs('fn main() { todo!() }\n'), /needs updating/)
})

test('layoutVersion is null for a checkout predating the stamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-layout-none-'))
  try {
    assert.equal(layoutVersion(root), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
