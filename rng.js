'use strict';

// mulberry32 - small, fast, well-known deterministic PRNG. Good enough for
// obfuscation randomization (this is not a cryptographic use case); the only
// property that actually matters here is that a given seed always reproduces
// the same sequence, so a build is reproducible when the user wants that.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let current = mulberry32((Math.random() * 0xFFFFFFFF) >>> 0);

function seed(n) {
  current = mulberry32(n >>> 0);
}

// Drop-in replacement for Math.random() - every transform should call this
// instead, so a single `seed()` call makes an entire run reproducible.
function random() {
  return current();
}

function int(min, max) {
  // inclusive of min, exclusive of max
  return Math.floor(random() * (max - min)) + min;
}

function pick(array) {
  return array[int(0, array.length)];
}

module.exports = { seed, random, int, pick };
