const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const CLI = path.join(__dirname, '..', 'scripts', 'release-plan.js')

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Release Plan Test',
      GIT_AUTHOR_EMAIL: 'release-plan@example.test',
      GIT_COMMITTER_NAME: 'Release Plan Test',
      GIT_COMMITTER_EMAIL: 'release-plan@example.test',
    },
  }).trim()
}

function runPlan(
  fixture,
  tag = 'v1.2.3',
  releaseState = 'absent',
  existingParentSha = '',
) {
  const args = [
    CLI,
    'plan',
    '--repo',
    fixture.parent,
    '--tag',
    tag,
    '--release-state',
    releaseState,
  ]
  if (existingParentSha) args.push('--existing-parent-sha', existingParentSha)
  return spawnSync(process.execPath, args, { encoding: 'utf8' })
}

function makeFixture(protocol = 10) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmmo-release-plan-'))
  const openmmo = path.join(root, 'OpenMMO')
  const openmmoRemote = path.join(root, 'OpenMMO.git')
  const parent = path.join(root, 'desktop')
  const parentRemote = path.join(root, 'desktop.git')

  fs.mkdirSync(openmmo)
  git(openmmo, 'init', '-b', 'integration')
  fs.mkdirSync(path.join(openmmo, 'shared', 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(openmmo, 'shared', 'src', 'lib.rs'),
    `pub const PROTOCOL_VERSION: u32 = ${protocol};\n`,
  )
  git(openmmo, 'add', '.')
  git(openmmo, 'commit', '-m', `protocol v${protocol}`)
  git(root, 'init', '--bare', '--initial-branch=integration', openmmoRemote)
  git(openmmo, 'remote', 'add', 'origin', openmmoRemote)
  git(openmmo, 'push', '-u', 'origin', 'integration')
  git(openmmo, 'tag', `agent-client/protocol-v${protocol}-r1`)
  git(openmmo, 'push', 'origin', '--tags')

  fs.mkdirSync(parent)
  git(parent, 'init', '-b', 'master')
  fs.mkdirSync(path.join(parent, 'config'))
  fs.writeFileSync(
    path.join(parent, 'config', 'release.json'),
    `${JSON.stringify({ verifiedProtocols: [protocol], fallbackProtocol: protocol }, null, 2)}\n`,
  )
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', openmmoRemote, 'deps/OpenMMO')
  git(parent, 'add', '.')
  git(parent, 'commit', '-m', 'pin OpenMMO')
  git(root, 'init', '--bare', '--initial-branch=master', parentRemote)
  git(parent, 'remote', 'add', 'origin', parentRemote)
  git(parent, 'push', '-u', 'origin', 'master')

  return {
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    openmmoSha: git(openmmo, 'rev-parse', 'HEAD'),
    parent,
    parentSha: git(parent, 'rev-parse', 'HEAD'),
    protocol,
  }
}

test('plans a reproducible draft release from a tag and pinned checkout', () => {
  const fixture = makeFixture()
  try {
    const result = runPlan(fixture)

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      version: '1.2.3',
      tag: 'v1.2.3',
      parentSha: fixture.parentSha,
      openmmoSha: fixture.openmmoSha,
      protocolVersion: fixture.protocol,
      artifactPrefix: 'openmmo-agent-v1.2.3-p10',
      artifacts: {
        linux: 'openmmo-agent-v1.2.3-p10-linux-x64.AppImage',
        macos: 'openmmo-agent-v1.2.3-p10-macos-arm64.zip',
        macosDmg: 'openmmo-agent-v1.2.3-p10-macos-arm64.dmg',
        windows: 'openmmo-agent-v1.2.3-p10-windows-x64.exe',
      },
      releaseAction: 'create',
    })
  } finally {
    fixture.cleanup()
  }
})

test('rejects a tag that is not valid v-prefixed SemVer', () => {
  const result = spawnSync(
    process.execPath,
    [CLI, 'plan', '--repo', '/missing', '--tag', 'release-1', '--release-state', 'absent'],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 1)
  assert.match(result.stderr, /valid SemVer prefixed with v/)
})

test('fetches configured submodule branch refs before validating reachability', () => {
  const fixture = makeFixture()
  try {
    const checkout = path.join(fixture.parent, 'deps', 'OpenMMO')
    git(checkout, 'update-ref', '-d', 'refs/remotes/origin/integration')
    git(checkout, 'config', '--unset-all', 'remote.origin.fetch')

    const result = runPlan(fixture)

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).openmmoSha, fixture.openmmoSha)
  } finally {
    fixture.cleanup()
  }
})

