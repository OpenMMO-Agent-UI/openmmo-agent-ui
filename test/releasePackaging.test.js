const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.join(__dirname, '..')

test('file modification time is emitted as portable epoch seconds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-mtime-'))
  const file = path.join(dir, 'agent-client')
  try {
    fs.writeFileSync(file, 'binary')
    fs.utimesSync(file, 1_700_000_000, 1_700_000_000)

    const result = execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'file-mtime.js'), file],
      { encoding: 'utf8' },
    )

    assert.equal(result, '1700000000\n')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('distribution commands never let electron-builder publish implicitly', () => {
  const scripts = require('../package.json').scripts

  for (const name of ['dist:mac', 'dist:win', 'dist:linux']) {
    assert.match(scripts[name], /electron-builder .* --publish never$/)
  }
})
