#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { obfuscate } = require('./src/index');
const { LuaSyntaxError } = require('./src/lexer');

function printUsage() {
  console.log(`Luau AST Obfuscator

Usage:
  node cli.js <input.lua> [output.lua] [options]

Options:
  --no-rename            Don't rename local variables/functions
  --confusing-names       Use lookalike (I/l/1/O/0) identifier names instead of short ones
  --no-strings            Don't obfuscate string literals
  --no-numbers            Don't obfuscate numeric literals
  --xor-strings           Extra layer: XOR the string table with a random key (see README)
  --string-max-length=N   Skip encoding strings longer than N bytes (default: no limit)
  --flatten               Enable control-flow flattening (opt-in, changes code shape most)
  --flatten-probability=N Probability (0-1) a given eligible block gets flattened (default 0.6)
  --junk-code             Scatter provably-dead junk branches through the code (pure noise, see README)
  --junk-probability=N    Probability (0-1) of junk before each statement (default 0.2)
  --seed=N                Use a fixed integer seed for reproducible output
  --pretty                Indent output for debugging (otherwise dense/compact)
  --help                  Show this message
`);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help')) { printUsage(); process.exit(args.includes('--help') ? 0 : 1); }

  const positional = args.filter(a => !a.startsWith('--'));
  const flags = args.filter(a => a.startsWith('--'));
  const inputPath = positional[0];
  const outputPath = positional[1];

  if (!inputPath) { printUsage(); process.exit(1); }

  const options = {};
  if (flags.includes('--no-rename')) options.renameVariables = false;
  if (flags.includes('--confusing-names')) options.renameStyle = 'confusing';
  if (flags.includes('--no-strings')) options.obfuscateStrings = false;
  if (flags.includes('--no-numbers')) options.obfuscateNumbers = false;
  if (flags.includes('--xor-strings')) options.xorStrings = true;
  if (flags.includes('--flatten')) options.flattenControlFlow = true;
  if (flags.includes('--junk-code')) options.injectDeadCode = true;
  if (flags.includes('--pretty')) options.pretty = true;
  const probFlag = flags.find(f => f.startsWith('--flatten-probability='));
  if (probFlag) {
    const p = parseFloat(probFlag.split('=')[1]);
    if (Number.isFinite(p) && p >= 0 && p <= 1) options.flattenProbability = p;
    else console.error(`Ignoring invalid --flatten-probability (expected a number 0-1), using default`);
  }
  const junkProbFlag = flags.find(f => f.startsWith('--junk-probability='));
  if (junkProbFlag) {
    const p = parseFloat(junkProbFlag.split('=')[1]);
    if (Number.isFinite(p) && p >= 0 && p <= 1) options.deadCodeProbability = p;
    else console.error(`Ignoring invalid --junk-probability (expected a number 0-1), using default`);
  }
  const maxLenFlag = flags.find(f => f.startsWith('--string-max-length='));
  if (maxLenFlag) {
    const n = parseInt(maxLenFlag.split('=')[1], 10);
    if (Number.isFinite(n) && n > 0) options.stringMaxLength = n;
    else console.error(`Ignoring invalid --string-max-length, using default (no limit)`);
  }
  const seedFlag = flags.find(f => f.startsWith('--seed='));
  if (seedFlag) {
    const s = parseInt(seedFlag.split('=')[1], 10);
    if (Number.isFinite(s)) options.seed = s;
    else console.error(`Ignoring invalid --seed (expected an integer)`);
  }

  const source = fs.readFileSync(inputPath, 'latin1');

  let output;
  try {
    output = obfuscate(source, options);
  } catch (err) {
    if (err instanceof LuaSyntaxError) {
      console.error(`Parse error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (outputPath) {
    fs.writeFileSync(outputPath, output, 'latin1');
    const before = Buffer.byteLength(source, 'latin1');
    const after = Buffer.byteLength(output, 'latin1');
    console.log(`Wrote ${outputPath} (${before} -> ${after} bytes)`);
  } else {
    process.stdout.write(Buffer.from(output, 'latin1'));
    process.stdout.write('\n');
  }
}

main(process.argv);
