'use strict'

/// Ask the live server which wire protocol it speaks, and say what to do about it.
///
///   node openmmo-agent-ui/scripts/check-protocol.js [wss://host/ws]
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
const { layoutVersion, fnv1a64, FNV_OFFSET } = require('./layout-version.js')

// `../..` from this script only finds the OpenMMO checkout when
// this repo is cloned *inside* it (the README's documented layout) —
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

/// The same, without the utf8 round-trip: layout inputs are hashed byte for
/// byte, and decoding them to a string would mangle anything non-ASCII and
/// eat the trailing newline that is part of the file.
function gitBytes(...args) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] })
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

/// The fingerprint a commit would compile, read straight out of git rather
/// than through a checkout. Mirrors shared/build.rs the same way
/// layout-version.js does, over blobs instead of files; null for a commit
/// that predates the generator.
function layoutVersionAt(sha) {
  let names
  try {
    names = git('ls-tree', '--name-only', `${sha}:shared/src/dungeon`).split('\n').filter(Boolean)
  } catch {
    return null
  }
  const inputs = ['../data-src/dungeons.csv']
  for (const name of names) {
    if (name.endsWith('.rs') && name !== 'tests.rs') inputs.push(`src/dungeon/${name}`)
  }
  inputs.sort()
  let hash = FNV_OFFSET
  for (const rel of inputs) {
    // Paths are as the shared/ crate sees them; git wants them from the root.
    const blob = rel.startsWith('../') ? rel.slice(3) : `shared/${rel}`
    const bytes = gitBytes('show', `${sha}:${blob}`)
    hash = fnv1a64(hash, Buffer.from(rel, 'utf8'))
    hash = fnv1a64(hash, bytes.filter((b) => b !== 0x0d))
  }
  return hash.toString(16).padStart(16, '0')
}

/// Which gate an `AuthError` came from.
///
/// Every branch here is a refusal. The bug this replaced only recognised the
/// protocol message and returned "no version demanded" for anything else,
/// which main() then printed as **accepted** — so a fleet locked out by the
/// layout gate was reported as healthy, by the one tool whose whole job is
/// to ask.
function classifyRefusal(text) {
  const wanted = text.match(/Protocol v(\d+) required/)
  if (wanted) return { protocol: Number(wanted[1]) }
  if (/dungeon layouts? differ/i.test(text)) return { layout: true }
  return { refused: text }
}

/// The server gates on two things and reports them separately, so this
/// answers with which one it was:
///   { ok: true }       let in
///   { protocol: n }    wrong protocol number; the server speaks vn
///   { layout: true }   right number, different dungeon generator
///   { refused: text }  refused for some other reason
///
/// The version string carries the layout stamp the way
/// onlinerpg_shared::stamp_layout_version does. Sending it bare — which this
/// did until the server started gating on it — means every probe trips the
/// layout gate, and the answer to "which protocol do you speak" comes back
/// as a refusal that has nothing to do with the protocol.
function probe(url, version, layout) {
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

    const stamped = layout ? `check-protocol+layout.${layout}` : 'check-protocol'
    ws.on('open', () => ws.send(encode({ ClientInfo: [version, 'cli', stamped] })))
    ws.on('message', (data) => {
      const [name, body] = variantOf(decode(Buffer.from(data)))
      if (name !== 'AuthError') return
      finish(resolve, classifyRefusal(String(body?.[0] ?? '')))
    })
    // Silence past the handshake means it was accepted.
    ws.on('close', () => finish(resolve, { ok: true }))
    ws.on('error', (err) => finish(reject, err))
    setTimeout(() => finish(resolve, { ok: true }), 8000)
  })
}

/// Which commit to move to when the server refuses our dungeon generator.
///
/// Unlike the protocol number, a fingerprint is not ordered — a generator
/// change moves it anywhere — so this cannot bisect. It walks the commits
/// that actually touched the generator, newest first, and asks the server
/// about each one's fingerprint. Between two such commits the fingerprint
/// never moves, so the newest commit carrying an accepted one is the commit
/// just below the next boundary up.
async function newestCommitWithAcceptedLayout(url, ref, limit = 25) {
  const boundaries = git(
    'log',
    '--format=%H',
    ref,
    '--',
    'shared/src/dungeon',
    'data-src/dungeons.csv',
  )
    .split('\n')
    .filter(Boolean)
    .slice(0, limit)

  // Nothing has changed the generator above the newest boundary, so the tip
  // still carries its fingerprint.
  let newestCarryingIt = git('rev-parse', ref)
  for (const boundary of boundaries) {
    const fingerprint = layoutVersionAt(boundary)
    if (!fingerprint) break
    const verdict = await probe(url, versionAt(boundary), fingerprint)
    if (verdict.ok) return { sha: git('rev-parse', newestCarryingIt), fingerprint }
    newestCarryingIt = `${boundary}~1`
  }
  return null
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL
  const mine = localVersion()
  const layout = layoutVersion(ROOT)
  process.stdout.write(
    `checkout speaks v${mine}${layout ? `, layout ${layout}` : ' (unstamped)'}; asking ${url} ... `,
  )

  let verdict
  try {
    verdict = await probe(url, mine, layout)
  } catch (err) {
    console.log('unreachable')
    console.error(`\n${url} did not answer: ${err.message}`)
    process.exit(2)
  }

  if (verdict.ok) {
    console.log('accepted')
    return
  }

  if (verdict.refused) {
    console.log('refused')
    console.error(`\n${url} said: ${verdict.refused}`)
    process.exit(1)
  }

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

  if (verdict.protocol) {
    console.log(`refused, it wants v${verdict.protocol}`)
    const target = newestCommitSpeaking(verdict.protocol, commits)
    if (!target) {
      console.error(
        `\nNothing on ${searched} speaks v${verdict.protocol}. If the server is ahead, ` +
          `fetch and try again; the commit may not have been pushed yet.`,
      )
      process.exit(1)
    }
    reportTarget(target, searched)
  }

  // Right protocol, wrong dungeon generator. This is the refusal a redeploy
  // off upstream master produces without touching the protocol number at
  // all — no release is cut, nothing else notices, and every shipped client
  // is locked out until the pin follows.
  console.log('refused: it runs a different dungeon generator')
  const found = await newestCommitWithAcceptedLayout(url, searched)
  if (!found) {
    console.error(
      `\nNothing in the last generator changes on ${searched} carries a layout ` +
        `${url} accepts. Fetch and try again; the server may be ahead of what has been pushed.`,
    )
    process.exit(1)
  }
  console.error(`\nIt accepts layout ${found.fingerprint}.`)
  reportTarget(found.sha, searched)
}

/// Say which commit to land on, and how. Shared by both refusals — the fix
/// is the same shape either way: move the checkout, rebuild, repackage.
function reportTarget(target, searched) {
  const subject = git('log', '--format=%h %s', '-1', target)
  console.error(
    [
      '',
      `The commit to move to is:`,
      `  ${subject}`,
      '',
      'The spectator work is a branch, so rebase it onto that rather than moving',
      'the checkout out from under it:',
      `  git rebase --onto ${git('rev-parse', '--short', target)} <old-base> <your-spectator-branch>`,
      '',
      'Then rebuild and package in one step:',
      `  OPENMMO_CHECKOUT=${ROOT} npm run dist:mac`,
      '',
      `(searched ${searched})`,
    ].join('\n'),
  )
  process.exit(1)
}

module.exports = { classifyRefusal, layoutVersionAt }

// Only when run, not when required: the tests import classifyRefusal, and a
// bare main() at import time would have every one of them dial the server.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(2)
  })
}
