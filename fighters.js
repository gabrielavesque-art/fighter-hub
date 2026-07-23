const https = require('https');

const API_KEY = 'cito_9aa646185a77d4005d3847af1758a5d5e6cdd980ead94dcb9426922405991718';
const CITO_BASE = 'api.citoapi.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Reconstruit le chemin Cito depuis l'URL entrante
  // /api/ufc/fighters → /api/v1/ufc/fighters
  // /api/ufc/fighters/slug/fights → /api/v1/ufc/fighters/slug/fights
  const incoming = req.url; // ex: /api/ufc/fighters?page=1
  const citoPath = incoming.replace('/api/', '/api/v1/');

  const data = await new Promise((resolve, reject) => {
    const options = {
      hostname: CITO_BASE,
      path: citoPath,
      method: 'GET',
      headers: {
        'x-api-key': API_KEY,
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
          resolve({ status: proxyRes.statusCode, body: { error: 'Parse error', raw: body } });
        }
      });
    });

    proxyReq.on('error', reject);
    proxyReq.end();
  });

  res.status(data.status).json(data.body);
};
