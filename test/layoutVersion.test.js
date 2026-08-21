const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { layoutVersion, fnv1a64, FNV_OFFSET } = require('../scripts/layout-version.js')

// shared/build.rs: FNV-1a 64 over ../data-src/dungeons.csv then src/dungeon/*.rs
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
    fs.writeFileSync(path.join(root, 'data-src', 'dungeons.csv'), 'id,name\r\nold_crypt,Old Crypt\r\n')
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

test('layoutVersion is null for a checkout predating the stamp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-layout-none-'))
  try {
    assert.equal(layoutVersion(root), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
