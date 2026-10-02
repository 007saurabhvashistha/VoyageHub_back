import express from 'express';
import cookieParser from 'cookie-parser';
import { createAuthRouter } from './routes/auth.routes.js';
import { createMarketplaceRouter } from './routes/marketplace.routes.js';
import { createAdminRouter } from './routes/admin.routes.js';
import { createNotificationRouter } from './routes/notification.routes.js';

export function createApp({ pool = null, secureCookies = process.env.NODE_ENV === 'production', cookieName = process.env.SESSION_COOKIE_NAME ?? 'lead_exchange_session', emailDelivery = null, tokenEncryptionKey = null, mfaEncryptionKey = null } = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());
  app.locals.sessionCookieName = cookieName;

  app.get('/v1/health/live', (_request, response) => {
    response.status(200).json({
      status: 'ok',
      service: 'voyagehub-api',
    });
  });

  app.get('/v1/health/ready', async (_request, response) => {
    if (!pool) {
      return response.status(503).json({ status: 'not_ready', checks: { database: 'not_configured' } });
    }
    try {
      await pool.query('SELECT 1');
      return response.status(200).json({ status: 'ready', checks: { database: 'connected' } });
    } catch {
      return response.status(503).json({ status: 'not_ready', checks: { database: 'unavailable' } });
    }
  });

  app.use('/v1/auth', createAuthRouter({ pool, secureCookies, cookieName, emailDelivery, tokenEncryptionKey, mfaEncryptionKey }));
  app.use('/v1/marketplace', createMarketplaceRouter({ pool }));
  app.use('/v1/admin', createAdminRouter({ pool }));
  app.use('/v1/notifications', createNotificationRouter({ pool }));

  app.use((_request, response) => {
    response.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
      },
    });
  });

  app.use((error, _request, response, _next) => {
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
    }
    return response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
  });

  return app;
}