'use strict';

const { tokenize, LuaSyntaxError } = require('./lexer');

// Only "true" reserved words are lexed as Keyword tokens. `continue`, `type`
// and `export` are contextual in Luau (usable as ordinary identifiers), so
// they arrive as Name tokens and are detected here by value+lookahead.
const STATEMENT_START_KEYWORDS = new Set([
  'local', 'if', 'while', 'for', 'repeat', 'function', 'return', 'break',
  'goto', 'do'
]);
const BLOCK_END_KEYWORDS = new Set(['end', 'else', 'elseif', 'until']);

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
const COMPOUND_OPS = new Set(['+=', '-=', '*=', '/=', '%=', '^=', '..=', '//=']);

class Parser {
  constructor(src) {
    this.tokens = tokenize(src);
    this.idx = 0;
  }

  peek(offset = 0) { return this.tokens[this.idx + offset]; }
  cur() { return this.tokens[this.idx]; }
  advance() { return this.tokens[this.idx++]; }

  error(msg, tok) {
    tok = tok || this.cur();
    throw new LuaSyntaxError(msg, tok.line, tok.col);
  }

  describe(tok) { return tok.type === 'EOF' ? '<end of file>' : tok.value; }

  isSymbol(val, tok) { tok = tok || this.cur(); return tok.type === 'Symbol' && tok.value === val; }
  isKeyword(val, tok) { tok = tok || this.cur(); return tok.type === 'Keyword' && tok.value === val; }
  isName(val, tok) { tok = tok || this.cur(); return tok.type === 'Name' && tok.value === val; }

  expectSymbol(val) {
    if (!this.isSymbol(val)) this.error(`Expected '${val}' but got '${this.describe(this.cur())}'`);
    return this.advance();
  }
  expectKeyword(val) {
    if (!this.isKeyword(val)) this.error(`Expected '${val}' but got '${this.describe(this.cur())}'`);
    return this.advance();
  }
  expectName() {
    if (this.cur().type !== 'Name') this.error(`Expected identifier but got '${this.describe(this.cur())}'`);
    return this.advance().value;
  }

  atBlockEnd() {
    const t = this.cur();
    return t.type === 'EOF' || (t.type === 'Keyword' && BLOCK_END_KEYWORDS.has(t.value));
  }

  parseChunk() {
    const body = this.parseBlock();
    if (this.cur().type !== 'EOF') this.error(`Unexpected token '${this.describe(this.cur())}'`);
    return { type: 'Chunk', body };
  }

  parseBlock() {
    const body = [];
    while (!this.atBlockEnd()) {
      if (this.isSymbol(';')) { this.advance(); continue; }
      if (this.isKeyword('return')) { body.push(this.parseReturnStatement()); break; }
      body.push(this.parseStatement());
    }
    return body;
  }

  parseStatement() {
    const t = this.cur();

    if (this.isSymbol('::')) return this.parseLabelStatement();
    if (t.type === 'Keyword') {
      switch (t.value) {
        case 'break': this.advance(); return { type: 'BreakStatement' };
        case 'goto': this.advance(); return { type: 'GotoStatement', label: this.expectName() };
        case 'do': {
          this.advance();
          const body = this.parseBlock();
          this.expectKeyword('end');
          return { type: 'DoStatement', body };
        }
        case 'while': {
          this.advance();
          const condition = this.parseExpr(0);
          this.expectKeyword('do');
          const body = this.parseBlock();
          this.expectKeyword('end');
          return { type: 'WhileStatement', condition, body };
        }
        case 'repeat': {
          this.advance();
          const body = this.parseBlock();
          this.expectKeyword('until');
          const condition = this.parseExpr(0);
          return { type: 'RepeatStatement', body, condition };
        }
        case 'if': return this.parseIfStatement();
        case 'for': return this.parseForStatement();
        case 'function': return this.parseFunctionStatement();
        case 'local': return this.parseLocalOrLocalFunction();
      }
    }

    // Contextual keywords: continue / type / export
    if (t.type === 'Name' && t.value === 'continue' && this.looksLikeContinue()) {
      this.advance();
      return { type: 'ContinueStatement' };
    }
    if (t.type === 'Name' && t.value === 'export' && this.peek(1).type === 'Name' && this.peek(1).value === 'type') {
      return this.parseTypeAlias(true);
    }
    if (t.type === 'Name' && t.value === 'type' && this.peek(1).type === 'Name') {
      return this.parseTypeAlias(false);
    }

    return this.parseExprStatement();
  }

