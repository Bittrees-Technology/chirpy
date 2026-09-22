import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
// Only loopback, synthetic requests. A followed redirect records the unintended destination.
export async function redirectFixture(code: number) {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    req.resume();
    if (req.url === '/source') { res.writeHead(code, { Location: '/destination' }); res.end(); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: 'unexpected-provider-id', result: 'OK' })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/source`,
    requests: () => [...paths],
    close: () => new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeAllConnections(); }),
  };
}
