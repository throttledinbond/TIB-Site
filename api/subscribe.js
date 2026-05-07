const ALLOWED_ORIGINS = new Set([
  'https://www.throttledinbond.com',
  'https://throttledinbond.com',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeUSPhone(raw) {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

function clean(s, max) {
  if (typeof s !== 'string') return '';
  const t = s.trim();
  return t.length > max ? t.slice(0, max) : t;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const email = clean(body.email, 254);
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  const phoneRaw = clean(body.phone, 32);
  const smsConsent = body.smsConsent === true;

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  let smsE164 = null;
  if (phoneRaw) {
    if (!smsConsent) {
      return res.status(400).json({ error: 'SMS consent required when phone is provided' });
    }
    smsE164 = normalizeUSPhone(phoneRaw);
    if (!smsE164) {
      return res.status(400).json({ error: 'Invalid US phone number' });
    }
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server not configured' });

  const attributes = {};
  if (firstName) attributes.FIRSTNAME = firstName;
  if (lastName) attributes.LASTNAME = lastName;
  if (smsE164) {
    attributes.SMS = smsE164;
    attributes.SMS_OPTIN_DATE = new Date().toISOString().slice(0, 10);
  }

  const payload = {
    email,
    listIds: [2],
    updateEnabled: true,
  };
  if (Object.keys(attributes).length) payload.attributes = attributes;

  let brevoRes;
  try {
    brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
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
