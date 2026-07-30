'use strict'

/// Ask the live server which wire protocol it speaks, and say what to do about it.
///
///   node openmmo-client/scripts/check-protocol.js [wss://host/ws]
///
/// The server compares versions exactly and refuses anything else, and the
/// deployed build is not always upstream's tip — it has been both ahead of and
/// behind this checkout. That refusal arrives as one line buried in the agent's
/// log, which is a poor place to learn you need to move the checkout, so this
/// asks up front and names the commit to land on.
///
/// Only the handshake is sent: no character enters the world.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocket } = require('ws')

const { encode, decode, variantOf } = require('./../src/msgpack')

// `../..` from this script only finds the OpenMMO checkout when
// openmmo-client is cloned *inside* it (the README's documented layout) —
// checked out as siblings instead, it silently lands one directory too
// shallow. See link.sh, which had the identical bug.
function findRoot() {
  if (process.env.OPENMMO_CHECKOUT) return process.env.OPENMMO_CHECKOUT
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('Run this from inside the OpenMMO checkout, or set OPENMMO_CHECKOUT')
  }
}

const ROOT = findRoot()
const DEFAULT_URL = 'wss://openmmo.to.nexus/ws'

/// Which ref to search for the commit speaking the server's version. A fork
/// checkout normally has no `upstream` remote at all — its `origin` *is* the
/// fork, and upstream's history reached it through that — so insisting on
/// `upstream/master` turned "here is the commit to move to" into "add the
/// upstream remote and fetch it" on the layout most likely to be in use.
/// Falls back rather than choosing, since a real `upstream` is the better
/// answer when one exists.
const SEARCH_REFS = ['upstream/master', 'origin/master', 'master']

/// stderr is piped rather than inherited so a probe that is *expected* to fail
/// stays quiet — `rev-parse --verify upstream/master` on a checkout without
/// that remote otherwise prints "fatal: Needed a single revision" straight
/// past this script's own output, right before it reports success.
function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function localVersion() {
  const lib = fs.readFileSync(path.join(ROOT, 'shared/src/lib.rs'), 'utf8')
  const match = lib.match(/PROTOCOL_VERSION: u32 = (\d+)/)
  if (!match) throw new Error('no PROTOCOL_VERSION in shared/src/lib.rs')
  return Number(match[1])
}

/// 0 for history old enough that the constant — or the file — did not exist
/// yet. History reaches back past both, and treating that as an error would
/// abandon the search on its first step into the deep end.
function versionAt(sha) {
  try {
    const lib = git('show', `${sha}:shared/src/lib.rs`)
    const match = lib.match(/PROTOCOL_VERSION: u32 = (\d+)/)
    return match ? Number(match[1]) : 0
  } catch {
    return 0
  }
}

/// Newest commit on upstream that still speaks `wanted`. The version only ever
/// goes up along the branch, so this is a boundary search rather than a walk —
/// `git show` per commit would be a subprocess each.
function newestCommitSpeaking(wanted, commits) {
  let lo = 0
  let hi = commits.length - 1
  let found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const version = versionAt(commits[mid])
    if (version <= wanted) {
      if (version === wanted) found = commits[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/// Resolves to the version the server demands, or null when it accepts ours.
function probe(url, version) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        // Already closing.
      }
      fn(value)
    }

    ws.on('open', () => ws.send(encode({ ClientInfo: [version, 'cli', 'check-protocol'] })))
    ws.on('message', (data) => {
      const [name, body] = variantOf(decode(Buffer.from(data)))
      if (name !== 'AuthError') return
      const required = String(body?.[0] ?? '').match(/Protocol v(\d+) required/)
      finish(resolve, required ? Number(required[1]) : null)
    })
    // Silence past the handshake means it was accepted.
    ws.on('close', () => finish(resolve, null))
    ws.on('error', (err) => finish(reject, err))
    setTimeout(() => finish(resolve, null), 8000)
  })
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL
  const mine = localVersion()
  process.stdout.write(`checkout speaks v${mine}; asking ${url} ... `)

  let required
  try {
    required = await probe(url, mine)
  } catch (err) {
    console.log('unreachable')
    console.error(`\n${url} did not answer: ${err.message}`)
    process.exit(2)
  }

  if (required === null) {
    console.log(`accepted`)
    return
  }

  console.log(`refused, it wants v${required}`)

  let commits
  let searched
  for (const ref of SEARCH_REFS) {
    try {
      git('rev-parse', '--verify', ref)
      commits = git('rev-list', '--reverse', ref).split('\n')
      searched = ref
      break
    } catch {
      // Try the next one.
    }
  }
  if (!commits) {
    console.error(`\nNone of ${SEARCH_REFS.join(', ')} exist here. Fetch one and try again.`)
    process.exit(1)
  }

  const target = newestCommitSpeaking(required, commits)
  if (!target) {
    console.error(
      `\nNothing on ${searched} speaks v${required}. If the server is ahead, ` +
        `fetch and try again; the commit may not have been pushed yet.`,
    )
    process.exit(1)
  }

  const subject = git('log', '--format=%h %s', '-1', target)
  console.error(
    [
      '',
      `The newest commit that speaks v${required} is:`,
      `  ${subject}`,
      '',
      'The spectator work is a branch, so rebase it onto that rather than moving',
      'the checkout out from under it:',
      `  git rebase --onto ${git('rev-parse', '--short', target)} <old-base> <your-spectator-branch>`,
      '',
      'Then rebuild and package in one step:',
      `  OPENMMO_CHECKOUT=${ROOT} npm run dist:mac`,
    ].join('\n'),
  )
  process.exit(1)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(2)
})
