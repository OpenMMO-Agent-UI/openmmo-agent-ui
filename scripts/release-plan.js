#!/usr/bin/env node

const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const SEMVER =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

function fail(message) {
  throw new Error(message)
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function gitSucceeds(cwd, ...args) {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0
}

function resolvedUrl(cwd, url) {
  return git(cwd, 'ls-remote', '--get-url', url)
}

function displayUrl(url) {
  return url.replace(/https:\/\/[^/@]+@github\.com\//, 'https://github.com/')
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (command !== 'plan' && command !== 'validate-pin') {
    fail('usage: release-plan.js <plan|validate-pin> [--repo PATH] [--tag TAG] [--release-state STATE]')
  }

  const options = { command, repo: process.cwd() }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!key?.startsWith('--') || value === undefined) fail(`missing value for ${key || 'argument'}`)
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  return options
}

function validReleaseTag(tag) {
  const match = tag?.match(SEMVER)
  if (!match) return false
  const prerelease = match[4]
  return !prerelease?.split('.').some((part) => /^\d+$/.test(part) && /^0\d+/.test(part))
}

function submoduleSha(repo) {
  const entry = git(repo, 'ls-tree', 'HEAD', 'deps/OpenMMO')
  const match = entry.match(/^160000 commit ([0-9a-f]{40})\tdeps\/OpenMMO$/)
  if (!match) fail('deps/OpenMMO is not an exact submodule gitlink in HEAD')
  return match[1]
}

function protocolVersion(checkout) {
  const source = fs.readFileSync(path.join(checkout, 'shared', 'src', 'lib.rs'), 'utf8')
  const match = source.match(/PROTOCOL_VERSION: u32 = (\d+)/)
  if (!match) fail('OpenMMO shared/src/lib.rs has no readable PROTOCOL_VERSION')
  return Number(match[1])
}

function loadReleaseConfig(repo) {
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'config', 'release.json'), 'utf8'))
  if (
    !Array.isArray(config.verifiedProtocols) ||
    config.verifiedProtocols.length === 0 ||
    config.verifiedProtocols.some((version) => !Number.isInteger(version))
  ) {
    fail('config/release.json must contain at least one integer verified protocol')
  }
  if (!config.verifiedProtocols.includes(config.fallbackProtocol)) {
    fail(`fallback protocol v${config.fallbackProtocol} must be verified`)
  }
  return config
}

function validatePin(repo) {
  const checkout = path.join(repo, 'deps', 'OpenMMO')
  const pinnedSha = submoduleSha(repo)
  const checkedOutSha = git(checkout, 'rev-parse', 'HEAD')
  if (checkedOutSha !== pinnedSha) {
    fail(`deps/OpenMMO checkout ${checkedOutSha} does not match pinned gitlink ${pinnedSha}`)
  }

  const configuredUrl = git(repo, 'config', '-f', '.gitmodules', '--get', 'submodule.deps/OpenMMO.url')
  if (
    gitSucceeds(
      repo,
      'config',
      '-f',
      '.gitmodules',
      '--get',
      'submodule.deps/OpenMMO.branch',
    )
  ) {
    fail('deps/OpenMMO must not configure branch tracking; the gitlink SHA is authoritative')
  }
  const checkoutUrl = git(checkout, 'remote', 'get-url', 'origin')
  const expectedUrl = resolvedUrl(repo, configuredUrl)
  if (checkoutUrl !== expectedUrl) {
    fail(
      `deps/OpenMMO origin ${displayUrl(checkoutUrl)} does not match configured remote ${displayUrl(expectedUrl)}`,
    )
  }

  git(
    checkout,
    'fetch',
    '--tags',
    '--prune',
    'origin',
    '+refs/heads/*:refs/remotes/origin/*',
  )
  const refs = git(
    checkout,
    'for-each-ref',
    '--format=%(refname)',
    'refs/remotes/origin',
    'refs/tags',
  )
    .split('\n')
    .filter(Boolean)
  if (!refs.some((ref) => gitSucceeds(checkout, 'merge-base', '--is-ancestor', pinnedSha, ref))) {
    fail(`pinned OpenMMO commit ${pinnedSha} is not reachable from any configured remote ref`)
  }

  const releaseConfig = loadReleaseConfig(repo)
  const protocol = protocolVersion(checkout)
  if (!releaseConfig.verifiedProtocols.includes(protocol)) {
    fail(`OpenMMO protocol v${protocol} is not verified by this desktop client`)
  }

  return { openmmoSha: pinnedSha, protocolVersion: protocol }
}

function releaseAction(state, parentSha, existingParentSha) {
  if (state === 'absent') return 'create'
  if (state === 'draft') {
    if (existingParentSha !== parentSha) {
      fail(
        `existing draft belongs to parent commit ${existingParentSha || '(unknown)'}, not ${parentSha}`,
      )
    }
    return 'refresh'
  }
  if (state === 'published') fail('refusing to overwrite an already published release')
  fail(`unknown release state: ${state}`)
}

function plan(options) {
  if (!validReleaseTag(options.tag)) {
    fail(`release tag must be valid SemVer prefixed with v: ${options.tag || '(missing)'}`)
  }

  const parentSha = git(options.repo, 'rev-parse', 'HEAD')
  if (!gitSucceeds(options.repo, 'merge-base', '--is-ancestor', parentSha, 'origin/master')) {
    fail(`tagged commit ${parentSha} is not reachable from origin/master`)
  }

  const version = options.tag.slice(1)
  const pin = validatePin(options.repo)
  const artifactPrefix = `openmmo-agent-v${version}-p${pin.protocolVersion}`
  return {
    version,
    tag: options.tag,
    parentSha,
    openmmoSha: pin.openmmoSha,
    protocolVersion: pin.protocolVersion,
    artifactPrefix,
    artifacts: {
      linux: `${artifactPrefix}-linux-x64.AppImage`,
      macos: `${artifactPrefix}-macos-arm64.zip`,
      macosDmg: `${artifactPrefix}-macos-arm64.dmg`,
      windows: `${artifactPrefix}-windows-x64.exe`,
    },
    releaseAction: releaseAction(options.releaseState, parentSha, options.existingParentSha),
  }
}

try {
  const options = parseArgs(process.argv.slice(2))
  const result = options.command === 'plan' ? plan(options) : validatePin(options.repo)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
