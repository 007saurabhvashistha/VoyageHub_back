import http from 'node:http';
import https from 'node:https';
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent';

const responseLimit = 64 * 1024;
const agents = {
  public: { 'http:': new RequestFilteringHttpAgent(), 'https:': new RequestFilteringHttpsAgent() },
  private: { 'http:': new RequestFilteringHttpAgent({ allowPrivateIPAddress: true }), 'https:': new RequestFilteringHttpsAgent({ allowPrivateIPAddress: true }) },
};

function apiUrl(apiBaseUrl) {
  let base;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    throw new Error('Enter a valid Aviat CRM API base URL.');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Aviat CRM URL must be an HTTP(S) API base URL without credentials, query, or fragment.');
  }
  if (process.env.NODE_ENV === 'production' && base.protocol !== 'https:') {
    throw new Error('Aviat CRM must use HTTPS in production.');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/itineraries`;
  return base;
}

function requestJson(url, { method = 'POST', token, body = null }) {
  const target = new URL(url);
  const agent = (process.env.NODE_ENV === 'production' ? agents.public : agents.private)[target.protocol];
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-requested-with': 'XMLHttpRequest',
    ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
  };

  return new Promise((resolve, reject) => {
    const outgoing = (target.protocol === 'https:' ? https : http).request(target, { method, headers, agent, timeout: 15000 }, (incoming) => {
      const chunks = [];
      let size = 0;
      incoming.on('data', (chunk) => {
        size += chunk.length;
        if (size > responseLimit) outgoing.destroy(new Error('Aviat CRM response exceeded the size limit.'));
        else chunks.push(chunk);
      });
      incoming.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let responseBody = null;
        try { responseBody = text ? JSON.parse(text) : null; } catch { /* Preserve non-JSON responses as null. */ }
        resolve({ status: incoming.statusCode, body: responseBody });
      });
      incoming.on('error', reject);
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('Aviat CRM request timed out.')));
    outgoing.on('error', reject);
    if (payload) outgoing.write(payload);
    outgoing.end();
  });
}

export async function createAviatCrmItinerary({ apiBaseUrl, accessToken, itinerary }) {
  const target = apiUrl(apiBaseUrl);
  const result = await requestJson(target, { token: accessToken, body: itinerary });
  if (result.status < 200 || result.status >= 300 || !Number.isInteger(result.body?.id)) {
    throw new Error('Aviat CRM did not accept the itinerary. Check the API URL, access token, and itinerary permissions.');
  }
  return { id: result.body.id, title: result.body.title ?? itinerary.title };
}