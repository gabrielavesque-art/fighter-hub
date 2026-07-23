const https = require('https');

const API_KEY = '26dff9119c2af08e07683df2fb88a94f';
const CITO_BASE = 'v1.mma.api-sports.io';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // /api/fighters?search=poirier → /fighters?search=poirier
  // /api/fighters/123/fights → /fights?fighter=123
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname; // ex: /api/fighters ou /api/fighters/123/fights
  const search = url.search; // ex: ?search=poirier

  let citoPath;
  const fightsMatch = pathname.match(/\/api\/fighters\/([^\/]+)\/fights/);
  const fighterMatch = pathname.match(/\/api\/fighters\/([^\/]+)$/);

  if (fightsMatch) {
    citoPath = `/fights?fighter=${fightsMatch[1]}`;
  } else if (fighterMatch && fighterMatch[1] !== '') {
    citoPath = `/fighters?search=${fighterMatch[1]}`;
  } else {
    citoPath = `/fighters${search}`;
  }

  const data = await new Promise((resolve, reject) => {
    const options = {
      hostname: CITO_BASE,
      path: citoPath,
      method: 'GET',
      headers: {
        'x-apisports-key': API_KEY,
        'Accept': 'application/json'
      }
    };

    const proxyReq = https.request(options, (proxyRes) => {
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        try {
          resolve({ status: proxyRes.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: proxyRes.statusCode, body: { error: 'Parse error' } });
        }
      });
    });

    proxyReq.on('error', reject);
    proxyReq.end();
  });

  res.status(data.status).json(data.body);
};
