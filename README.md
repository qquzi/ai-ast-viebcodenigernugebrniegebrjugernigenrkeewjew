# Luau AST Obfuscator

A real obfuscator for Luau/Lua source: it tokenizes your code, parses it into
an actual AST, transforms the tree, and prints Lua back out — not a
regex/string-replace tool. This is the AST-transform layer only (no bytecode
VM yet), as requested.

## Why AST-based instead of regex

A regex-based "obfuscator" can't tell a variable from a string from a table
key, so it either breaks code or barely obfuscates anything. Working on a
real parse tree means:

- **Renaming is scope-correct.** Every identifier is resolved to its actual
  binding (or recognized as a global and left alone), so shadowing, closures/
  upvalues, and `self` all rename consistently instead of via string matching.
- **Structural transforms are possible.** String/number literal encoding and
  control-flow flattening operate on real nodes, so they can't accidentally
  fire inside a comment or a string literal the way a regex would.

## Quick start

```
node cli.js input.lua output.lua
```

With no flags you get: scope-aware renaming, string-literal encoding, and
number-literal encoding. Run `node cli.js --help` for all flags.

```
node cli.js input.lua output.lua --flatten --confusing-names
```

Programmatic use:

```js
const { obfuscate } = require('./src/index');
const output = obfuscate(sourceString, {
  renameVariables: true,
  renameStyle: 'short',        // or 'confusing' (I/l/1/O/0 look-alikes)
  obfuscateStrings: true,
  obfuscateNumbers: true,
  xorStrings: false,           // opt-in extra layer on the string table
  injectDeadCode: false,       // opt-in structural noise, see below
  deadCodeProbability: 0.2,
  flattenControlFlow: false,   // opt-in, see below
  flattenProbability: 0.6,
  pretty: false,               // true = indented, for debugging your own changes
  seed: null,                  // set an integer for a reproducible build
});
```

## Pipeline

`lexer.js` → `parser.js` → (string/dead-code/number/flatten transforms) →
`scope.js` → `renameIdentifiers` → `codegen.js`. Source is read/written as raw
bytes (`latin1`, not `utf8`) throughout, deliberately — Lua strings are byte
strings, not Unicode text, and treating them as UTF-8 would corrupt any
literal byte value above 127 (see `obfuscateStrings.js`).

Every transform that uses randomness (`obfuscateNumbers`, `obfuscateStrings`'s
helper-name suffix and XOR key, `flattenControlFlow`, `injectDeadCode`) pulls
from a single seedable PRNG (`rng.js`) rather than `Math.random()` directly.
Pass `seed` to get byte-identical output across runs of the same input and
options — useful for CI, or for diffing "what did this option actually
change" against a baseline.

## What each transform does

- **Renaming** (`transforms/renameIdentifiers.js`): every local, parameter,
  loop variable, and `local function` name is resolved via `scope.js` and
  replaced with a short generated name, guaranteed collision-free against
  both each other and every Lua/Luau reserved word (the generated sequence
  `a, b, ... z, A, ... Z, aa, ab, ...` will otherwise eventually produce
  exact keywords like `do`, `if`, `in`, `end`, `for`, `nil`, `and`, `or`,
  `not` once a file has enough distinct names to reach two letters — every
  generator here skips those exactly rather than assuming the alphabet won't
  collide). Globals, table keys, and method names (the part after `:`/`.`)
  are never touched, since renaming those would change program behavior.
  `self` is renamed too — method declarations (`function T:Method()`) are
  rewritten to `function T.Method(renamedSelf)` internally, since the `:`
  shorthand hardcodes the literal name `self`.
- **String encoding** (`transforms/obfuscateStrings.js`): every string
  literal is replaced with an index lookup into an injected table
  (`local __ObfS_xxx = {"...", "...", ...}` / `local function __ObfD_xxx(i)
  return __ObfS_xxx[i] end`), deduplicated by value. Values are built as real
  Lua source text (properly escaped, byte-safe) and parsed with this tool's
  own parser rather than hand-built as AST nodes.
  - **`--xor-strings`** (opt-in): every stored value is XORed with a random
    per-run key byte before being stored, and the decode function XORs it
    back. This is a speed bump, not encryption — anyone reading the (small,
    fixed-shape) decode function sees exactly how to reverse it — but the
    string table is no longer plaintext to a casual grep or skim of the file.
    The XOR itself is done with plain arithmetic (add/subtract/divide/modulo),
    not a bitwise operator or the `bit32` library, since Luau has no bitwise
    operators and `bit32` isn't guaranteed to exist on every Lua runtime this
    output might run on.
- **Number encoding** (`transforms/obfuscateNumbers.js`): integer literals
  are replaced with an equivalent arithmetic expression (`5` → `(505 - 500)`,
  `12` → `(4 * 3)`, a double negation, etc.), optionally nested a level
  deeper. Floats and scientific notation are left as-is on purpose —
  rederiving them through arithmetic on a shifted intermediate can produce
  different floating-point rounding than the original literal. For the same
  reason there's deliberately no division-based identity even for integers:
  Lua/Luau's `/` is always float division, and while Luau itself has no
  separate integer subtype to expose that, this tool can't fully verify no
  runtime it might target ever observes a difference — not worth the risk
  for one more variant when two safe ones already exist.
