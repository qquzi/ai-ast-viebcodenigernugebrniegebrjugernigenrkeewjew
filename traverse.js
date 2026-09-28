'use strict';

// Walks every expression node in the chunk (post-order: children first),
// replacing each with `fn(node)` whenever fn returns a truthy replacement.
function mapExpressions(chunk, fn) {
  function E(node) {
    if (!node) return node;
    switch (node.type) {
      case 'Identifier': case 'NilLiteral': case 'BooleanLiteral':
      case 'NumericLiteral': case 'StringLiteral': case 'InterpStringLiteral':
      case 'VarargLiteral':
        break;
      case 'ParenthesizedExpression':
        node.expression = E(node.expression);
        break;
      case 'BinaryExpression':
        node.left = E(node.left); node.right = E(node.right);
        break;
      case 'UnaryExpression':
        node.argument = E(node.argument);
        break;
      case 'MemberExpression':
        node.base = E(node.base);
        if (node.indexer === '[') node.property = E(node.property);
        break;
      case 'CallExpression':
        node.base = E(node.base);
        node.arguments = node.arguments.map(E);
        break;
      case 'TableConstructor':
        for (const f of node.fields) {
          if (f.type === 'KeyedField') f.key = E(f.key);
          f.value = E(f.value);
        }
        break;
      case 'FunctionExpression':
        node.body = B(node.body);
        break;
      case 'IfExpression':
        for (const c of node.clauses) { c.condition = E(c.condition); c.body = E(c.body); }
        node.elseBody = E(node.elseBody);
        break;
      default:
        break;
    }
    const replacement = fn(node);
    return replacement || node;
  }

  function S(stmt) {
    switch (stmt.type) {
      case 'LocalStatement': stmt.init = stmt.init.map(E); break;
      case 'AssignmentStatement': stmt.variables = stmt.variables.map(E); stmt.init = stmt.init.map(E); break;
      case 'CallStatement': stmt.expression = E(stmt.expression); break;
      case 'DoStatement': stmt.body = B(stmt.body); break;
      case 'WhileStatement': stmt.condition = E(stmt.condition); stmt.body = B(stmt.body); break;
      case 'RepeatStatement': stmt.body = B(stmt.body); stmt.condition = E(stmt.condition); break;
      case 'IfStatement':
        for (const c of stmt.clauses) { c.condition = E(c.condition); c.body = B(c.body); }
        if (stmt.elseBody) stmt.elseBody = B(stmt.elseBody);
        break;
      case 'NumericForStatement':
        stmt.start = E(stmt.start); stmt.limit = E(stmt.limit);
        if (stmt.step) stmt.step = E(stmt.step);
        stmt.body = B(stmt.body);
        break;
      case 'GenericForStatement':
        stmt.iterators = stmt.iterators.map(E);
        stmt.body = B(stmt.body);
        break;
      case 'FunctionDeclaration':
        if (!stmt.isLocal) stmt.id = E(stmt.id);
        stmt.body = B(stmt.body);
        break;
      case 'ReturnStatement': stmt.arguments = stmt.arguments.map(E); break;
      default: break;
    }
    return stmt;
  }

  function B(body) { return body.map(S); }

  chunk.body = B(chunk.body);
  return chunk;
}

// Visits every block (statement array) in the program, innermost first,
// calling fn(blockArray, containerInfo) which may mutate/replace the block's
// statements in place via array mutation (splice) - fn should NOT reassign
// the array reference, since callers hold a reference into the parent node.
function forEachBlock(chunk, fn) {
  function visitBlockArray(body) {
    for (const stmt of body) visitStmtChildren(stmt);
    fn(body);
  }

  function visitStmtChildren(stmt) {
    switch (stmt.type) {
      case 'DoStatement': visitBlockArray(stmt.body); break;
      case 'WhileStatement': visitBlockArray(stmt.body); break;
      case 'RepeatStatement': visitBlockArray(stmt.body); break;
      case 'IfStatement':
        for (const c of stmt.clauses) visitBlockArray(c.body);
        if (stmt.elseBody) visitBlockArray(stmt.elseBody);
        break;
      case 'NumericForStatement': visitBlockArray(stmt.body); break;
      case 'GenericForStatement': visitBlockArray(stmt.body); break;
      case 'FunctionDeclaration': visitBlockArray(stmt.body); break;
      default: break;
    }
    // Function expressions nested inside this statement's expressions can
    // themselves contain blocks (e.g. `local f = function() ... end`).
    for (const expr of expressionFieldsOf(stmt)) findFunctionBlocks(expr);
  }

  function expressionFieldsOf(stmt) {
    switch (stmt.type) {
      case 'LocalStatement': return stmt.init;
      case 'AssignmentStatement': return [...stmt.variables, ...stmt.init];
      case 'CallStatement': return [stmt.expression];
      case 'WhileStatement': return [stmt.condition];
      case 'RepeatStatement': return [stmt.condition];
      case 'IfStatement': return stmt.clauses.map(c => c.condition);
      case 'NumericForStatement': return [stmt.start, stmt.limit, stmt.step].filter(Boolean);
      case 'GenericForStatement': return stmt.iterators;
      case 'FunctionDeclaration': return stmt.isLocal ? [] : [stmt.id];
      case 'ReturnStatement': return stmt.arguments;
      default: return [];
    }
  }

  function findFunctionBlocks(node) {
    if (!node) return;
    switch (node.type) {
      case 'FunctionExpression': visitBlockArray(node.body); return;
      case 'ParenthesizedExpression': findFunctionBlocks(node.expression); return;
      case 'BinaryExpression': findFunctionBlocks(node.left); findFunctionBlocks(node.right); return;
      case 'UnaryExpression': findFunctionBlocks(node.argument); return;
      case 'MemberExpression':
        findFunctionBlocks(node.base);
        if (node.indexer === '[') findFunctionBlocks(node.property);
        return;
      case 'CallExpression':
        findFunctionBlocks(node.base);
        node.arguments.forEach(findFunctionBlocks);
        return;
      case 'TableConstructor':
        for (const f of node.fields) { if (f.key && f.key.type) findFunctionBlocks(f.key); findFunctionBlocks(f.value); }
        return;
      case 'IfExpression':
        for (const c of node.clauses) { findFunctionBlocks(c.condition); findFunctionBlocks(c.body); }
        findFunctionBlocks(node.elseBody);
        return;
      default: return;
    }
  }

  visitBlockArray(chunk.body);
}

module.exports = { mapExpressions, forEachBlock };
