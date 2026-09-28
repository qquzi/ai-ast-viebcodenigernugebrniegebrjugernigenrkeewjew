'use strict';

const BIN_PRECEDENCE = {
  'or': 1, 'and': 2,
  '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3,
  '..': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '//': 6, '%': 6,
  '^': 10
};
const RIGHT_ASSOC = new Set(['..', '^']);
const UNARY_PREC = 8;
const ATOM_PREC = 100;

class Generator {
  constructor(opts = {}) {
    this.pretty = !!opts.pretty;
    this.indentStr = '  ';
  }

  ind(depth) { return this.pretty ? this.indentStr.repeat(depth) : ''; }
  nl() { return this.pretty ? '\n' : ''; }
  sep() { return this.pretty ? '\n' : ' '; }

  generate(chunk) {
    return this.block(chunk.body, 0);
  }

  block(stmts, depth) {
    const parts = stmts.map(s => this.ind(depth) + this.statement(s, depth));
    return parts.join(this.pretty ? '\n' : ';');
  }

  declName(entry) {
    return entry.binding ? entry.binding.currentName() : entry.name;
  }

  methodChainAsDot(node) {
    if (node.type === 'Identifier') return node.ref ? node.ref.currentName() : node.name;
    // node.type === 'MemberExpression'; property is always a plain string here.
    return `${this.methodChainAsDot(node.base)}.${node.property}`;
  }

  statement(stmt, depth) {
    switch (stmt.type) {
      case 'LocalStatement': {
        const names = stmt.names.map(n => this.declName(n) + (n.attrib ? `<${n.attrib}>` : '')).join(',');
        const init = stmt.init.length ? ' = ' + stmt.init.map(e => this.expr(e, 0)).join(',') : '';
        return `local ${names}${init}`;
      }
      case 'AssignmentStatement': {
        const vars = stmt.variables.map(v => this.expr(v, 0)).join(',');
        return `${vars} ${stmt.operator} ${stmt.init.map(e => this.expr(e, 0)).join(',')}`;
      }
      case 'CallStatement':
        return this.expr(stmt.expression, 0);
      case 'DoStatement':
        return `do${this.sep()}${this.block(stmt.body, depth + 1)}${this.sep()}${this.ind(depth)}end`;
      case 'WhileStatement':
        return `while ${this.expr(stmt.condition, 0)} do${this.sep()}${this.block(stmt.body, depth + 1)}${this.sep()}${this.ind(depth)}end`;
      case 'RepeatStatement':
        return `repeat${this.sep()}${this.block(stmt.body, depth + 1)}${this.sep()}${this.ind(depth)}until ${this.expr(stmt.condition, 0)}`;
      case 'IfStatement': {
        let out = '';
        stmt.clauses.forEach((c, i) => {
          const kw = i === 0 ? 'if' : `${this.pretty ? this.ind(depth) : ''}elseif`;
          out += `${kw} ${this.expr(c.condition, 0)} then${this.sep()}${this.block(c.body, depth + 1)}${this.sep()}`;
        });
        if (stmt.elseBody) out += `${this.pretty ? this.ind(depth) : ''}else${this.sep()}${this.block(stmt.elseBody, depth + 1)}${this.sep()}`;
        out += `${this.pretty ? this.ind(depth) : ''}end`;
        return out;
      }
      case 'NumericForStatement': {
        const v = this.declName(stmt.variable);
        const parts = [this.expr(stmt.start, 0), this.expr(stmt.limit, 0)];
        if (stmt.step) parts.push(this.expr(stmt.step, 0));
        return `for ${v} = ${parts.join(',')} do${this.sep()}${this.block(stmt.body, depth + 1)}${this.sep()}${this.ind(depth)}end`;
      }
      case 'GenericForStatement': {
        const names = stmt.names.map(n => this.declName(n)).join(',');
        const iters = stmt.iterators.map(e => this.expr(e, 0)).join(',');
        return `for ${names} in ${iters} do${this.sep()}${this.block(stmt.body, depth + 1)}${this.sep()}${this.ind(depth)}end`;
      }
      case 'FunctionDeclaration': {
        let nameStr, params;
        if (stmt.isMethod) {
          // Written with `:` at the call site regardless, but the declaration
          // is normalized to `.` with an explicit (renameable) first
          // parameter - `:` would hard-bind the literal name "self".
          nameStr = this.methodChainAsDot(stmt.id);
          params = stmt.params.map(p => this.declName(p));
        } else {
          nameStr = this.expr(stmt.id, ATOM_PREC);
          params = stmt.params.map(p => this.declName(p));
        }
        const prefix = stmt.isLocal ? 'local function' : 'function';
        if (stmt.vararg) params.push('...');
        return `${prefix} ${nameStr}(${params.join(',')})${this.sep()}${this.block(stmt.body, depth + 1)}${this.sep()}${this.ind(depth)}end`;
      }
      case 'ReturnStatement':
        return stmt.arguments.length ? `return ${stmt.arguments.map(e => this.expr(e, 0)).join(',')}` : 'return';
      case 'BreakStatement': return 'break';
      case 'ContinueStatement': return 'continue';
      case 'GotoStatement': return `goto ${stmt.label}`;
      case 'LabelStatement': return `::${stmt.name}::`;
      case 'RawStatement': return stmt.text;
      default:
        throw new Error(`Unknown statement type: ${stmt.type}`);
    }
  }

