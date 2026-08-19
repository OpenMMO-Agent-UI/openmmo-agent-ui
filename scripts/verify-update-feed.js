'use strict'

/// Guards the one thing a release cannot verify about itself: whether the
/// *previous* version will be able to update to it. A wrong filename, a
/// missing latest*.yml or an unreachable asset leaves every installed client
/// silently stuck on a build the server will refuse to talk to, and nothing
/// in this repository would notice. Runs after the wiki mirror is published,
/// against the same URL the app resolves.
///
///   node scripts/verify-update-feed.js <artifacts-dir> <version> <base-url>

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/// electron-updater's channel file is small and fixed in shape, so the three
/// fields that matter come out by pattern rather than by adding a YAML
/// dependency for one consumer.
function parseFeed(text) {
  const field = (name) => {
    const match = text.match(new RegExp(`^${name}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm'))
    return match ? match[1].trim() : null
  }
  return { version: field('version'), file: field('path'), sha512: field('sha512') }
}

function sha512(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
}

async function main() {
  const [dir, version, baseUrl] = process.argv.slice(2)
  if (!dir || !version || !baseUrl) {
    console.error('usage: verify-update-feed.js <artifacts-dir> <version> <base-url>')
    process.exit(2)
  }

  const channels = fs.readdirSync(dir).filter((name) => /^latest.*\.yml$/.test(name)).sort()
  const failures = []
  // Three platforms ship, so three channel files must exist — a build that
  // quietly stopped emitting one is exactly the failure this catches.
  if (channels.length !== 3) failures.push(`expected 3 channel files, found ${channels.length}: ${channels.join(', ') || 'none'}`)

  for (const channel of channels) {
    const local = fs.readFileSync(path.join(dir, channel), 'utf8')
    const feed = parseFeed(local)
    const fail = (message) => failures.push(`${channel}: ${message}`)

    if (feed.version !== version) fail(`version is ${feed.version}, expected ${version}`)
    if (!feed.file) {
      fail('no path field')
      continue
    }

    const artifact = path.join(dir, feed.file)
    if (!fs.existsSync(artifact)) fail(`${feed.file} is not among the release artifacts`)
    else if (sha512(artifact) !== feed.sha512) fail(`sha512 does not match ${feed.file}`)

    const published = await fetch(`${baseUrl}/${channel}`)
    if (!published.ok) fail(`${baseUrl}/${channel} returned ${published.status}`)
    else if ((await published.text()).trim() !== local.trim()) fail('published channel file differs from the one just built')

    const asset = await fetch(`${baseUrl}/${feed.file}`, { method: 'HEAD' })
    if (!asset.ok) fail(`${feed.file} is not downloadable (${asset.status})`)

    console.log(`${channel} → ${feed.file}`)
  }

  if (failures.length) {
    console.error(`update feed is broken:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`update feed verified for v${version}`)
}

if (require.main === module) void main()

module.exports = { parseFeed }
