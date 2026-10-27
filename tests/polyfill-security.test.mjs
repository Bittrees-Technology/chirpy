import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// Exercise the actual transitive serializer used by the browser URL shim.
const web = createRequire(new URL('../apps/web/package.json', import.meta.url));
const polyfill = createRequire(web.resolve('vite-plugin-node-polyfills'));
const stdlib = createRequire(polyfill.resolve('node-stdlib-browser'));
const url = createRequire(stdlib.resolve('url/'));
const qs = url('qs');

for (const encodeValuesOnly of [false, true]) {
  test(`comma serialization handles a shadowed method (values-only: ${encodeValuesOnly})`, () => {
    const input = { route: [{ toString: 0 }] };
    let result;
    assert.doesNotThrow(() => { result = qs.stringify(input, { arrayFormat: 'comma', encodeValuesOnly }); });
    assert.equal(typeof result, 'string');
  });

  test(`comma serialization handles a null-prototype value (values-only: ${encodeValuesOnly})`, () => {
    const item = Object.assign(Object.create(null), { name: 'inbox' });
    let result;
    assert.doesNotThrow(() => { result = qs.stringify({ route: [item] }, { arrayFormat: 'comma', encodeValuesOnly }); });
    assert.equal(typeof result, 'string');
  });
}

test('ordinary comma values and callable conversion retain their behavior', () => {
  assert.equal(qs.stringify({ route: ['inbox', 'requests'] }, { arrayFormat: 'comma' }), 'route=inbox%2Crequests');
  assert.equal(qs.stringify({ route: [{ toString: () => 'contacts' }] }, { arrayFormat: 'comma' }), 'route=contacts');
});