  looksLikeContinue() {
    const n = this.peek(1);
    if (n.type === 'Symbol' && ['=', ',', '.', ':', '(', '{'].includes(n.value)) return false;
    if (n.type === 'String' || n.type === 'InterpString') return false;
    if (n.type === 'Symbol' && COMPOUND_OPS.has(n.value)) return false;
    return true;
  }

  parseLabelStatement() {
    this.advance();
    const name = this.expectName();
    this.expectSymbol('::');
    return { type: 'LabelStatement', name };
  }

  parseTypeAlias(isExport) {
    if (isExport) this.advance(); // consumed 'export' by caller check, safe to re-check
    this.expectName(); // 'type' (Name token)
    const name = this.expectName();
    let generics = '';
    if (this.isSymbol('<')) generics = this.captureRawBalanced('<', '>');
    this.expectSymbol('=');
    const raw = this.captureRawTypeExpression();
    return { type: 'RawStatement', text: `${isExport ? 'export ' : ''}type ${name}${generics} = ${raw}` };
  }

  parseReturnStatement() {
    this.advance();
    let args = [];
    if (!this.atBlockEnd() && !this.isSymbol(';')) args = this.parseExprList();
    if (this.isSymbol(';')) this.advance();
    return { type: 'ReturnStatement', arguments: args };
  }

  parseIfStatement() {
    this.advance();
    const clauses = [];
    let condition = this.parseExpr(0);
    this.expectKeyword('then');
    let body = this.parseBlock();
    clauses.push({ condition, body });
    while (this.isKeyword('elseif')) {
      this.advance();
      condition = this.parseExpr(0);
      this.expectKeyword('then');
      body = this.parseBlock();
      clauses.push({ condition, body });
    }
    let elseBody = null;
    if (this.isKeyword('else')) { this.advance(); elseBody = this.parseBlock(); }
    this.expectKeyword('end');
    return { type: 'IfStatement', clauses, elseBody };
  }

  parseForStatement() {
    this.advance();
    const name1 = this.expectName();
    this.maybeSkipTypeAnnotation();
    if (this.isSymbol('=')) {
      this.advance();
      const start = this.parseExpr(0);
      this.expectSymbol(',');
      const limit = this.parseExpr(0);
      let step = null;
      if (this.isSymbol(',')) { this.advance(); step = this.parseExpr(0); }
      this.expectKeyword('do');
      const body = this.parseBlock();
      this.expectKeyword('end');
      return { type: 'NumericForStatement', variable: { name: name1 }, start, limit, step, body };
    }
    const names = [{ name: name1 }];
    while (this.isSymbol(',')) { this.advance(); const n = this.expectName(); this.maybeSkipTypeAnnotation(); names.push({ name: n }); }
    this.expectKeyword('in');
    const iterators = this.parseExprList();
    this.expectKeyword('do');
    const body = this.parseBlock();
    this.expectKeyword('end');
    return { type: 'GenericForStatement', names, iterators, body };
  }

  parseFunctionStatement() {
    this.advance();
    let base = { type: 'Identifier', name: this.expectName() };
    let isMethod = false;
    while (this.isSymbol('.')) { this.advance(); base = { type: 'MemberExpression', base, indexer: '.', property: this.expectName() }; }
    if (this.isSymbol(':')) { this.advance(); base = { type: 'MemberExpression', base, indexer: ':', property: this.expectName() }; isMethod = true; }
    const fb = this.parseFuncBody(isMethod);
    return { type: 'FunctionDeclaration', id: base, isLocal: false, isMethod, ...fb };
  }