- **Dead-code injection** (`transforms/injectDeadCode.js`, **opt-in** via
  `--junk-code`): scatters extra `do...end` blocks through the code that are
  mathematically guaranteed to never execute — the guard is built from the
  fact that for any integer `x`, `(x*x) % 4` is always `0` or `1`, never `2`
  or `3`, so `if (x*x) % 4 == 2 then ... end` can't run no matter what `x`
  is. Because the block provably never runs, its contents can look like
  arbitrary "real" logic with zero risk: it only ever touches its own
  freshly-declared locals, never anything from the surrounding program. This
  is pure noise for a human (or a naive static analyzer) skimming the file —
  it adds no protection against someone who actually runs or traces the
  code — but it's free of behavioral risk by construction, unlike opaque
  predicates that try to guard *real* code. `--junk-probability` (default
  0.2) controls how often a gap between statements gets one.
- **Control-flow flattening** (`transforms/flattenControlFlow.js`, **opt-in**
  via `--flatten`): rewrites a straight-line sequence of statements into a
  `while` loop dispatching on a state variable
  (`if __st==1 then ... elseif __st==2 then ...`). This is the one transform
  that changes code shape significantly, so it's off by default. It only
  ever applies where it can prove it's safe:
  - Blocks containing `break`/`continue` that would target an *enclosing*
    loop are skipped (wrapping them in a new loop would make them target the
    new loop instead — scanning stops at nested loops/functions, which
    correctly capture their own `break`/`continue`).
  - Blocks containing `goto`/`::label::` anywhere are skipped entirely,
    rather than trying to reason about goto's cross-block scoping rules.
  - `local` declarations inside a flattened block are hoisted above the loop
    (mirroring how Lua itself desugars `local function`), so a value declared
    in one branch stays visible to later branches — otherwise each
    `if`/`elseif` branch would be its own scope and the variable would
    vanish one iteration later. Blocks with two locals of the same name
    (legal via shadowing) are skipped rather than risk merging them.
  - `<close>`-attributed locals are skipped (their close-on-scope-exit
    semantics can't survive this restructuring).
  - `--flatten-probability` (default 0.6) controls what fraction of eligible
    blocks actually get flattened, so output size stays reasonable.
  - The state numbers assigned to each original statement are a random
    permutation, not `1, 2, 3...` in original order, and the `elseif`
    branches are *written* in a separately-shuffled order too (each branch
    is self-contained — `if __st == <label> then ... end` — so the order
    they're checked in never affects which one matches). This defeats the
    trivial "the states are just the original code, numbered" reading of a
    flattened block: reading top to bottom no longer corresponds to either
    the label numbering or the execution order.

## Luau syntax support

Beyond standard Lua 5.1-shaped syntax, this parses: `continue`, compound
assignment (`+= -= *= /= %= ^= ..= //=`), `//` floor division, the
`if...then...else` expression form, generic functions (`function f<T>()`),
`type`/`export type` aliases, and string escapes including `\z`, `\xXX`, and
`\u{XXX}` (Unicode codepoint, encoded as UTF-8 bytes).

**Known limitations** (things that parse safely but aren't obfuscated):

- **Type annotations** (`: number`, `<T>`, return types) are captured as raw
  text and reprinted verbatim rather than deeply parsed — they're not
  obfuscated, but they also won't break output. The raw-capture heuristic
  handles common annotations but not every corner of Luau's type grammar.
- **String interpolation** (`` `text {expr}` ``) is preserved as an opaque
  literal rather than parsed — the `{expr}` parts are not obfuscated. Any
  identifier that appears inside an interpolation is automatically excluded
  from renaming everywhere in the file (otherwise the interpolated reference
  would silently point at a name that no longer exists). Nested `"..."`/
  `'...'` strings inside an interpolation are tracked so a brace or backtick
  inside one of them doesn't desync parsing, but a *nested backtick
  interpolation* (interpolation inside an interpolation) isn't — this is a
  text-based safeguard, not real interpolation parsing.
- Very long strings (embedded JSON/base64 blobs, etc.) are still encoded by
  default; use `--string-max-length=N` to skip encoding anything longer than
  N bytes if that matters for your output size.

## Testing this yourself

There's no Luau interpreter in most environments, but plain Lua (5.1-5.4) is
close enough for the non-Luau-specific subset of your code.
`test_runnable.lua` and `test_hoisting_edge_cases.lua` in this project are
self-contained correctness harnesses with no Roblox globals (the latter
specifically targets scoping/hoisting interactions with flattening: loop
bounds depending on an earlier local, nested shadowing, closures capturing a
per-iteration loop local, early returns, deep nesting). Run either before and
after obfuscation with any Lua 5.x interpreter and diff the output — that's
exactly how this tool was validated (200+ randomized/seeded runs across every
flag combination and both files, since string/number encoding, dead-code
injection, and flattening are all randomized per run). Use `--seed=N` to make
a specific run reproducible while debugging a diff.

```
lua test_runnable.lua > before.txt
node cli.js test_runnable.lua obfuscated.lua --flatten --junk-code --xor-strings
lua obfuscated.lua > after.txt
diff before.txt after.txt
```

For actual Roblox/Luau scripts (which this tool is primarily aimed at),
validate in Roblox Studio or with a Luau-capable runtime, since they use
Roblox globals (`game`, `script`, services, etc.) that won't run under
plain Lua.

## Security note

Every technique here (renaming, string/number encoding, the XOR layer, dead
code, flattening) raises the cost of casually reading the output — none of
it is cryptographic, and someone willing to actually run/trace/decompile the
code will get through all of it. Treat this the same way you'd treat any
other Lua/Luau obfuscator: it protects against casual copying and idle
skimming, not a determined reverse engineer.

## Roadmap note

This is deliberately AST-only. A bytecode-VM layer (compiling to a custom
instruction set interpreted by an injected VM) is a much bigger, separate
project — happy to help design that next if you want to go there.
