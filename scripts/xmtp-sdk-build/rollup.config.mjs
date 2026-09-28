import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { dts } from 'rollup-plugin-dts';
import tsConfigPaths from 'rollup-plugin-tsconfig-paths';
const external = ['@xmtp/wasm-bindings', '@xmtp/content-type-primitives', 'viem', 'viem/accounts'];
export default [
  ...['index', 'workers/client', 'workers/opfs'].map(name => ({
    input: `src/${name}.ts`,
    output: { file: `dist/${name}.js`, format: 'es', sourcemap: true },
    external,
    plugins: [tsConfigPaths(), typescript({ declaration: false, declarationMap: false, noEmitOnError: true }), terser()],
  })),
  { input: 'src/index.ts', output: { file: 'dist/index.d.ts', format: 'es' }, external, plugins: [tsConfigPaths(), dts()] },
];
