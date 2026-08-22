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
  assert.equal(manifest.build.productName, 'OpenMMO Agent UI')
  assert.equal(manifest.build.mac.notarize, true)
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

test('macOS releases require Apple notarization and Gatekeeper verification', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'release.yml'),
    'utf8',
  )

  assert.match(workflow, /secrets\.APPLE_API_KEY/)
  assert.match(workflow, /secrets\.APPLE_API_KEY_ID/)
  assert.match(workflow, /secrets\.APPLE_API_ISSUER/)
  assert.match(workflow, /xcrun stapler validate "\$app"/)
  assert.match(workflow, /spctl --assess --type execute --verbose=4 "\$app"/)
  assert.doesNotMatch(workflow, /CSC_IDENTITY_AUTO_DISCOVERY/)
})

test('the update channel file yields the version, artifact, and checksum it names', () => {
  const { parseFeed } = require('../scripts/verify-update-feed.js')
  const channel = [
    'version: 0.31.0',
    'files:',
    '  - url: openmmo-agent-v0.31.0-p35-macos-arm64.zip',
    '    sha512: nested-must-not-win',
    '    size: 191',
    'path: openmmo-agent-v0.31.0-p35-macos-arm64.zip',
    'sha512: top-level-checksum',
    "releaseDate: '2026-08-19T00:00:00.000Z'",
    '',
  ].join('\n')

  assert.deepEqual(parseFeed(channel), {
    version: '0.31.0',
    file: 'openmmo-agent-v0.31.0-p35-macos-arm64.zip',
    sha512: 'top-level-checksum',
  })
})

// A packaged build carries the dungeon layout fingerprint in three places
// filled from two implementations of one hash: build-info.json from
// scripts/layout-version.js, the agent-client binary and the shared wasm from
// the checkout's shared/build.rs. v0.33.0's Windows package had them disagree
// (build.rs hashed `src/dungeon\gen.rs`, path separator and all), so its own
// pre-flight passed while the agent and the web client were both refused.
function stagedTree(fingerprint, { binaryName = 'agent-client', stamped = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-staged-'))
  const wasmDir = path.join(dir, 'client', 'assets')
  fs.mkdirSync(path.join(dir, 'agent-client'), { recursive: true })
  fs.mkdirSync(wasmDir, { recursive: true })
  // `+layout.` and the fingerprint are separate constants in the real binary —
  // stamp_layout_version only joins them at run time — so they are apart here.
  const rodata = (hex) => `${stamped ? 'boss\0\0+layout.\0' : 'boss\0\0'}pad\0${hex}id,name,model\0`
  fs.writeFileSync(path.join(dir, 'agent-client', binaryName), rodata(fingerprint))
  fs.writeFileSync(path.join(wasmDir, 'onlinerpg_shared_bg-yNGynPUN.wasm'), rodata(fingerprint))
  // Rides along in dist/ with no fingerprint to disagree about.
  fs.writeFileSync(path.join(wasmDir, 'draco_decoder-Z1_iN-Ht.wasm'), 'no stamp here\0')
  return dir
}

test('staged layout check passes when the binary and wasm carry the stamped fingerprint', () => {
  const dir = stagedTree('42152d4091619267')
  try {
    const { check } = require('../scripts/verify-staged-layout.js')
    assert.deepEqual(check(dir, '42152d4091619267'), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('staged layout check catches a Windows build fingerprinted off its own paths', () => {
  const dir = stagedTree('a40deade30f81320', { binaryName: 'agent-client.exe' })
  try {
    const { check } = require('../scripts/verify-staged-layout.js')
    const problems = check(dir, '42152d4091619267')

    assert.equal(problems.length, 3)
    assert.match(problems[0], /agent-client\.exe does not carry layout 42152d4091619267$/)
    assert.match(problems[1], /onlinerpg_shared_bg-.*\.wasm does not carry layout 42152d4091619267$/)
    // Names what it was really built with, so the failure reads as a bug
    // rather than as a missing rebuild.
    assert.match(problems[2], /built stamped with: .*a40deade30f81320/)
    // draco has no fingerprint and must not be dragged into the complaint.
    assert.ok(!problems.some((problem) => problem.includes('draco')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('staged layout check rejects a binary from a checkout predating the stamp', () => {
  const dir = stagedTree('42152d4091619267', { stamped: false })
  try {
    const { check } = require('../scripts/verify-staged-layout.js')
    assert.deepEqual(check(dir, '42152d4091619267'), [
      `${path.join(dir, 'agent-client', 'agent-client')} carries no +layout stamp, ` +
        'but this build claims 42152d4091619267',
    ])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('staging runs the layout check on whatever it just copied', () => {
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'package-resources.sh'), 'utf8')

  assert.match(script, /verify-staged-layout\.js" "\$out" "\$layout"/)
})
