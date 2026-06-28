'use strict';
// The headline bug: the old bash `read` empty-body check
//   [ -z "${BODY//[[:space:]]/}" ]
// span-locks the CPU for minutes on a ~27KB body under macOS bash 3.2 (a 90-byte
// body is instant). The node port replaces it with an O(n) regex test.
//
// GREEN (always on): the node `isBlank` handles a 27KB body in well under 500ms.
// RED (opt-in, slow): set TLR_PROVE_BASH_HANG=1 to run the ACTUAL /bin/bash check
// against the same 27KB body and prove it blows past a 20s timeout (CPU-bound),
// while a 90-byte body returns instantly. Gated because it deliberately burns
// ~20s of CPU; run it once to witness the original bug, then leave it off.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const lib = require('../scripts/lib.js');

const BIG_27KB = 'word '.repeat(Math.floor((27 * 1024) / 5)); // ~27KB of text
const SMALL_90B = 'a short ninety-byte body that should be effectively instant under the strip check here ok';

test('FIX is green: node isBlank on a 27KB body is instant and correct', () => {
  const t0 = Date.now();
  assert.equal(lib.isBlank(BIG_27KB), false);
  const dt = Date.now() - t0;
  assert.ok(dt < 500, `node isBlank took ${dt}ms on 27KB (expected < 500ms)`);
});

test('old bash ${//} check span-locks on 27KB (opt-in via TLR_PROVE_BASH_HANG=1)',
  { skip: process.env.TLR_PROVE_BASH_HANG !== '1' }, () => {
    const script = '[ -z "${1//[[:space:]]/}" ] && echo blank || echo nonblank';

    // 90-byte body: instant.
    const t0 = Date.now();
    const small = execFileSync('/bin/bash', ['-c', script, 'bash', SMALL_90B], { encoding: 'utf8' });
    const smallMs = Date.now() - t0;
    assert.equal(small.trim(), 'nonblank');
    assert.ok(smallMs < 1000, `small body took ${smallMs}ms (expected instant)`);

    // 27KB body: must blow past a 20s timeout (CPU span-lock). `timeout` kills it
    // with exit 124, which execFileSync surfaces as a throw — that IS the red.
    const t1 = Date.now();
    let hung = false;
    try {
      execFileSync('timeout', ['20', '/bin/bash', '-c', script, 'bash', BIG_27KB], { encoding: 'utf8' });
    } catch (err) {
      hung = err.status === 124 || (Date.now() - t1) >= 19000;
    }
    const bigMs = Date.now() - t1;
    assert.ok(hung, `expected the 27KB body to span-lock; it returned in ${bigMs}ms`);
  });
