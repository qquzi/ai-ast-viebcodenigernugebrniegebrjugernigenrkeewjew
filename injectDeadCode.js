'use strict';

const { forEachBlock } = require('../traverse');
const rng = require('../rng');

let counter = 0;
function freshName() { return `__jnk${++counter}`; }

function ident(name) { return { type: 'Identifier', name }; }
function num(n) { return { type: 'NumericLiteral', raw: String(n) }; }

// Builds a block that is PROVABLY never executed, no matter what: for any
// integer x, (x*x) % 4 is always 0 or 1 - never 2 or 3. The guard here
// checks for one of those impossible remainders, so the branch inside can
// never run, full stop, regardless of x's actual value. Because it can never
// run, its contents can look like arbitrary "real" logic without any risk:
// there is no way for it to collide with, shadow, or corrupt anything in the
// surrounding program, because it never executes. It only ever references
// its own freshly-declared locals - nothing from the real code around it -
// so this holds even before that invariant is considered.
function buildJunkStatement() {
  const seedName = freshName();
  const seedValue = rng.int(2, 97);
  const impossibleRemainder = rng.pick([2, 3]);
  const a = freshName();
  const b = freshName();

  const guard = {
    type: 'BinaryExpression', operator: '==',
    left: {
      type: 'BinaryExpression', operator: '%',
      left: { type: 'BinaryExpression', operator: '*', left: ident(seedName), right: ident(seedName) },
      right: num(4)
    },
    right: num(impossibleRemainder)
  };

  const junkBody = [
    { type: 'LocalStatement', names: [{ name: a }], init: [{ type: 'BinaryExpression', operator: '+', left: ident(seedName), right: num(rng.int(1, 50)) }] },
    { type: 'LocalStatement', names: [{ name: b }], init: [{ type: 'BinaryExpression', operator: '*', left: ident(a), right: num(rng.int(2, 9)) }] },
    { type: 'AssignmentStatement', operator: '=', variables: [ident(a)], init: [{ type: 'BinaryExpression', operator: '-', left: ident(b), right: ident(seedName) }] }
  ];

  return {
    type: 'DoStatement',
    body: [
      { type: 'LocalStatement', names: [{ name: seedName }], init: [num(seedValue)] },
      { type: 'IfStatement', clauses: [{ condition: guard, body: junkBody }], elseBody: null }
    ]
  };
}

// Scatters the above at random points inside every block in the program.
// Off by default (see index.js) since it's pure size overhead with no
// functional benefit beyond visual/structural noise for someone reading the
// output - a legitimate obfuscation technique, but a tradeoff the caller
// should opt into rather than pay for automatically.
function injectDeadCode(chunk, options = {}) {
  const probability = options.probability != null ? options.probability : 0.2;
  forEachBlock(chunk, (body) => {
    // A block ending in `return` can never have anything inserted after that
    // return - not even a self-contained do-block - because Lua's grammar
    // requires return to be the last statement in a block, full stop. Every
    // other gap (including right before the return) is fair game.
    const lastInsertable = (body.length > 0 && body[body.length - 1].type === 'ReturnStatement')
      ? body.length - 1
      : body.length;
    for (let i = lastInsertable; i >= 0; i--) {
      if (rng.random() < probability) body.splice(i, 0, buildJunkStatement());
    }
  });
  return chunk;
}

module.exports = { injectDeadCode };