test('accepts an alphanumeric prerelease identifier with a leading zero', () => {
  const fixture = makeFixture()
  try {
    const result = runPlan(fixture, 'v1.2.3-01a+build.7')

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).version, '1.2.3-01a+build.7')
  } finally {
    fixture.cleanup()
  }
})

test('rejects a tagged parent commit outside origin/master', () => {
  const fixture = makeFixture()
  try {
    fs.writeFileSync(path.join(fixture.parent, 'unmerged.txt'), 'not on master\n')
    git(fixture.parent, 'add', 'unmerged.txt')
    git(fixture.parent, 'commit', '-m', 'unmerged work')

    const result = runPlan(fixture)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /not reachable from origin\/master/)
  } finally {
    fixture.cleanup()
  }
})

test('rejects a protocol not verified by the desktop client', () => {
  const fixture = makeFixture()
  try {
    fs.writeFileSync(
      path.join(fixture.parent, 'config', 'release.json'),
      `${JSON.stringify({ verifiedProtocols: [11], fallbackProtocol: 11 }, null, 2)}\n`,
    )
    git(fixture.parent, 'add', 'config/release.json')
    git(fixture.parent, 'commit', '-m', 'drop protocol verification')
    git(fixture.parent, 'push', 'origin', 'master')

    const result = runPlan(fixture)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /protocol v10 is not verified/)
  } finally {
    fixture.cleanup()
  }
})

test('rejects branch tracking in the submodule configuration', () => {
  const fixture = makeFixture()
  try {
    fs.appendFileSync(
      path.join(fixture.parent, '.gitmodules'),
      '\tbranch = moving-integration-tip\n',
    )
    git(fixture.parent, 'add', '.gitmodules')
    git(fixture.parent, 'commit', '-m', 'track a moving submodule branch')
    git(fixture.parent, 'push', 'origin', 'master')

    const result = runPlan(fixture)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /must not configure branch tracking/)
  } finally {
    fixture.cleanup()
  }
})

test('rejects a fallback protocol that is not in the verified set', () => {
  const fixture = makeFixture()
  try {
    fs.writeFileSync(
      path.join(fixture.parent, 'config', 'release.json'),
      `${JSON.stringify({ verifiedProtocols: [10], fallbackProtocol: 11 }, null, 2)}\n`,
    )
    git(fixture.parent, 'add', 'config/release.json')
    git(fixture.parent, 'commit', '-m', 'configure an unverified fallback')
    git(fixture.parent, 'push', 'origin', 'master')

    const result = runPlan(fixture)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /fallback protocol v11 must be verified/)
  } finally {
    fixture.cleanup()
  }
})

test('rejects a submodule commit that is not reachable from its configured remote', () => {
  const fixture = makeFixture()
  try {
    const checkout = path.join(fixture.parent, 'deps', 'OpenMMO')
    fs.writeFileSync(path.join(checkout, 'local-only.txt'), 'not pushed\n')
    git(checkout, 'add', 'local-only.txt')
    git(checkout, 'commit', '-m', 'local-only compatibility commit')
    git(fixture.parent, 'add', 'deps/OpenMMO')
    git(fixture.parent, 'commit', '-m', 'pin local-only OpenMMO')
    git(fixture.parent, 'push', 'origin', 'master')

    const result = runPlan(fixture)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /not reachable from any configured remote ref/)
  } finally {
    fixture.cleanup()
  }
})

test('refreshes an existing draft but refuses to overwrite a published release', () => {
  const fixture = makeFixture()
  try {
    const draft = runPlan(fixture, 'v1.2.3', 'draft', fixture.parentSha)
    assert.equal(draft.status, 0, draft.stderr)
    assert.equal(JSON.parse(draft.stdout).releaseAction, 'refresh')

    const published = runPlan(fixture, 'v1.2.3', 'published')
    assert.equal(published.status, 1)
    assert.match(published.stderr, /refusing to overwrite an already published release/)
  } finally {
    fixture.cleanup()
  }
})

test('refuses to refresh a draft created from a different parent commit', () => {
  const fixture = makeFixture()
  try {
    const result = runPlan(fixture, 'v1.2.3', 'draft', 'a'.repeat(40))

    assert.equal(result.status, 1)
    assert.match(result.stderr, /existing draft belongs to parent commit/)
  } finally {
    fixture.cleanup()
  }
})