  precOf(node) {
    if (node.type === 'BinaryExpression') return BIN_PRECEDENCE[node.operator];
    if (node.type === 'UnaryExpression') return UNARY_PREC;
    return ATOM_PREC;
  }

  // minPrec: the minimum precedence node must have to avoid being wrapped
  expr(node, minPrec) {
    const inner = this.exprInner(node);
    const own = this.precOf(node);
    return own < minPrec ? `(${inner})` : inner;
  }

  exprInner(node) {
    switch (node.type) {
      case 'Identifier':
        return node.ref ? node.ref.currentName() : node.name;
      case 'NilLiteral': return 'nil';
      case 'BooleanLiteral': return node.value ? 'true' : 'false';
      case 'NumericLiteral': return node.raw;
      case 'StringLiteral':
        if (node.long) return `[${'='.repeat(node.level || 0)}[${node.value}]${'='.repeat(node.level || 0)}]`;
        return this.quoteString(node.value, node.quote || '"');
      case 'InterpStringLiteral': return node.raw;
      case 'VarargLiteral': return '...';
      case 'ParenthesizedExpression': return `(${this.expr(node.expression, 0)})`;
      case 'FunctionExpression': {
        const params = node.params.map(p => this.declName(p));
        if (node.vararg) params.push('...');
        return `function(${params.join(',')})${this.sep()}${this.block(node.body, 1)}${this.sep()}end`;
      }
      case 'BinaryExpression': {
        const p = BIN_PRECEDENCE[node.operator];
        const leftMin = RIGHT_ASSOC.has(node.operator) ? p + 1 : p;
        const rightMin = RIGHT_ASSOC.has(node.operator) ? p : p + 1;
        return `${this.expr(node.left, leftMin)} ${node.operator} ${this.expr(node.right, rightMin)}`;
      }
      case 'UnaryExpression': {
        const operand = this.expr(node.argument, UNARY_PREC);
        if (node.operator === 'not') return `not ${operand}`;
        if (node.operator === '-' && operand.startsWith('-')) return `- ${operand}`;
        return `${node.operator}${operand}`;
      }
      case 'MemberExpression': {
        const base = this.expr(node.base, ATOM_PREC);
        if (node.indexer === '[') return `${base}[${this.expr(node.property, 0)}]`;
        return `${base}${node.indexer}${node.property}`;
      }
      case 'CallExpression': {
        const base = this.expr(node.base, ATOM_PREC);
        const args = node.arguments.map(a => this.expr(a, 0)).join(',');
        if (node.method) return `${base}:${node.method}(${args})`;
        return `${base}(${args})`;
      }
      case 'TableConstructor': {
        const parts = node.fields.map(f => {
          if (f.type === 'KeyedField') return `[${this.expr(f.key, 0)}] = ${this.expr(f.value, 0)}`;
          if (f.type === 'NameField') return `${f.key} = ${this.expr(f.value, 0)}`;
          return this.expr(f.value, 0);
        });
        return `{${parts.join(',')}}`;
      }
      case 'IfExpression': {
        let out = '';
        node.clauses.forEach((c, i) => {
          out += `${i === 0 ? 'if' : 'elseif'} ${this.expr(c.condition, 0)} then ${this.expr(c.body, 0)} `;
        });
        out += `else ${this.expr(node.elseBody, 0)}`;
        return out;
      }
      default:
        throw new Error(`Unknown expression type: ${node.type}`);
    }
  }

  quoteString(value, quote) {
    let out = quote;
    for (const ch of value) {
      const code = ch.codePointAt(0);
      if (ch === quote || ch === '\\') out += '\\' + ch;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      // Zero-padded to 3 digits: Lua's \ddd escape greedily eats up to 3
      // digits, so an unpadded `\0` immediately followed by a literal "1"
      // would print as `\01`, which Lua reads back as `\001` - not NUL + "1".
      else if (code < 32 || code === 127) out += '\\' + String(code).padStart(3, '0');
      else out += ch;
    }
    return out + quote;
  }
}

function generate(chunk, opts) {
  return new Generator(opts).generate(chunk);
}

module.exports = { generate, Generator };
