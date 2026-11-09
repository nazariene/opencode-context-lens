// Evaluate the installed single-file bundle with the same shared-module boundary as Desktop.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as main from '@opencode/plugin/gui/main';
import * as rpc from '@opencode/plugin/rpc';

export async function loadGUI(window = false) {
  const inert = new Proxy(function () {}, { get: () => inert, apply: () => inert, construct: () => inert });
  const modules = {
    '@opencode/plugin/gui': window ? await import('@opencode/plugin/gui') : main,
    '@opencode/plugin/rpc': rpc,
    'solid-js': window ? await import('solid-js') : inert,
    'solid-js/web': inert,
  };
  const source = await readFile(new URL('./dist/gui-experimental.cjs', import.meta.url), 'utf8');
  const module = { exports: {} };
  runInNewContext(source, { module, exports: module.exports, crypto, AbortController, Error,
    require: (name) => { assert.ok(Object.hasOwn(modules, name), `Unexpected GUI dependency: ${name}`); return modules[name]; },
  }, { timeout: 5000, filename: 'gui-experimental.cjs' });
  const definition = module.exports.default;
  assert.equal(typeof definition?.setup, 'function', 'GUI must export a window setup.');
  return definition;
}

if (process.argv.includes('--check')) {
  await loadGUI();
  console.log('Desktop GUI bundle: standalone main-process evaluation passed.');
}
