'use strict'

/// MessagePack, in the dialect `rmp_serde` speaks.
///
/// The game's wire format has three habits worth naming, because the encoder
/// has to reproduce them exactly for the Rust side to read it back:
///   - enums are a one-entry map `{Variant: [..fields]}`, and a unit variant
///     is a bare string;
///   - structs are *positional arrays*, not maps — field order is the schema;
///   - floats are f32 (`0xca`), never f64.

const FLOAT32 = 0xca

function encode(value) {
  const out = []
  write(out, value)
  return Buffer.from(out)
}

function write(out, v) {
  if (v === null || v === undefined) return out.push(0xc0)
  if (typeof v === 'boolean') return out.push(v ? 0xc3 : 0xc2)
  if (typeof v === 'string') return writeString(out, v)
  if (typeof v === 'number') return writeNumber(out, v)
  if (Array.isArray(v)) return writeArray(out, v)
  if (v instanceof Float) return writeFloat32(out, v.value)
  if (typeof v === 'object') return writeMap(out, v)
  throw new Error(`cannot encode ${typeof v}`)
}

/// Marks a number that must go out as f32 even when it is integral — a
/// rotation of exactly 0 is still a float on the wire.
class Float {
  constructor(value) {
    this.value = value
  }
}

function writeFloat32(out, n) {
  const buf = Buffer.alloc(4)
  buf.writeFloatBE(n)
  out.push(FLOAT32, ...buf)
}

function writeNumber(out, n) {
  if (!Number.isInteger(n)) return writeFloat32(out, n)
  if (n >= 0) {
    if (n < 0x80) return out.push(n)
    if (n < 0x100) return out.push(0xcc, n)
    if (n < 0x10000) return out.push(0xcd, n >> 8, n & 0xff)
    if (n < 0x100000000) return out.push(0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64BE(BigInt(n))
    return out.push(0xcf, ...buf)
  }
  if (n >= -32) return out.push(0x100 + n)
  if (n >= -0x80) return out.push(0xd0, 0x100 + n)
  if (n >= -0x8000) {
    const buf = Buffer.alloc(2)
    buf.writeInt16BE(n)
    return out.push(0xd1, ...buf)
  }
  const buf = Buffer.alloc(4)
  buf.writeInt32BE(n)
  return out.push(0xd2, ...buf)
}

function writeString(out, s) {
  const bytes = Buffer.from(s, 'utf8')
  if (bytes.length < 32) out.push(0xa0 | bytes.length)
  else if (bytes.length < 0x100) out.push(0xd9, bytes.length)
  else out.push(0xda, bytes.length >> 8, bytes.length & 0xff)
  out.push(...bytes)
}

function writeArray(out, arr) {
  if (arr.length < 16) out.push(0x90 | arr.length)
  else out.push(0xdc, arr.length >> 8, arr.length & 0xff)
  for (const item of arr) write(out, item)
}

function writeMap(out, obj) {
  const keys = Object.keys(obj)
  if (keys.length < 16) out.push(0x80 | keys.length)
  else out.push(0xde, keys.length >> 8, keys.length & 0xff)
  for (const key of keys) {
    write(out, key)
    write(out, obj[key])
  }
}

function decode(buf) {
  let i = 0
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)

  function read() {
    const b = buf[i++]
    if (b <= 0x7f) return b
    if (b >= 0xe0) return b - 256
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f)
    if (b >= 0x90 && b <= 0x9f) return arr(b & 0x0f)
    if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f)
    switch (b) {
      case 0xc0: return null
      case 0xc2: return false
      case 0xc3: return true
      case 0xc4: { const n = buf[i++]; const v = buf.subarray(i, i + n); i += n; return v }
      case 0xc5: { const n = dv.getUint16(i); i += 2; const v = buf.subarray(i, i + n); i += n; return v }
      case 0xc6: { const n = dv.getUint32(i); i += 4; const v = buf.subarray(i, i + n); i += n; return v }
      case 0xca: { const v = dv.getFloat32(i); i += 4; return v }
      case 0xcb: { const v = dv.getFloat64(i); i += 8; return v }
      case 0xcc: return buf[i++]
      case 0xcd: { const v = dv.getUint16(i); i += 2; return v }
      case 0xce: { const v = dv.getUint32(i); i += 4; return v }
      case 0xcf: { const v = Number(dv.getBigUint64(i)); i += 8; return v }
      case 0xd0: { const v = dv.getInt8(i); i += 1; return v }
      case 0xd1: { const v = dv.getInt16(i); i += 2; return v }
      case 0xd2: { const v = dv.getInt32(i); i += 4; return v }
      case 0xd3: { const v = Number(dv.getBigInt64(i)); i += 8; return v }
      case 0xd9: { const n = buf[i++]; return str(n) }
      case 0xda: { const n = dv.getUint16(i); i += 2; return str(n) }
      case 0xdb: { const n = dv.getUint32(i); i += 4; return str(n) }
      case 0xdc: { const n = dv.getUint16(i); i += 2; return arr(n) }
      case 0xdd: { const n = dv.getUint32(i); i += 4; return arr(n) }
      case 0xde: { const n = dv.getUint16(i); i += 2; return map(n) }
      default: throw new Error(`unhandled msgpack byte 0x${b.toString(16)}`)
    }
  }
  function str(n) { const s = buf.toString('utf8', i, i + n); i += n; return s }
  function arr(n) { const out = []; for (let k = 0; k < n; k++) out.push(read()); return out }
  function map(n) { const o = {}; for (let k = 0; k < n; k++) { const key = read(); o[key] = read() } return o }

  return read()
}

/// `["PlayerMoved", [..fields]]` for a tagged variant, `["Heartbeat", null]`
/// for a unit one. Returns `[null, null]` for anything unrecognisable, so a
/// protocol addition can never crash the relay.
function variantOf(decoded) {
  if (typeof decoded === 'string') return [decoded, null]
  if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
    const name = Object.keys(decoded)[0]
    if (name) return [name, decoded[name]]
  }
  return [null, null]
}

module.exports = { encode, decode, variantOf, Float }