  parseLocalOrLocalFunction() {
    this.advance(); // 'local'
    if (this.isKeyword('function')) {
      this.advance();
      const name = this.expectName();
      const fb = this.parseFuncBody(false);
      return { type: 'FunctionDeclaration', id: { type: 'Identifier', name }, isLocal: true, isMethod: false, ...fb };
    }
    const names = [];
    do {
      const name = this.expectName();
      let attrib = null;
      if (this.isSymbol('<')) { this.advance(); attrib = this.expectName(); this.expectSymbol('>'); }
      this.maybeSkipTypeAnnotation();
      names.push({ name, attrib });
    } while (this.isSymbol(',') && this.advance());
    let init = [];
    if (this.isSymbol('=')) { this.advance(); init = this.parseExprList(); }
    return { type: 'LocalStatement', names, init };
  }

  parseExprStatement() {
    const first = this.parseSuffixedExpr();
    const variables = [first];
    while (this.isSymbol(',')) { this.advance(); variables.push(this.parseSuffixedExpr()); }
    if (this.isSymbol('=')) {
      this.advance();
      const init = this.parseExprList();
      return { type: 'AssignmentStatement', operator: '=', variables, init };
    }
    if (this.cur().type === 'Symbol' && COMPOUND_OPS.has(this.cur().value)) {
      const op = this.advance().value;
      if (variables.length > 1) this.error('Compound assignment does not support multiple targets');
      const value = this.parseExpr(0);
      return { type: 'AssignmentStatement', operator: op, variables, init: [value] };
    }
    if (variables.length === 1 && variables[0].type === 'CallExpression') {
      return { type: 'CallStatement', expression: variables[0] };
    }
    this.error('Syntax error: expected assignment or call statement');
  }

  parseExprList() {
    const list = [this.parseExpr(0)];
    while (this.isSymbol(',')) { this.advance(); list.push(this.parseExpr(0)); }
    return list;
  }

  parseFuncBody(isMethod) {
    let generics = null;
    if (this.isSymbol('<')) generics = this.captureRawBalanced('<', '>');
    this.expectSymbol('(');
    const params = [];
    let vararg = false;
    if (isMethod) params.push({ name: 'self', implicit: true });
    if (!this.isSymbol(')')) {
      for (;;) {
        if (this.isSymbol('...')) { this.advance(); vararg = true; break; }
        const name = this.expectName();
        this.maybeSkipTypeAnnotation();
        params.push({ name });
        if (this.isSymbol(',')) { this.advance(); continue; }
        break;
      }
    }
    this.expectSymbol(')');
    if (this.isSymbol(':')) { this.advance(); this.captureRawTypeExpression(); }
    const body = this.parseBlock();
    this.expectKeyword('end');
    return { params, vararg, body, generics };
  }

  maybeSkipTypeAnnotation() {
    if (this.isSymbol(':')) { this.advance(); this.captureRawTypeExpression(); }
  }

