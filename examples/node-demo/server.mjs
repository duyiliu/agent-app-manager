import http from 'node:http';

const send = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { status: 'UP', application: 'node-demo', pid: process.pid, time: new Date().toISOString() });
  }
  if (req.method === 'GET' && url.pathname === '/api/hello') {
    return send(res, 200, { message: `Hello, ${url.searchParams.get('name') ?? 'Project Runner'}!`, version: 'v1' });
  }
  if (req.method === 'POST' && url.pathname === '/api/logs') {
    const level = url.searchParams.get('level') ?? 'INFO';
    if (!['INFO', 'WARN', 'ERROR'].includes(level)) return send(res, 400, { error: 'level must be INFO, WARN or ERROR' });
    const output = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
    output(`Demo log: ${level} sample`);
    return send(res, 200, { logged: level });
  }
  send(res, 404, { error: 'Not found' });
}).listen(18275, '127.0.0.1', () => console.log('node-demo listening on http://127.0.0.1:18275'));
