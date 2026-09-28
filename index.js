'use strict';

const { parse } = require('./parser');
const { resolveScopes } = require('./scope');
const { generate } = require('./codegen');
const { mapExpressions } = require('./traverse');
const rng = require('./rng');
const { renameIdentifiers } = require('./transforms/renameIdentifiers');
const { obfuscateStrings } = require('./transforms/obfuscateStrings');
const { obfuscateNumbers } = require('./transforms/obfuscateNumbers');
const { flattenControlFlow } = require('./transforms/flattenControlFlow');
const { injectDeadCode } = require('./transforms/injectDeadCode');

const INTERP_IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

// String interpolation (`` `text {expr}` ``) is carried through as an opaque
// raw literal (see obfuscateStrings' module comment) rather than deeply
// parsed, so identifiers referenced inside `{...}` segments can't be updated
// by the renamer the normal way. To avoid silently breaking those references,
// every identifier-looking token found inside any interpolation segment is
// excluded from renaming outright.
function collectInterpolationNames(chunk) {
  const names = new Set();
  mapExpressions(chunk, (node) => {
    if (node.type === 'InterpStringLiteral') {
      for (const m of node.raw.matchAll(INTERP_IDENT_RE)) names.add(m[0]);
    }
    return null;
  });
  return names;
}

const DEFAULT_OPTIONS = {
  renameVariables: true,
  renameStyle: 'short',       // 'short' | 'confusing'
  obfuscateStrings: true,
  obfuscateNumbers: true,
  xorStrings: false,          // opt-in: extra layer on the string table, see obfuscateStrings.js
  injectDeadCode: false,      // opt-in: pure size/noise overhead, see injectDeadCode.js
  deadCodeProbability: 0.2,
  flattenControlFlow: false,  // opt-in: changes code shape the most, test your script after enabling
  flattenProbability: 0.6,
  numberObfuscationDepth: 1,
  pretty: false,
  seed: null,                 // set to any integer for a reproducible build
};

function obfuscate(source, userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  if (options.seed != null) rng.seed(options.seed);

  const ast = parse(source);

  if (options.obfuscateStrings) {
    obfuscateStrings(ast, {
      minLength: options.stringMinLength || 0,
      maxLength: options.stringMaxLength,
      xor: options.xorStrings,
    });
  }
  if (options.injectDeadCode) injectDeadCode(ast, { probability: options.deadCodeProbability });
  if (options.obfuscateNumbers) obfuscateNumbers(ast, { depth: options.numberObfuscationDepth });
  if (options.flattenControlFlow) flattenControlFlow(ast, { probability: options.flattenProbability });

  const { allBindings } = resolveScopes(ast);
  if (options.renameVariables) {
    const keep = collectInterpolationNames(ast);
    renameIdentifiers(allBindings, { style: options.renameStyle, keep });
  }

  return generate(ast, { pretty: options.pretty });
}

module.exports = { obfuscate, parse, generate, resolveScopes };
