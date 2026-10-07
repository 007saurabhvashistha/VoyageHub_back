import { Router } from 'express';
import { z } from 'zod';
import { loadSession, requireActiveAccount, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';
import { parseWith } from '../utils/validation.js';

const preferencesSchema = z.object({
  in_app_enabled: z.boolean(),
  email_enabled: z.boolean(),
  email_frequency: z.enum(['instant', 'daily']),
});

function preferencesDto(row) {
  return {
    inAppEnabled: row?.in_app_enabled ?? true,
    emailEnabled: row?.email_enabled ?? true,
    emailFrequency: row?.email_frequency ?? 'instant',
    updatedAt: row?.updated_at ?? null,
  };
}

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function createNotificationRouter({ pool }) {
  const router = Router();
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);
  router.use((request, response, next) => requireActiveAccount(pool, request, response, next));

  router.get('/preferences', async (request, response, next) => {
    try {
      const result = await pool.query('SELECT * FROM user_notification_preferences WHERE user_id = $1', [request.auth.user_id]);
      return response.json({ preferences: preferencesDto(result.rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  router.put('/preferences', requireCsrf, async (request, response, next) => {
    const input = parseWith(preferencesSchema, request.body);
    if (input.error) return fail(response, 400, 'VALIDATION_ERROR', input.error);
    try {
      const { in_app_enabled: inApp, email_enabled: email, email_frequency: frequency } = input.data;
      const result = await pool.query(
        `INSERT INTO user_notification_preferences (user_id, in_app_enabled, email_enabled, email_frequency, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET in_app_enabled = EXCLUDED.in_app_enabled, email_enabled = EXCLUDED.email_enabled,
           email_frequency = EXCLUDED.email_frequency, updated_at = NOW() RETURNING *`,
        [request.auth.user_id, inApp, email, frequency],
      );
      return response.json({ preferences: preferencesDto(result.rows[0]) });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/', async (request, response, next) => {
    const requestedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 50;
    try {
      const result = await pool.query(
        `SELECT id, event_type, title, message, data, read_at, created_at
         FROM notifications WHERE organization_id = $1 AND event_type NOT IN ('email_verification', 'password_recovery')
           AND COALESCE((SELECT in_app_enabled FROM user_notification_preferences WHERE user_id = $3), TRUE)
         ORDER BY created_at DESC LIMIT $2`,
        [request.auth.organization_id, limit, request.auth.user_id],
      );
      const unread = await pool.query("SELECT COUNT(*) AS count FROM notifications WHERE organization_id = $1 AND read_at IS NULL AND event_type NOT IN ('email_verification', 'password_recovery') AND COALESCE((SELECT in_app_enabled FROM user_notification_preferences WHERE user_id = $2), TRUE)", [request.auth.organization_id, request.auth.user_id]);
      return response.json({ unreadCount: Number(unread.rows[0].count), notifications: result.rows.map((item) => ({ id: item.id, type: item.event_type, title: item.title, message: item.message, data: item.data, readAt: item.read_at, createdAt: item.created_at })) });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/read-all', requireCsrf, async (request, response, next) => {
    try {
      const result = await pool.query("UPDATE notifications SET read_at = NOW() WHERE organization_id = $1 AND read_at IS NULL AND event_type NOT IN ('email_verification', 'password_recovery')", [request.auth.organization_id]);
      return response.json({ updatedCount: result.rowCount });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/:notificationId/read', requireCsrf, async (request, response, next) => {
    try {
      const result = await pool.query(
        "UPDATE notifications SET read_at = NOW() WHERE id = $1 AND organization_id = $2 AND read_at IS NULL AND event_type NOT IN ('email_verification', 'password_recovery') RETURNING id",
        [request.params.notificationId, request.auth.organization_id],
      );
      if (!result.rowCount) return fail(response, 404, 'NOTIFICATION_NOT_FOUND', 'Unread notification was not found.');
      return response.status(204).end();
    } catch (error) {
      return next(error);
    }
  });

  return router;
}