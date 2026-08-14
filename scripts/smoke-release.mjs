#!/usr/bin/env node
// Proves a shipped build can actually talk to the live server.
//
//   node scripts/smoke-release.mjs [vX.Y.Z]
//
// Every other check in the release pipeline reads a number out of a file. That
// is not enough, and package-resources.sh documents why: staging once reused a
// binary compiled before the checkout moved to a new PROTOCOL_VERSION and
// paired it with a build-info.json stamped from the *current* source, so the
// filename and the metadata both said the right thing while the binary inside
// spoke the old protocol. Only its handshake gave it away.
//
// So this runs the packaged agent-client against a local listener, reads the
// protocol version out of the ClientInfo frame it actually sends, and compares
// that with the filename, with build-info.json, and with what the live server
// demands. The handshake precedes authentication, so no game credentials are
// needed.
//
// Exit 0 all agree, 1 on a real mismatch, 2 when the check could not run.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const REPO = 'OpenMMO-Agent-UI/openmmo-agent-ui';
const LIVE_SERVER = 'wss://openmmo.to.nexus/ws';

class CannotRun extends Error {}

// --- reading the version out of a ClientInfo frame ---------------------------

/// `{ ClientInfo: [version, ...] }` in the dialect rmp_serde emits. Rather than
/// decode msgpack, find the key's bytes and step over the array header — the
/// version is the next value, small enough to be a fixint or a uint8.
function protocolFromClientInfo(buf) {
  const key = Buffer.from('ClientInfo', 'utf8');
  const at = buf.indexOf(key);
  if (at < 0) return null;
  let i = at + key.length;
  if ((buf[i] & 0xf0) === 0x90) i += 1;          // fixarray
  else if (buf[i] === 0xdc) i += 3;              // array16
  else return null;
  const b = buf[i];
  if (b <= 0x7f) return b;                       // positive fixint
  if (b === 0xcc) return buf[i + 1];             // uint8
  if (b === 0xcd) return buf.readUInt16BE(i + 1);
  return null;
}

// --- what the live server demands --------------------------------------------

/// Handshake with a version the server cannot still accept, so its refusal
/// names the current one. Same trick the wiki's drift check uses.
function askServerProtocol() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(LIVE_SERVER);
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* already closing */ }
      fn(v);
    };
    const str = (s) => Buffer.concat([Buffer.from([0xa0 | s.length]), Buffer.from(s, 'utf8')]);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => ws.send(Buffer.concat([
      Buffer.from([0x81]), str('ClientInfo'), Buffer.from([0x93, 0x01]),
      str('cli'), str('release-smoke'),
    ])));
    ws.addEventListener('message', (e) => {
      const m = Buffer.from(e.data).toString('utf8').match(/Protocol v(\d+) required/);
      if (m) finish(resolve, Number(m[1]));
    });
    ws.addEventListener('error', () => finish(reject, new CannotRun('live server did not answer')));
    ws.addEventListener('close', () => finish(reject, new CannotRun('live server closed without naming a version')));
    setTimeout(() => finish(reject, new CannotRun('live server timed out')), 20000);
  });
}

// --- unpacking the shipped artifact -------------------------------------------

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

async function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  return null;
}

