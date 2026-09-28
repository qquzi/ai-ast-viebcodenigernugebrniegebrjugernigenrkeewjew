'use strict';

const { KEYWORDS } = require('../lexer');

// Base-52 letter-only identifier generator (a, b, ... z, A, ... Z, aa, ab, ...).
// Single letters can never collide with a keyword (all Lua/Luau keywords are
// 2+ letters), but multi-letter output absolutely can - "do", "if", "in",
// "or", "end", "for", "nil", "not", "and" are all reachable exact sequences
// once enough names have been generated to reach two letters, which happens
// well within the range of a real file once it has 50+ locals. Every
// generator here is wrapped to skip any output that exactly matches a
// keyword, rather than trusting the alphabet/shape to avoid it by chance.
function skippingKeywords(rawGen) {
  return function next() {
    let name;
    do { name = rawGen(); } while (KEYWORDS.has(name));
    return name;
  };
}

function makeNameGenerator() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let n = 0;
  return skippingKeywords(function next() {
    let i = n++;
    let name = '';
    do {
      name = chars[i % chars.length] + name;
      i = Math.floor(i / chars.length) - 1;
    } while (i >= 0);
    return name;
  });
}

// options.style: 'short' (a, b, c...) or 'confusing' (lookalike I/l/1 O/0 style)
function renameIdentifiers(allBindings, options = {}) {
  const style = options.style || 'short';
  const gen = style === 'confusing' ? makeConfusingGenerator() : makeNameGenerator();
  for (const binding of allBindings) {
    if (options.keep && options.keep.has(binding.originalName)) continue;
    binding.newName = gen();
  }
}

// Generates names built only from 'I', 'l', '1', 'O', '0' look-alike characters -
// syntactically fine (Lua identifiers just need [A-Za-z_][A-Za-z0-9_]*, and this
// pool is a subset of that), but painful for a human reader to tell apart. Can
// never spell a real keyword (keywords are plain lowercase a-z; this alphabet's
// only actual lowercase letter is 'l', and no keyword is all-l), but wrapped
// the same way for uniformity and in case that alphabet ever changes.
function makeConfusingGenerator() {
  const first = ['I', 'l', 'O']; // must not start with a digit
  const rest = ['I', 'l', '1', 'O', '0'];
  let n = 0;
  return skippingKeywords(function next() {
    let i = n++;
    // length grows over time; first char from `first`, remaining from `rest`
    const firstChar = first[i % first.length];
    i = Math.floor(i / first.length);
    let tail = '';
    do {
      tail += rest[i % rest.length];
      i = Math.floor(i / rest.length) - 1;
    } while (i >= 0);
    return firstChar + tail;
  });
}

module.exports = { renameIdentifiers };
