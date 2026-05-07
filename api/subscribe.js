const ALLOWED_ORIGINS = new Set([
  'https://www.throttledinbond.com',
  'https://throttledinbond.com',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  let brevoRes;
  try {
    brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        email,
        listIds: [2],
        updateEnabled: true,
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: 'Upstream unreachable' });
  }

  if (brevoRes.status === 201 || brevoRes.status === 204) {
    return res.status(200).json({ ok: true });
  }

  let upstreamBody = '';
  try { upstreamBody = await brevoRes.text(); } catch {}
  return res.status(502).json({
    error: 'Subscription failed',
    upstreamStatus: brevoRes.status,
    upstreamBody,
  });
}
