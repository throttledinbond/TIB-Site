const ALLOWED_ORIGINS = new Set([
  'https://www.throttledinbond.com',
  'https://throttledinbond.com',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GENERIC_USER_MESSAGE = "Something went wrong on our end. Please try again in a moment.";

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

function mapBrevoError(status, body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  const code = parsed && parsed.code;
  const dupKeys = parsed && parsed.metadata && parsed.metadata.duplicate_identifiers;

  if (code === 'duplicate_parameter' && Array.isArray(dupKeys) && dupKeys.includes('SMS')) {
    return "That phone number is already registered. Please use a different number, or leave the phone field blank.";
  }
  if (code === 'invalid_parameter' && parsed.message && /sms|phone/i.test(parsed.message)) {
    return "That phone number couldn't be accepted. Please double-check and try again.";
  }
  if (code === 'invalid_parameter' && parsed.message && /email/i.test(parsed.message)) {
    return "That email address couldn't be accepted. Please double-check and try again.";
  }
  if (status === 429) {
    return "We're getting a lot of signups right now. Please try again in a minute.";
  }
  if (status >= 500) {
    return "Our signup service is temporarily unavailable. Please try again in a few minutes.";
  }
  return GENERIC_USER_MESSAGE;
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
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed', userMessage: GENERIC_USER_MESSAGE });
  }

  const body = req.body || {};
  const email = clean(body.email, 254);
  const firstName = clean(body.firstName, 80);
  const lastName = clean(body.lastName, 80);
  const phoneRaw = clean(body.phone, 32);
  const smsConsent = body.smsConsent === true;

  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_email', userMessage: GENERIC_USER_MESSAGE });
  }

  let smsE164 = null;
  if (phoneRaw) {
    if (!smsConsent) {
      return res.status(400).json({ error: 'sms_consent_required', userMessage: GENERIC_USER_MESSAGE });
    }
    smsE164 = normalizeUSPhone(phoneRaw);
    if (!smsE164) {
      return res.status(400).json({ error: 'invalid_phone', userMessage: GENERIC_USER_MESSAGE });
    }
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('subscribe: BREVO_API_KEY missing');
    return res.status(500).json({ error: 'server_misconfigured', userMessage: GENERIC_USER_MESSAGE });
  }

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
    console.error('subscribe: brevo unreachable', err);
    return res.status(502).json({ error: 'upstream_unreachable', userMessage: GENERIC_USER_MESSAGE });
  }

  if (brevoRes.status === 201 || brevoRes.status === 204) {
    return res.status(200).json({ ok: true });
  }

  let upstreamBody = '';
  try { upstreamBody = await brevoRes.text(); } catch {}
  console.error('subscribe: brevo error', brevoRes.status, upstreamBody);
  const userMessage = mapBrevoError(brevoRes.status, upstreamBody);
  const clientStatus = brevoRes.status === 429 ? 429 : (brevoRes.status >= 500 ? 502 : 400);
  return res.status(clientStatus).json({ error: 'subscription_failed', userMessage });
}
