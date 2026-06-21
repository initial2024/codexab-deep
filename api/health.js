export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return res.status(200).json({
    ok: true,
    success: true,
    status: 'ok',
    ready: true,
    service: 'codexab-deep-render-parse',
    endpoints: {
      health: '/api/health',
      renderParse: '/api/render-parse',
    },
    time: new Date().toISOString(),
  });
}
