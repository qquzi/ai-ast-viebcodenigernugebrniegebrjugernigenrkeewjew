'use strict';

const { mapExpressions } = require('../traverse');
const rng = require('../rng');

// Parses a Lua numeral's raw text into a JS integer, or null if it's a float,
// scientific-notation, or otherwise a value we can't safely re-derive without
// changing its runtime precision (see note in obfuscateNumbers below).
function parseIntegerRaw(raw) {
  const clean = raw.replace(/_/g, '');
  if (/^0[bB]/.test(clean)) {
    const v = parseInt(clean.slice(2), 2);
    return Number.isFinite(v) ? v : null;
  }
  if (/^0[xX]/.test(clean)) {
    if (/[.pP]/.test(clean)) return null; // hex float
    const v = parseInt(clean, 16);
    return Number.isFinite(v) ? v : null;
  }
  if (/[.eE]/.test(clean)) return null; // float / scientific notation
  const v = Number(clean);
  if (!Number.isFinite(v) || !Number.isInteger(v)) return null;
  return v;
}

function literal(v) { return { type: 'NumericLiteral', raw: String(v) }; }

// Note: no division-based variant here on purpose. Lua/Luau's `/` is always
// float division, and while Luau itself has no separate integer subtype to
// expose that, this codebase can't fully verify that no observable
// difference exists on every runtime this output might run on - and the
// existing multiplicative/additive identities already provide the same
// obfuscation value without that risk. Same "don't risk changing behavior
// for marginal gain" reasoning as the floats-are-left-alone rule below.
function buildExprForValue(value, depth) {
  const roll = rng.random();
  if (value !== 0 && roll < 0.4) {
    for (let d = 2; d <= 12; d++) {
      if (value % d === 0) {
        const other = value / d;
        return { type: 'BinaryExpression', operator: '*', left: maybeRecurse(other, depth), right: maybeRecurse(d, depth) };
      }
    }
  }
  if (roll >= 0.4 && roll < 0.55) {
    // -(-value): a double negation, cheap structural noise.
    return { type: 'UnaryExpression', operator: '-', argument: { type: 'UnaryExpression', operator: '-', argument: maybeRecurse(value, depth) } };
  }
  const k = rng.int(1, 501);
  return { type: 'BinaryExpression', operator: '-', left: maybeRecurse(value + k, depth), right: maybeRecurse(k, depth) };
}

function maybeRecurse(v, depth) {
  if (depth > 0 && Number.isInteger(v) && rng.random() < 0.35) return buildExprForValue(v, depth - 1);
  return literal(v);
}

// Note: only integer-valued literals (decimal or hex) are transformed. Floats
// and scientific notation are left untouched, because re-deriving them via
// arithmetic on a shifted intermediate value can introduce floating-point
// rounding different from the literal's exact original bit pattern.
function obfuscateNumbers(chunk, options = {}) {
  const depth = options.depth != null ? options.depth : 1;
  mapExpressions(chunk, (node) => {
    if (node.type !== 'NumericLiteral') return null;
    const value = parseIntegerRaw(node.raw);
    if (value === null) return null;
    return buildExprForValue(value, depth);
  });
  return chunk;
}

module.exports = { obfuscateNumbers, parseIntegerRaw };
