'use strict';

const { mapExpressions } = require('../traverse');
const { parse } = require('../parser');
const rng = require('../rng');

// Same padding rule as codegen's quoteString, and for the same reason: an
// unpadded `\0` immediately followed by a literal "1" would print as `\01`,
// which Lua reads back as `\001` - not NUL + "1".
function luaEscape(value) {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (code < 32 || code === 127) out += '\\' + String(code).padStart(3, '0');
    else out += ch;
  }
  return out + '"';
}

function xorByte(value, key) {
  const out = [];
  for (let i = 0; i < value.length; i++) out.push(String.fromCharCode(value.charCodeAt(i) ^ key));
  return out.join('');
}

// Replaces every StringLiteral with an index into an injected lookup table,
// storing each unique string as a properly-escaped string literal (byte-safe:
// see cli.js, which reads/writes source as 'latin1', and this file treats
// string values the same way throughout, so any byte 0-255 round-trips
// exactly, not just ASCII). Values are built as real Lua source text and
// parsed with our own parser, rather than hand-built as byte-array AST nodes -
// simpler, and avoids inflating a long string into one AST node (and later,
// one printed token) per byte.
//
// options.xor: when true, every stored value is XORed with a random per-run
// key byte before being stored, and the decode function XORs it back. This
// is a speed bump, not encryption - anyone reading the (small, fixed-shape)
// decode function sees exactly how to reverse it - but it does mean the
// string table itself is no longer plaintext to a casual grep/skim. The XOR
// is done byte-by-byte using plain arithmetic (add/subtract/divide/modulo)
// rather than a bitwise operator or the `bit32` library, since Luau doesn't
// have bitwise operators and `bit32` isn't guaranteed to exist on every Lua
// runtime this output might end up running on.
function obfuscateStrings(chunk, options = {}) {
  const suffix = options.suffix || Math.floor(rng.random() * 1e6).toString(36);
  const tableName = options.tableName || `__ObfS_${suffix}`;
  const decodeFnName = options.decodeFnName || `__ObfD_${suffix}`;
  const minLength = options.minLength || 0;
  const maxLength = options.maxLength != null ? options.maxLength : Infinity;
  const useXor = !!options.xor;
  const xorKey = options.xorKey != null ? options.xorKey : rng.int(1, 256);
  const xorFnName = options.xorFnName || `__ObfX_${suffix}`;
  const xorKeyName = options.xorKeyName || `__ObfK_${suffix}`;

  const entries = [];
  const cache = new Map();

  function getIndex(value) {
    if (cache.has(value)) return cache.get(value);
    entries.push(value);
    const idx = entries.length; // 1-based
    cache.set(value, idx);
    return idx;
  }

  mapExpressions(chunk, (node) => {
    if (node.type !== 'StringLiteral') return null;
    if (node.value.length < minLength || node.value.length > maxLength) return null;
    const idx = getIndex(node.value);
    return {
      type: 'CallExpression',
      base: { type: 'Identifier', name: decodeFnName },
      method: null,
      arguments: [{ type: 'NumericLiteral', raw: String(idx) }]
    };
  });

  if (entries.length === 0) return chunk;

  const stored = useXor ? entries.map(v => xorByte(v, xorKey)) : entries;
  const tableLiteral = `{${stored.map(luaEscape).join(',')}}`;

  const helperSrc = useXor ? `
local function ${xorFnName}(a, b)
  local r, p = 0, 1
  while a > 0 or b > 0 do
    local abit, bbit = a % 2, b % 2
    if abit ~= bbit then r = r + p end
    a = (a - abit) / 2
    b = (b - bbit) / 2
    p = p * 2
  end
  return r
end
local ${xorKeyName} = ${xorKey}
local ${tableName} = ${tableLiteral}
local function ${decodeFnName}(i)
  local raw = ${tableName}[i]
  local out = {}
  for j = 1, #raw do
    out[j] = string.char(${xorFnName}(string.byte(raw, j), ${xorKeyName}))
  end
  return table.concat(out)
end
` : `
local ${tableName} = ${tableLiteral}
local function ${decodeFnName}(i)
  return ${tableName}[i]
end
`;
  const helperBody = parse(helperSrc).body;

  chunk.body = [...helperBody, ...chunk.body];
  return chunk;
}

module.exports = { obfuscateStrings, luaEscape, xorByte };
