const https = require('https');

const API_KEY = '631bed3b0972a02b56f48d8506ebd267';
const API_HOST = 'v1.mma.api-sports.io';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    // Extraire le path et query depuis l'URL entrante
    // Ex: /api/fighters?search=poirier → /fighters?search=poirier
    // Ex: /api/fighters/255/fights → /fights?fighter=255
    const fullUrl = req.url; // ex: /api/fighters?search=poirier
    const [pathname, querystring] = fullUrl.split('?');
    
    let citoPath;
    const fightsMatch = pathname.match(/\/api\/fighters\/(\d+)\/fights/);
    const singleMatch = pathname.match(/\/api\/fighters\/(\d+)$/);

    if (fightsMatch) {
      citoPath = `/fights?fighter=${fightsMatch[1]}${querystring ? '&'+querystring : ''}`;
    } else if (singleMatch) {
      citoPath = `/fighters?id=${singleMatch[1]}`;
    } else {
      // Liste ou recherche: /api/fighters?search=xxx → /fighters?search=xxx
      citoPath = `/fighters${querystring ? '?'+querystring : ''}`;
    }

    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: API_HOST,
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
            resolve({ status: proxyRes.statusCode, body: { error: 'Parse error', raw: body.slice(0, 200) } });
          }
        });
      });

      proxyReq.on('error', reject);
      proxyReq.end();
    });

    res.status(data.status).json(data.body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
