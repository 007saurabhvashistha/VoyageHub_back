import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent';
import { Webhook } from 'standardwebhooks';
import { decryptSecret, encryptSecret } from '../utils/encryption.js';

const userAgent = 'VoyageHub-Webhooks/1.0';
const agents = {
  public: { 'http:': new RequestFilteringHttpAgent(), 'https:': new RequestFilteringHttpsAgent() },
  private: { 'http:': new RequestFilteringHttpAgent({ allowPrivateIPAddress: true }), 'https:': new RequestFilteringHttpsAgent({ allowPrivateIPAddress: true }) },
};

export class WebhookDeliveryError extends Error {
  constructor(code, { retryable = true, statusCode = null } = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

// Standard Webhooks secret: "whsec_" + base64 of 32 random bytes.
export function generateWebhookSecret() {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

export function sealWebhookSecret(secret, key) {
  return encryptSecret(secret, key);
}

export function openWebhookSecret(ciphertext, key) {
  return decryptSecret(ciphertext, key);
}

// Returns an error message, or null when the URL may be used as a webhook destination.
export function webhookUrlProblem(value, { allowInsecureUrls = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a full URL starting with https://.';
  }
  if (url.protocol !== 'https:' && !(allowInsecureUrls && url.protocol === 'http:')) return 'Webhook URLs must use https://.';
  if (url.username || url.password) return 'Put credentials in your receiver, not in the webhook URL.';
  if (url.hash) return 'Remove the # fragment from the webhook URL.';
  return null;
}

// Signs with every active secret so receivers keep verifying while they switch to a rotated secret.
export function signWebhook({ messageId, timestamp, body, secrets }) {
  const signatures = secrets.map((secret) => new Webhook(secret).sign(messageId, timestamp, body));
  return {
    'webhook-id': messageId,
    'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'webhook-signature': signatures.join(' '),
  };
}

// Redirects are not followed and private/reserved addresses are refused at connect time (DNS rebinding safe).
export function postWebhook({ url, body, headers, timeoutMs, allowPrivateNetwork = false }) {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  const agent = (allowPrivateNetwork ? agents.private : agents.public)[target.protocol];
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method: 'POST',
      agent,
      timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': userAgent, ...headers },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({ statusCode: response.statusCode }));
      response.on('error', () => reject(new WebhookDeliveryError('response_failed')));
    });
    request.on('timeout', () => request.destroy(new WebhookDeliveryError('timeout')));
    request.on('error', (error) => {
      if (error instanceof WebhookDeliveryError) return reject(error);
      if (/is not allowed/i.test(error?.message ?? '')) return reject(new WebhookDeliveryError('blocked_destination', { retryable: false }));
      if (error?.code === 'ENOTFOUND') return reject(new WebhookDeliveryError('dns_not_found'));
      if ((typeof error?.code === 'string' && error.code.startsWith('ERR_TLS')) || /certificate/i.test(error?.message ?? '')) return reject(new WebhookDeliveryError('tls_failed'));
      return reject(new WebhookDeliveryError('connection_failed'));
    });
    request.end(body);
  });
}
