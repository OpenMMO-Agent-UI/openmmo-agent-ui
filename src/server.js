'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const { repoRoot } = require('./config')

/// Serves the built web client to the spectator view. It has to be a real
/// origin rather than a file:// page: the client resolves the terrain API from
/// `window.location.origin`, so those requests land here and are proxied on to
/// the game server — the same tiles the public site serves.

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.ktx2': 'image/ktx2',
  '.bin': 'application/octet-stream',
}

function clientDist() {
  // Guarded: outside a packaged app `resourcesPath` is empty, and joining ''
  // yields the relative "client" — which resolves to the *source* directory,
  // whose index.html is the Vite template, not a bundle.
  if (path.isAbsolute(process.resourcesPath || '')) {
    const packaged = path.join(process.resourcesPath, 'client')
    if (isBuiltBundle(packaged)) return packaged
  }
  return path.join(repoRoot(), 'client', 'dist')
}

/// A built bundle, not a source tree: `client/index.html` exists either way,
/// so the emitted `assets/` directory is what tells them apart. Serving the
/// template instead would render a blank page pointing at /src/main.ts.
function isBuiltBundle(dir) {
  return (
    fs.existsSync(path.join(dir, 'index.html')) &&
    fs.existsSync(path.join(dir, 'assets'))
  )
}

function distReady() {
  return isBuiltBundle(clientDist())
}

/// `https://host` for an origin, or null when the value is a local terrain
/// directory (an agent running on the game server machine has no HTTP source
/// to borrow, so the spectator cannot fetch tiles either).
function apiOrigin(terrain) {
  return /^https?:\/\//.test(terrain || '') ? terrain.replace(/\/$/, '') : null
}

async function proxy(req, res, origin) {
  const target = `${origin}${req.url}`
  try {
    const upstream = await fetch(target, {
      headers: { accept: req.headers.accept || '*/*' },
      signal: AbortSignal.timeout(20000),
    })
    const body = Buffer.from(await upstream.arrayBuffer())
    const type = upstream.headers.get('content-type')
    res.writeHead(upstream.status, type ? { 'content-type': type } : {})
    res.end(body)
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`Upstream ${target} failed: ${err.message}`)
  }
}

/// Models, textures and music live in Git LFS. A clone without `git lfs pull`
/// leaves ~130-byte pointer files in their place, which the bundler copies
/// into dist verbatim — the scene then fails to load every asset. Rather than
/// demand an LFS checkout, borrow the real file from the server we are already
/// watching: same build, same paths under public/.
const LFS_MAGIC = 'version https://git-lfs.github.com/spec/v1'
let warnedAboutLfs = false

function isLfsPointer(file, size) {
  if (size > 512) return false
  try {
    return fs.readFileSync(file, 'utf8').startsWith(LFS_MAGIC)
  } catch {
    return false
  }
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  })
}

class ClientServer {
  constructor() {
    this.server = null
    this.port = 0
    this.origin = null
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}` : null
  }

  /// Idempotent: a restart of the agent should not cycle the view's origin,
  /// which would reload the whole 3D scene for nothing.
  async start(terrain) {
    this.origin = apiOrigin(terrain)
    if (this.server) return this.url
    if (!distReady()) {
      throw new Error(
        `The web client has not been built yet. Run "npm install && npm run build" in ${path.join(repoRoot(), 'client')}.`,
      )
    }

    const root = clientDist()
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname.startsWith('/api/')) {
        if (!this.origin) {
          res.writeHead(503, { 'content-type': 'text/plain' })
          res.end('No HTTP terrain source configured; set a terrain origin in Connection.')
          return
        }
        proxy(req, res, this.origin)
        return
      }

      // Path traversal check before any read: the URL is attacker-controlled
      // only in the sense that anything on this machine can call us, but a
      // ../ walk out of dist/ would still be a file server for the home dir.
      const decoded = decodeURIComponent(url.pathname)
      const file = path.join(root, decoded)
      if (!file.startsWith(root)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('Forbidden')
        return
      }

      fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) {
          serveFile(res, path.join(root, 'index.html'))
          return
        }
        if (this.origin && isLfsPointer(file, stat.size)) {
          if (!warnedAboutLfs) {
            warnedAboutLfs = true
            console.warn(
              `Assets are Git LFS pointers (run "git lfs pull" for a local copy); ` +
                `fetching them from ${this.origin} instead.`,
            )
          }
          proxy(req, res, this.origin)
          return
        }
        serveFile(res, file)
      })
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.port = this.server.address().port
    return this.url
  }

  stop() {
    if (this.server) this.server.close()
    this.server = null
    this.port = 0
  }
}

module.exports = { ClientServer, distReady, clientDist }