/// The Linux AppImage is the one runners can unpack without FUSE or a Mac.
async function unpackAppImage(tag, work) {
  let listed;
  try {
    listed = JSON.parse(sh('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'assets']));
  } catch (e) {
    throw new CannotRun(`cannot read release ${tag}: ${e.message}`);
  }
  const asset = listed.assets.find((a) => a.name.endsWith('-linux-x64.AppImage'));
  if (!asset) throw new CannotRun(`release ${tag} has no linux AppImage`);

  sh('gh', ['release', 'download', tag, '--repo', REPO, '--pattern', asset.name, '--dir', work, '--clobber']);
  const image = join(work, asset.name);
  chmodSync(image, 0o755);
  sh(image, ['--appimage-extract'], { cwd: work, stdio: 'ignore' });

  const root = join(work, 'squashfs-root');
  const binary = await findFile(root, 'agent-client');
  const info = await findFile(root, 'build-info.json');
  if (!binary) throw new CannotRun('no agent-client binary inside the AppImage');
  chmodSync(binary, 0o755);

  const fromName = asset.name.match(/-p(\d+)-/);
  return {
    assetName: asset.name,
    binary,
    filenameProtocol: fromName ? Number(fromName[1]) : null,
    buildInfoProtocol: info ? JSON.parse(readFileSync(info, 'utf8')).protocolVersion ?? null : null,
  };
}

// --- what the binary actually says --------------------------------------------

/// Point the shipped binary at a listener of ours and read the first frame it
/// sends. ClientInfo goes out immediately after connect, before any credential
/// is touched, so this needs no account.
function captureHandshake(binary, work) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    let child;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
      wss.close();
      fn(v);
    };

    wss.on('listening', () => {
      const { port } = wss.address();
      // The binary reads `data/config.toml` relative to its working directory
      // and takes no flag for it, so the run directory is the interface.
      const runDir = join(work, 'run');
      const terrain = join(runDir, 'terrain');
      sh('mkdir', ['-p', join(runDir, 'data'), terrain]);
      // llm = "none" keeps this credential-free and stops it reaching for a
      // model; the session dies right after the handshake, which is all we read.
      writeFileSync(join(runDir, 'data', 'config.toml'), [
        `server = "ws://127.0.0.1:${port}"`,
        `terrain = "${terrain}"`,
        // Any token satisfies the startup check; the server rejects it long
        // after ClientInfo has already gone out, which is all this reads.
        'npc_token = "smoke-test-placeholder-token"',
        '',
        // One NPC is the minimum the binary will start with. Nothing about it
        // matters: the connection is refused right after ClientInfo, which is
        // the only frame this reads.
        '[[npcs]]',
        'account = "npc_release_smoke"',
        'character_name = "SmokeTest"',
        'llm = "none"',
      ].join('\n'));

      child = spawn(binary, [], { cwd: runDir, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (e) => finish(reject, new CannotRun(`cannot run the binary: ${e.message}`)));
      child.on('exit', (code) => {
        setTimeout(() => finish(reject, new CannotRun(
          `binary exited (code ${code}) without sending ClientInfo\n${stderr.slice(-800)}`)), 500);
      });
    });

    wss.on('connection', (socket) => {
      socket.once('message', (frame) => {
        const version = protocolFromClientInfo(Buffer.from(frame));
        if (version === null) finish(reject, new CannotRun('first frame was not a readable ClientInfo'));
        else finish(resolve, version);
      });
    });

    wss.on('error', (e) => finish(reject, new CannotRun(`listener failed: ${e.message}`)));
    setTimeout(() => finish(reject, new CannotRun('binary never handshook within 60s')), 60000);
  });
}

// --- report --------------------------------------------------------------------

async function main() {
  const tag = process.argv[2] || sh('gh', ['release', 'view', '--repo', REPO, '--json', 'tagName', '--jq', '.tagName']).trim();
  const work = mkdtempSync(join(tmpdir(), 'smoke-'));

  const art = await unpackAppImage(tag, work);
  const spoken = await captureHandshake(art.binary, work);
  const required = await askServerProtocol();

  const rows = [
    ['filename', art.filenameProtocol],
    ['build-info.json', art.buildInfoProtocol],
    ['**what the binary sends**', spoken],
    ['live server requires', required],
  ];
  const report = [
    `Smoke test for **${tag}** (\`${art.assetName}\`)`,
    '',
    '| source | protocol |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v ?? '—'} |`),
  ];

  const problems = [];
  if (spoken !== required) {
    problems.push(
      `**This build cannot connect.** It speaks protocol v${spoken}; the live server ` +
      `requires v${required}. Anyone downloading it gets an endless "Connection lost".`
    );
  }
  if (art.buildInfoProtocol !== null && art.buildInfoProtocol !== spoken) {
    problems.push(
      `**The package lies about itself.** build-info.json says v${art.buildInfoProtocol} ` +
      `but the binary speaks v${spoken} — a stale binary was staged beside fresh metadata. ` +
      `Rebuild rather than restage.`
    );
  }
  if (art.filenameProtocol !== null && art.filenameProtocol !== spoken) {
    problems.push(
      `**The filename is wrong.** It claims v${art.filenameProtocol}, the binary speaks ` +
      `v${spoken}. The wiki's download page and links are generated from that name.`
    );
  }

  if (problems.length) {
    report.push('', '## What needs doing', '', ...problems.map((p) => `- ${p}`));
    console.log(report.join('\n'));
    process.exitCode = 1;
    return;
  }
  report.push('', 'All four agree — the shipped build can reach the live server.');
  console.log(report.join('\n'));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(err instanceof CannotRun ? 2 : 2);
});
