import { Router } from 'express';
import { loadSession, requireCsrf, requireMfaForPlatformAdmin } from './auth.routes.js';

function fail(response, status, code, message) {
  return response.status(status).json({ error: { code, message } });
}

export function createNotificationRouter({ pool }) {
  const router = Router();
  router.use((request, response, next) => loadSession(pool, request, response, next));
  router.use(requireMfaForPlatformAdmin);

  router.get('/', async (request, response, next) => {
    const requestedLimit = Number(request.query.limit ?? 50);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 50;
    try {
      const result = await pool.query(
        `SELECT id, event_type, title, message, data, read_at, created_at
         FROM notifications WHERE organization_id = $1 AND event_type NOT IN ('email_verification', 'password_recovery')
         ORDER BY created_at DESC LIMIT $2`,
        [request.auth.organization_id, limit],
      );
      const unread = await pool.query("SELECT COUNT(*) AS count FROM notifications WHERE organization_id = $1 AND read_at IS NULL AND event_type NOT IN ('email_verification', 'password_recovery')", [request.auth.organization_id]);
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