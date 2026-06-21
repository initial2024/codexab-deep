export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
};

const RENDER_PARSE_VERSION = 'render-parse-forward-v1-20260621';

const DEFAULT_PARSE_ENDPOINT =
  process.env.PARSE_ENDPOINT || 'https://codexab.vercel.app/api/parse';

function setCors(req, res) {
  const origin = req.headers.origin || '*';

  if (origin === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  const requestHeaders =
    req.headers['access-control-request-headers'] ||
    'Content-Type, Authorization, X-Requested-With, X-API-Key, x-api-key, Cache-Control, Pragma';

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', requestHeaders);
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(req, res, statusCode, data) {
  setCors(req, res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  return res.end(
    JSON.stringify(
      {
        renderParseVersion: RENDER_PARSE_VERSION,
        ...data,
      },
      null,
      2
    )
  );
}

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readRequestBody(req) {
  if (req.body) {
    return safeJsonParse(req.body, {});
  }

  try {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const raw = Buffer.concat(chunks).toString('utf8');
    return safeJsonParse(raw, {});
  } catch {
    return {};
  }
}

function cleanInputUrl(input) {
  if (!input) return '';

  let value = String(input).trim();

  value = value
    .replace(/^Button:\s*/i, '')
    .replace(/^URL:\s*/i, '')
    .replace(/^Link:\s*/i, '')
    .replace(/^链接:\s*/i, '')
    .replace(/^网址:\s*/i, '')
    .replace(/^目标:\s*/i, '')
    .trim();

  const fullUrlMatch = value.match(/https?:\/\/[^\s"'<>]+/i);
  if (fullUrlMatch) {
    return fullUrlMatch[0].trim();
  }

  const domainMatch = value.match(
    /(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>]*)?/i
  );

  if (domainMatch) {
    value = domainMatch[0].trim();
  }

  if (!/^https?:\/\//i.test(value) && /^www\./i.test(value)) {
    return `https://${value}`;
  }

  if (!/^https?:\/\//i.test(value) && /^[a-z0-9.-]+\.[a-z]{2,}/i.test(value)) {
    return `https://${value}`;
  }

  return value;
}

function normalizeNumber(value, defaultValue, min, max) {
  const n = Number(value);

  if (!Number.isFinite(n)) return defaultValue;

  return Math.max(min, Math.min(max, Math.floor(n)));
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method === 'HEAD') {
    res.statusCode = 200;
    return res.end();
  }

  if (req.method === 'GET') {
    return sendJson(req, res, 200, {
      ok: true,
      success: true,
      status: 'ok',
      ready: true,
      service: 'codexab-render-parse',
      endpoint: '/api/render-parse',
      upstreamParseEndpoint: DEFAULT_PARSE_ENDPOINT,
      methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
      usage: {
        deepExtract:
          'POST /api/render-parse with JSON body: { "url": "https://example.com", "types": [2], "exts": ["pdf"] }',
      },
      time: new Date().toISOString(),
    });
  }

  if (req.method !== 'POST') {
    return sendJson(req, res, 405, {
      ok: false,
      success: false,
      status: 'error',
      error: 'Method Not Allowed',
    });
  }

  const body = await readRequestBody(req);

  if (!body.url) {
    return sendJson(req, res, 400, {
      ok: false,
      success: false,
      status: 'error',
      error: 'Missing target url parameter',
    });
  }

  const cleanedUrl = cleanInputUrl(body.url);

  if (!/^https?:\/\//i.test(cleanedUrl)) {
    return sendJson(req, res, 400, {
      ok: false,
      success: false,
      status: 'error',
      error: 'Invalid url after cleaning',
      inputUrl: body.url,
      cleanedUrl,
    });
  }

  const maxPages = normalizeNumber(body.maxPages, 8, 1, 20);
  const maxProbes = normalizeNumber(body.maxProbes, 40, 1, 80);

  const payload = {
    ...body,

    url: cleanedUrl,
    mode: 'extract',

    deep: true,
    probe: true,
    sameOrigin: body.sameOrigin ?? true,

    maxPages,
    maxProbes,
  };

  try {
    const upstream = await fetch(DEFAULT_PARSE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      return sendJson(req, res, upstream.status, {
        ok: false,
        success: false,
        status: 'error',
        error: 'Upstream parse endpoint returned non-JSON response',
        upstreamStatus: upstream.status,
        preview: text.slice(0, 1000),
      });
    }

    return sendJson(req, res, upstream.status, {
      ...data,
      renderProxy: {
        version: RENDER_PARSE_VERSION,
        endpoint: '/api/render-parse',
        upstreamParseEndpoint: DEFAULT_PARSE_ENDPOINT,
        forcedDeep: true,
        forcedProbe: true,
        inputUrl: body.url,
        cleanedUrl,
        maxPages,
        maxProbes,
      },
    });
  } catch (error) {
    return sendJson(req, res, 500, {
      ok: false,
      success: false,
      status: 'error',
      error: error.message || 'Render parse request failed',
      renderProxy: {
        version: RENDER_PARSE_VERSION,
        upstreamParseEndpoint: DEFAULT_PARSE_ENDPOINT,
        inputUrl: body.url,
        cleanedUrl,
      },
    });
  }
}
