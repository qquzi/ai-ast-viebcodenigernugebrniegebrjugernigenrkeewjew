'use strict';

let uidCounter = 0;

class Binding {
  constructor(originalName, kind) {
    this.uid = ++uidCounter;
    this.originalName = originalName;
    this.newName = null;
    this.kind = kind; // 'local' | 'param' | 'forvar' | 'localfunction'
  }
  currentName() { return this.newName || this.originalName; }
}

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.vars = new Map();
  }
  declare(name, kind) {
    const b = new Binding(name, kind);
    this.vars.set(name, b);
    return b;
  }
  lookup(name) {
    let s = this;
    while (s) {
      if (s.vars.has(name)) return s.vars.get(name);
      s = s.parent;
    }
    return null;
  }
}

// Resolves every Identifier occurrence in the chunk against lexical scope,
// attaching `.ref = Binding` (or leaving it undefined for globals). This is
// the single pass every renaming decision downstream is based on.
function resolveScopes(chunk) {
  const rootScope = new Scope(null);
  const allBindings = [];

  function declareIn(scope, name, kind) {
    const b = scope.declare(name, kind);
    allBindings.push(b);
    return b;
  }

  function resolveIdentifierRef(node, scope) {
    // node: {type:'Identifier', name, ...}
    const binding = scope.lookup(node.name);
    if (binding) node.ref = binding;
  }

  function visitExpr(node, scope) {
    if (!node) return;
    switch (node.type) {
      case 'Identifier':
        resolveIdentifierRef(node, scope);
        return;
      case 'NilLiteral': case 'BooleanLiteral': case 'NumericLiteral':
      case 'StringLiteral': case 'InterpStringLiteral': case 'VarargLiteral':
        return;
      case 'ParenthesizedExpression':
        visitExpr(node.expression, scope);
        return;
      case 'BinaryExpression':
        visitExpr(node.left, scope); visitExpr(node.right, scope);
        return;
      case 'UnaryExpression':
        visitExpr(node.argument, scope);
        return;
      case 'MemberExpression':
        visitExpr(node.base, scope);
        if (node.indexer === '[') visitExpr(node.property, scope);
        return;
      case 'CallExpression':
        visitExpr(node.base, scope);
        for (const a of node.arguments) visitExpr(a, scope);
        return;
      case 'TableConstructor':
        for (const f of node.fields) {
          if (f.type === 'KeyedField') { visitExpr(f.key, scope); visitExpr(f.value, scope); }
          else visitExpr(f.value, scope);
        }
        return;
      case 'FunctionExpression':
        visitFunctionBody(node, scope);
        return;
      case 'IfExpression':
        for (const c of node.clauses) { visitExpr(c.condition, scope); visitExpr(c.body, scope); }
        visitExpr(node.elseBody, scope);
        return;
      default:
        return;
    }
  }

  function visitFunctionBody(fn, outerScope) {
    const fnScope = new Scope(outerScope);
    for (const p of fn.params) {
      if (p.name === 'self' && p.implicit) { p.binding = declareIn(fnScope, 'self', 'param'); continue; }
      p.binding = declareIn(fnScope, p.name, 'param');
    }
    visitBlock(fn.body, fnScope);
  }

  function visitBlock(body, scope) {
    for (const stmt of body) visitStmt(stmt, scope);
  }

  function visitStmt(stmt, scope) {
    switch (stmt.type) {
      case 'LocalStatement': {
        for (const init of stmt.init) visitExpr(init, scope);
        for (const n of stmt.names) n.binding = declareIn(scope, n.name, 'local');
        return;
      }
      case 'AssignmentStatement': {
        for (const init of stmt.init) visitExpr(init, scope);
        for (const v of stmt.variables) visitExpr(v, scope);
        return;
      }
      case 'CallStatement':
        visitExpr(stmt.expression, scope);
        return;
      case 'DoStatement':
        visitBlock(stmt.body, new Scope(scope));
        return;
      case 'WhileStatement':
        visitExpr(stmt.condition, scope);
        visitBlock(stmt.body, new Scope(scope));
        return;
      case 'RepeatStatement': {
        const bodyScope = new Scope(scope);
        visitBlock(stmt.body, bodyScope);
        visitExpr(stmt.condition, bodyScope); // until sees body locals
        return;
      }
      case 'IfStatement':
        for (const c of stmt.clauses) { visitExpr(c.condition, scope); visitBlock(c.body, new Scope(scope)); }
        if (stmt.elseBody) visitBlock(stmt.elseBody, new Scope(scope));
        return;
      case 'NumericForStatement': {
        visitExpr(stmt.start, scope); visitExpr(stmt.limit, scope); if (stmt.step) visitExpr(stmt.step, scope);
        const loopScope = new Scope(scope);
        stmt.variable.binding = declareIn(loopScope, stmt.variable.name, 'forvar');
        visitBlock(stmt.body, loopScope);
        return;
      }
      case 'GenericForStatement': {
        for (const it of stmt.iterators) visitExpr(it, scope);
        const loopScope = new Scope(scope);
        for (const n of stmt.names) n.binding = declareIn(loopScope, n.name, 'forvar');
        visitBlock(stmt.body, loopScope);
        return;
      }
      case 'FunctionDeclaration': {
        if (stmt.isLocal) {
          stmt.id.ref = declareIn(scope, stmt.id.name, 'localfunction');
        } else {
          visitExpr(stmt.id, scope);
        }
        visitFunctionBody(stmt, scope);
        return;
      }
      case 'ReturnStatement':
        for (const a of stmt.arguments) visitExpr(a, scope);
        return;
      case 'BreakStatement': case 'ContinueStatement': case 'GotoStatement':
      case 'LabelStatement': case 'RawStatement':
        return;
      default:
        return;
    }
  }

  visitBlock(chunk.body, rootScope);
  return { rootScope, allBindings };
}

module.exports = { resolveScopes, Scope, Binding };
