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

test('agent binary resolution selects the Windows executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-binary-'))
  try {
    const unixBinary = path.join(dir, 'agent-client')
    const windowsBinary = path.join(dir, 'agent-client.exe')
    fs.writeFileSync(unixBinary, 'unix')
    fs.writeFileSync(windowsBinary, 'windows')

    const helper = path.join(ROOT, 'scripts', 'find-agent-binary.js')
    const result = execFileSync(process.execPath, [helper, dir, 'win32'], {
      encoding: 'utf8',
    })

    assert.equal(result, `${windowsBinary}\n`)
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

test('desktop packages use the public app identity and branded icons', () => {
  const manifest = require('../package.json')

  assert.equal(manifest.name, 'openmmo-agent-ui')
  assert.equal(manifest.build.productName, 'openmmo-agent-ui')
  for (const platform of ['mac', 'win', 'linux']) {
    const icon = manifest.build[platform].icon
    assert.match(icon, /^assets\/icon\.(?:icns|ico|png)$/)
    assert.ok(fs.statSync(path.join(ROOT, icon)).size > 0, `${platform} icon is empty`)
  }
})

test('draft release commands have explicit repository context', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'release.yml'),
    'utf8',
  )

  assert.match(workflow, /GH_REPO: \$\{\{ github\.repository \}\}/)
})