  // Consumes tokens until a depth-0 terminator relevant to param/local lists,
  // or (for type-alias RHS / return types with no natural terminator token)
  // until a completed type atom is not followed by a recognized connector
  // (`|`, `&`, `.`, `->`, or a generic `<...>` application). Best-effort: real
  // Luau type grammar is far richer, but this reliably avoids swallowing the
  // statement that follows the type, which is what actually matters here
  // since types are carried through as raw text rather than obfuscated.
  captureRawTypeExpression() {
    const CONNECTORS = new Set(['|', '&', '.', '->']);
    let depth = 0;
    let sawAtom = false;
    const parts = [];
    for (;;) {
      const t = this.cur();
      if (t.type === 'EOF') break;

      if (depth === 0) {
        if (sawAtom) {
          if (t.type === 'Symbol' && t.value === '?') { parts.push('?'); this.advance(); continue; }
          if (t.type === 'Symbol' && CONNECTORS.has(t.value)) { parts.push(this.tokenRawText(t)); this.advance(); sawAtom = false; continue; }
          if (t.type === 'Symbol' && t.value === '<') { depth++; parts.push('<'); this.advance(); continue; }
          break;
        }
        if (t.type === 'Symbol' && [',', '=', ')', ';', '::'].includes(t.value)) break;
        if (t.type === 'Keyword' && (STATEMENT_START_KEYWORDS.has(t.value) || BLOCK_END_KEYWORDS.has(t.value) || t.value === 'in' || t.value === 'then')) break;
        if (t.type === 'Name' && t.value === 'continue' && this.looksLikeContinue()) break;
      }

      if (t.type === 'Symbol' && ['(', '{', '['].includes(t.value)) { depth++; parts.push(this.tokenRawText(t)); this.advance(); continue; }
      if (t.type === 'Symbol' && [')', '}', ']'].includes(t.value)) {
        depth--; parts.push(this.tokenRawText(t)); this.advance();
        if (depth === 0) sawAtom = true;
        continue;
      }
      if (t.type === 'Symbol' && t.value === '>' && depth > 0) {
        depth--; parts.push('>'); this.advance();
        if (depth === 0) sawAtom = true;
        continue;
      }
      parts.push(this.tokenRawText(t));
      this.advance();
      if (depth === 0) sawAtom = true;
    }
    return parts.join(' ').replace(/\s+([,)\]}])/g, '$1').replace(/([(\[{])\s+/g, '$1');
  }

  captureRawBalanced(openVal, closeVal) {
    let depth = 0;
    const parts = [];
    for (;;) {
      const t = this.cur();
      if (t.type === 'EOF') this.error('Unexpected end of file');
      parts.push(this.tokenRawText(t));
      if (t.type === 'Symbol' && t.value === openVal) depth++;
      if (t.type === 'Symbol' && t.value === closeVal) { depth--; this.advance(); if (depth === 0) break; continue; }
      this.advance();
    }
    return parts.join('');
  }

  tokenRawText(t) {
    if (t.type === 'String') {
      const q = t.quote || '"';
      return q + t.value.replace(new RegExp(q, 'g'), '\\' + q).replace(/\n/g, '\\n') + q;
    }
    if (t.type === 'InterpString') return t.value;
    return t.value;
  }

  // ---- Expressions ----

  parseExpr(minPrec) {
    let left = this.parseUnary();
    for (;;) {
      const t = this.cur();
      const op = (t.type === 'Symbol' || t.type === 'Keyword') ? t.value : null;
      if (op === null || !(op in BIN_PRECEDENCE)) break;
      const prec = BIN_PRECEDENCE[op];
      if (prec < minPrec) break;
      this.advance();
      const nextMin = RIGHT_ASSOC.has(op) ? prec : prec + 1;
      const right = this.parseExpr(nextMin);
      left = { type: 'BinaryExpression', operator: op, left, right };
    }
    return left;
  }

  parseUnary() {
    const t = this.cur();
    if ((t.type === 'Keyword' && t.value === 'not') || (t.type === 'Symbol' && (t.value === '-' || t.value === '#'))) {
      this.advance();
      const argument = this.parseExpr(UNARY_PREC);
      return { type: 'UnaryExpression', operator: t.value, argument };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.cur();
    if (t.type === 'Keyword') {
      switch (t.value) {
        case 'nil': this.advance(); return { type: 'NilLiteral' };
        case 'true': this.advance(); return { type: 'BooleanLiteral', value: true };
        case 'false': this.advance(); return { type: 'BooleanLiteral', value: false };
        case 'function': this.advance(); return { type: 'FunctionExpression', ...this.parseFuncBody(false) };
        case 'if': return this.parseIfExpression();
      }
    }
    if (t.type === 'Number') { this.advance(); return { type: 'NumericLiteral', raw: t.value }; }
    if (t.type === 'String') { this.advance(); return { type: 'StringLiteral', value: t.value, quote: t.quote || '"', long: !!t.long, level: t.level }; }
    if (t.type === 'InterpString') { this.advance(); return { type: 'InterpStringLiteral', raw: t.value }; }
    if (t.type === 'Symbol' && t.value === '...') { this.advance(); return { type: 'VarargLiteral' }; }
    if (t.type === 'Symbol' && t.value === '{') return this.parseTableConstructor();
    return this.parseSuffixedExpr();
  }

  parseIfExpression() {
    this.advance();
    const clauses = [];
    let condition = this.parseExpr(0);
    this.expectKeyword('then');
    let body = this.parseExpr(0);
    clauses.push({ condition, body });
    while (this.isKeyword('elseif')) {
      this.advance();
      condition = this.parseExpr(0);
      this.expectKeyword('then');
      body = this.parseExpr(0);
      clauses.push({ condition, body });
    }
    this.expectKeyword('else');
    const elseBody = this.parseExpr(0);
    return { type: 'IfExpression', clauses, elseBody };
  }

  parsePrimaryExprBase() {
    if (this.isSymbol('(')) {
      this.advance();
      const expr = this.parseExpr(0);
      this.expectSymbol(')');
      return { type: 'ParenthesizedExpression', expression: expr };
    }
    if (this.cur().type === 'Name') return { type: 'Identifier', name: this.advance().value };
    this.error(`Unexpected token '${this.describe(this.cur())}'`);
  }

  parseSuffixedExpr() {
    let base = this.parsePrimaryExprBase();
    for (;;) {
      if (this.isSymbol('.')) {
        this.advance();
        base = { type: 'MemberExpression', base, indexer: '.', property: this.expectName() };
      } else if (this.isSymbol('[')) {
        this.advance();
        const property = this.parseExpr(0);
        this.expectSymbol(']');
        base = { type: 'MemberExpression', base, indexer: '[', property, computed: true };
      } else if (this.isSymbol(':')) {
        this.advance();
        const method = this.expectName();
        const args = this.parseCallArgs();
        base = { type: 'CallExpression', base, method, arguments: args };
      } else if (this.isSymbol('(') || this.isSymbol('{') || this.cur().type === 'String' || this.cur().type === 'InterpString') {
        const args = this.parseCallArgs();
        base = { type: 'CallExpression', base, method: null, arguments: args };
      } else break;
    }
    return base;
  }

  parseCallArgs() {
    if (this.isSymbol('(')) {
      this.advance();
      let args = [];
      if (!this.isSymbol(')')) args = this.parseExprList();
      this.expectSymbol(')');
      return args;
    }
    if (this.isSymbol('{')) return [this.parseTableConstructor()];
    if (this.cur().type === 'String') { const t = this.advance(); return [{ type: 'StringLiteral', value: t.value, quote: t.quote || '"', long: !!t.long, level: t.level }]; }
    if (this.cur().type === 'InterpString') { const t = this.advance(); return [{ type: 'InterpStringLiteral', raw: t.value }]; }
    this.error('Expected function arguments');
  }

  parseTableConstructor() {
    this.expectSymbol('{');
    const fields = [];
    while (!this.isSymbol('}')) {
      if (this.isSymbol('[')) {
        this.advance();
        const key = this.parseExpr(0);
        this.expectSymbol(']');
        this.expectSymbol('=');
        const value = this.parseExpr(0);
        fields.push({ type: 'KeyedField', key, value });
      } else if (this.cur().type === 'Name' && this.peek(1).type === 'Symbol' && this.peek(1).value === '=') {
        const key = this.advance().value;
        this.advance();
        const value = this.parseExpr(0);
        fields.push({ type: 'NameField', key, value });
      } else {
        fields.push({ type: 'ExpressionField', value: this.parseExpr(0) });
      }
      if (this.isSymbol(',') || this.isSymbol(';')) this.advance();
      else break;
    }
    this.expectSymbol('}');
    return { type: 'TableConstructor', fields };
  }
}

function parse(src) {
  return new Parser(src).parseChunk();
}

module.exports = { parse, Parser };
