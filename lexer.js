'use strict';

// `continue`, `export`, and `type` are contextual in Luau (still valid as
// ordinary identifiers) so they are deliberately excluded here and instead
// detected by the parser via value + lookahead.
const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
  'then', 'true', 'until', 'while'
]);

// Multi-char symbols must be checked longest-first.
const SYMBOLS = [
  '...', '..=', '//=',
  '..', '::', '<=', '>=', '==', '~=', '//', '->',
  '+=', '-=', '*=', '/=', '%=', '^=',
  '+', '-', '*', '/', '%', '^', '#', '<', '>', '=',
  '(', ')', '{', '}', '[', ']', ';', ':', ',', '.', '?'
];

class LuaSyntaxError extends Error {
  constructor(message, line, col) {
    super(`${message} (line ${line}, col ${col})`);
    this.line = line;
    this.col = col;
  }
}

function isDigit(c) { return c >= '0' && c <= '9'; }
function isHexDigit(c) { return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
function isAlpha(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isAlphaNum(c) { return isAlpha(c) || isDigit(c); }

class Lexer {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.tokens = [];
  }

  error(msg) {
    throw new LuaSyntaxError(msg, this.line, this.col);
  }

  peekChar(offset = 0) {
    return this.src[this.pos + offset];
  }

  advance() {
    const c = this.src[this.pos++];
    if (c === '\n') { this.line++; this.col = 1; } else { this.col++; }
    return c;
  }

  match(str) {
    return this.src.startsWith(str, this.pos);
  }

  tokenize() {
    while (this.pos < this.src.length) {
      this.skipWhitespaceAndComments();
      if (this.pos >= this.src.length) break;
      const startLine = this.line, startCol = this.col;
      const c = this.peekChar();

      if (c === '"' || c === "'") {
        this.readShortString(startLine, startCol);
      } else if (c === '`') {
        this.readInterpString(startLine, startCol);
      } else if (c === '[' && (this.peekChar(1) === '[' || this.peekChar(1) === '=')) {
        const level = this.tryLongBracketLevel();
        if (level !== null) {
          const value = this.readLongBracket(level);
          this.tokens.push({ type: 'String', value, raw: value, line: startLine, col: startCol, long: true, level });
        } else {
          this.advance();
          this.tokens.push({ type: 'Symbol', value: '[', line: startLine, col: startCol });
        }
      } else if (isDigit(c) || (c === '.' && isDigit(this.peekChar(1)))) {
        this.readNumber(startLine, startCol);
      } else if (isAlpha(c)) {
        this.readNameOrKeyword(startLine, startCol);
      } else {
        this.readSymbol(startLine, startCol);
      }
    }
    this.tokens.push({ type: 'EOF', value: null, line: this.line, col: this.col });
    return this.tokens;
  }

  skipWhitespaceAndComments() {
    for (;;) {
      const c = this.peekChar();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.advance();
        continue;
      }
      if (c === '-' && this.peekChar(1) === '-') {
        this.advance(); this.advance();
        // possible long comment
        if (this.peekChar() === '[') {
          const save = this.pos, saveLine = this.line, saveCol = this.col;
          const level = this.tryLongBracketLevel();
          if (level !== null) {
            this.readLongBracket(level);
            continue;
          } else {
            this.pos = save; this.line = saveLine; this.col = saveCol;
          }
        }
        while (this.pos < this.src.length && this.peekChar() !== '\n') this.advance();
        continue;
      }
      break;
    }
  }

  // Checks for [=*[ at current pos. Returns level (number of '=') or null and
  // restores position if not a valid long-bracket opener.
  tryLongBracketLevel() {
    const save = this.pos, saveLine = this.line, saveCol = this.col;
    if (this.peekChar() !== '[') return null;
    this.advance();
    let level = 0;
    while (this.peekChar() === '=') { this.advance(); level++; }
    if (this.peekChar() === '[') {
      this.advance();
      return level;
    }
    this.pos = save; this.line = saveLine; this.col = saveCol;
    return null;
  }

  readLongBracket(level) {
    // Skip first newline immediately after opening, per Lua spec.
    if (this.peekChar() === '\r') this.advance();
    if (this.peekChar() === '\n') this.advance();
    let out = '';
    const closer = ']' + '='.repeat(level) + ']';
    while (true) {
      if (this.pos >= this.src.length) this.error('Unterminated long bracket');
      if (this.match(closer)) {
        for (let i = 0; i < closer.length; i++) this.advance();
        return out;
      }
      out += this.advance();
    }
  }

  readShortString(line, col) {
    const quote = this.advance();
    let out = '';
    while (true) {
      if (this.pos >= this.src.length) this.error('Unterminated string');
      const c = this.peekChar();
      if (c === quote) { this.advance(); break; }
      if (c === '\n') this.error('Unterminated string');
      if (c === '\\') {
        this.advance();
        out += this.readEscape();
      } else {
        out += this.advance();
      }
    }
    this.tokens.push({ type: 'String', value: out, line, col, quote });
  }

  readEscape() {
    const c = this.advance();
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '\\': return '\\';
      case '"': return '"';
      case "'": return "'";
      case '\n': return '\n';
      case 'z': {
        while (/\s/.test(this.peekChar())) this.advance();
        return '';
      }
      case 'x': {
        let hex = '';
        for (let i = 0; i < 2; i++) { hex += this.advance(); }
        return String.fromCharCode(parseInt(hex, 16));
      }
      case 'u': {
        // \u{XXX} - Unicode codepoint escape (Lua 5.3+/Luau). Encoded here as
        // UTF-8 bytes (one JS char per byte), consistent with how this whole
        // tool treats strings as raw byte sequences (see cli.js's latin1 I/O
        // and obfuscateStrings.js).
        if (this.peekChar() !== '{') this.error("Missing '{' in \\u{xxx} escape");
        this.advance();
        let hex = '';
        while (this.peekChar() !== '}') {
          if (this.pos >= this.src.length) this.error('Unterminated \\u escape');
          hex += this.advance();
        }
        this.advance(); // consume '}'
        const codepoint = parseInt(hex, 16);
        return Buffer.from(String.fromCodePoint(codepoint), 'utf8').toString('latin1');
      }
      default:
        if (isDigit(c)) {
          let num = c;
          for (let i = 0; i < 2 && isDigit(this.peekChar()); i++) num += this.advance();
          return String.fromCharCode(parseInt(num, 10));
        }
        return c;
    }
  }

  // Best-effort: capture raw text of a backtick interpolated string. Interior
  // {expr} segments are NOT parsed into the AST (documented limitation) - the
  // whole literal is preserved and re-emitted verbatim by the code generator.
  // Nested "..."/'...' strings within an {expr} segment are tracked so that a
  // brace or backtick *inside* one of them (e.g. `` `{f("}")}` ``) doesn't
  // desync the depth count or get mistaken for the interpolation's own end.
  readInterpString(line, col) {
    let out = '`';
    this.advance();
    let depth = 0;
    let nestedQuote = null;
    while (true) {
      if (this.pos >= this.src.length) this.error('Unterminated interpolated string');
      const c = this.peekChar();
      if (c === '\\') { out += this.advance(); if (this.pos < this.src.length) out += this.advance(); continue; }
      if (nestedQuote) {
        if (c === nestedQuote) nestedQuote = null;
        out += this.advance();
        continue;
      }
      if (c === '"' || c === "'") { nestedQuote = c; out += this.advance(); continue; }
      if (c === '{') depth++;
      if (c === '}') depth--;
      if (c === '`' && depth <= 0) { out += this.advance(); break; }
      out += this.advance();
    }
    this.tokens.push({ type: 'InterpString', value: out, line, col });
  }

  readNumber(line, col) {
    let out = '';
    if (this.peekChar() === '0' && (this.peekChar(1) === 'x' || this.peekChar(1) === 'X')) {
      out += this.advance(); out += this.advance();
      while (isHexDigit(this.peekChar()) || this.peekChar() === '_') out += this.advance();
      if (this.peekChar() === '.') {
        out += this.advance();
        while (isHexDigit(this.peekChar()) || this.peekChar() === '_') out += this.advance();
      }
      if (this.peekChar() === 'p' || this.peekChar() === 'P') {
        out += this.advance();
        if (this.peekChar() === '+' || this.peekChar() === '-') out += this.advance();
        while (isDigit(this.peekChar())) out += this.advance();
      }
    } else if (this.peekChar() === '0' && (this.peekChar(1) === 'b' || this.peekChar(1) === 'B')) {
      out += this.advance(); out += this.advance();
      while (this.peekChar() === '0' || this.peekChar() === '1' || this.peekChar() === '_') out += this.advance();
    } else {
      while (isDigit(this.peekChar()) || this.peekChar() === '_') out += this.advance();
      if (this.peekChar() === '.') {
        out += this.advance();
        while (isDigit(this.peekChar()) || this.peekChar() === '_') out += this.advance();
      }
      if (this.peekChar() === 'e' || this.peekChar() === 'E') {
        out += this.advance();
        if (this.peekChar() === '+' || this.peekChar() === '-') out += this.advance();
        while (isDigit(this.peekChar())) out += this.advance();
      }
    }
    this.tokens.push({ type: 'Number', value: out, line, col });
  }

  readNameOrKeyword(line, col) {
    let out = '';
    while (this.pos < this.src.length && isAlphaNum(this.peekChar())) out += this.advance();
    const type = KEYWORDS.has(out) ? 'Keyword' : 'Name';
    this.tokens.push({ type, value: out, line, col });
  }

  readSymbol(line, col) {
    for (const sym of SYMBOLS) {
      if (this.match(sym)) {
        for (let i = 0; i < sym.length; i++) this.advance();
        this.tokens.push({ type: 'Symbol', value: sym, line, col });
        return;
      }
    }
    this.error(`Unexpected character '${this.peekChar()}'`);
  }
}

function tokenize(src) {
  return new Lexer(src).tokenize();
}

module.exports = { tokenize, Lexer, LuaSyntaxError, KEYWORDS };
