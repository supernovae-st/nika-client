import { createServer } from 'node:http';
import { Nika } from '@supernovae-st/nika-client';

const nika = new Nika({ cwd: process.cwd() });
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const ticket = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const checked = await nika.check('workflow.nika.yaml', { nativeStrict: true });
  if (!checked.clean || ticket.priority !== 'urgent') throw new Error('webhook admission failed');
  const run = await nika.run('workflow.nika.yaml', { maxCostUsd: 0 });
  const result = await run.done;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ticket: ticket.id, result }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const response = await fetch(`http://127.0.0.1:${address.port}`, {
  method: 'POST',
  body: JSON.stringify({ id: 'ticket-42', priority: 'urgent' }),
});
const body = await response.json();
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
console.log(JSON.stringify({
  project: 'support-webhook',
  status: body.result.status,
  trigger: 'real-loopback-http',
  ticket: body.ticket,
  output_keys: Object.keys(body.result.outputs ?? {}),
}));
