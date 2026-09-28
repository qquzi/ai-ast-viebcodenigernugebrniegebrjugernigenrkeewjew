'use strict';

const { forEachBlock } = require('../traverse');
const rng = require('../rng');

let counter = 0;
function freshStateVarName() { return `__fst${++counter}`; }

function shuffle(array) {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Conservative safety check: refuses to flatten a block that contains, at any
// depth reachable without crossing a nested loop or function boundary, a
// break/continue - and refuses goto/label at ANY depth (short of a nested
// function), since goto can legally jump across loop boundaries and we don't
// want to reason about its full scoping rules here. Blocks that fail this
// check are left exactly as they were - flattening only ever applies where
// it is provably safe.
function hasUnsafeControlFlow(stmtList) {
  function scan(list, insideNestedLoop) {
    for (const stmt of list) {
      switch (stmt.type) {
        case 'BreakStatement': case 'ContinueStatement':
          if (!insideNestedLoop) return true;
          break;
        case 'GotoStatement': case 'LabelStatement':
          return true;
        case 'IfStatement':
          for (const c of stmt.clauses) if (scan(c.body, insideNestedLoop)) return true;
          if (stmt.elseBody && scan(stmt.elseBody, insideNestedLoop)) return true;
          break;
        case 'DoStatement':
          if (scan(stmt.body, insideNestedLoop)) return true;
          break;
        case 'WhileStatement': case 'RepeatStatement':
        case 'NumericForStatement': case 'GenericForStatement':
          if (scan(stmt.body, true)) return true;
          break;
        case 'FunctionDeclaration':
          break; // function boundary: break/goto can't escape it
        default:
          break;
      }
    }
    return false;
  }
  return scan(stmtList, false);
}

function ident(name) { return { type: 'Identifier', name }; }
function num(n) { return { type: 'NumericLiteral', raw: String(n) }; }

// Top-level `local`/`local function` declarations can't simply be moved as-is
// into a per-statement if/elseif branch: each branch is its own nested Lua
// block, so a `local` declared in one branch would go out of scope before the
// next branch (next loop iteration) runs. The fix mirrors what Lua itself
// does for `local function`: hoist the bare declaration (implicitly nil)
// above the loop, then turn the original declaration into a plain assignment
// into that hoisted slot - the loop's iterations all share the same outer
// local, exactly matching the un-flattened block's sequential scoping.
function collectTopLevelLocalNames(stmtList) {
  const names = [];
  for (const stmt of stmtList) {
    if (stmt.type === 'LocalStatement') for (const n of stmt.names) names.push(n.name);
    else if (stmt.type === 'FunctionDeclaration' && stmt.isLocal) names.push(stmt.id.name);
  }
  return names;
}

function hasDuplicateNames(names) {
  return new Set(names).size !== names.length;
}

function hasUnhoistableAttrib(stmtList) {
  return stmtList.some(stmt => stmt.type === 'LocalStatement' && stmt.names.some(n => n.attrib === 'close'));
}

function hoistLocal(stmt) {
  if (stmt.type === 'LocalStatement') {
    if (stmt.init.length === 0) return null; // hoisted decl already covers the nil initial value
    return {
      type: 'AssignmentStatement', operator: '=',
      variables: stmt.names.map(n => ident(n.name)),
      init: stmt.init
    };
  }
  if (stmt.type === 'FunctionDeclaration' && stmt.isLocal) {
    return {
      type: 'AssignmentStatement', operator: '=',
      variables: [ident(stmt.id.name)],
      init: [{ type: 'FunctionExpression', params: stmt.params, vararg: stmt.vararg, body: stmt.body, generics: stmt.generics || null }]
    };
  }
  return stmt;
}

// The state numbers don't have to count 1, 2, 3... in original order, and the
// elseif branches don't have to be *written* in execution order either -
// each branch is self-contained (`if __st == <label> then ... end`), so
// checking order never affects which one matches. Randomizing both the label
// assigned to each original statement and the order the branches are written
// in defeats the trivial "the states are just the original code, numbered"
// reading of a flattened block, without changing behavior: the only thing
// that determines execution order is which label each branch transitions to,
// and that still faithfully encodes the original sequence.
function buildFlattened(originalStmts, stateVar) {
  const hoistedNames = collectTopLevelLocalNames(originalStmts);
  const rewritten = originalStmts.map(hoistLocal); // null entries mean "no-op, state transition only"
  const n = rewritten.length;
  const TERMINATE = 0;
  const labels = shuffle(Array.from({ length: n }, (_, i) => i + 1));

  const clauses = rewritten.map((stmt, i) => {
    const isReturn = stmt && stmt.type === 'ReturnStatement';
    const nextLabel = i + 1 < n ? labels[i + 1] : TERMINATE;
    const advance = { type: 'AssignmentStatement', operator: '=', variables: [ident(stateVar)], init: [num(nextLabel)] };
    const body = isReturn ? [stmt] : (stmt ? [stmt, advance] : [advance]);
    return { condition: { type: 'BinaryExpression', operator: '==', left: ident(stateVar), right: num(labels[i]) }, body };
  });

  const localDecl = { type: 'LocalStatement', names: [{ name: stateVar }], init: [num(labels[0])] };
  const whileStmt = {
    type: 'WhileStatement',
    condition: { type: 'BinaryExpression', operator: '~=', left: ident(stateVar), right: num(TERMINATE) },
    body: [{ type: 'IfStatement', clauses: shuffle(clauses), elseBody: null }]
  };
  const result = [localDecl, whileStmt];
  if (hoistedNames.length > 0) {
    result.unshift({ type: 'LocalStatement', names: hoistedNames.map(name => ({ name })), init: [] });
  }
  return result;
}

function flattenControlFlow(chunk, options = {}) {
  const probability = options.probability != null ? options.probability : 0.6;
  const minStatements = options.minStatements != null ? options.minStatements : 2;

  forEachBlock(chunk, (body) => {
    if (body.length < minStatements) return;
    if (hasUnsafeControlFlow(body)) return;
    if (hasUnhoistableAttrib(body)) return;
    if (hasDuplicateNames(collectTopLevelLocalNames(body))) return;
    if (rng.random() > probability) return;
    const original = body.slice();
    const replacement = buildFlattened(original, freshStateVarName());
    body.length = 0;
    body.push(...replacement);
  });

  return chunk;
}

module.exports = { flattenControlFlow };
