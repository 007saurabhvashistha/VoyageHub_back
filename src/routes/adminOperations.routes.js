import { config } from '../config/index.js';
import { operationRunKinds } from '../config/referenceData.js';

function runDto(row) {
  if (!row) return null;
  return { id: row.id, kind: row.kind, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, details: row.details, recordedBy: row.recorded_by };
}

export function registerOperationsAdminRoutes(router, pool) {
  router.get('/operations', async (_request, response, next) => {
    try {
      const [latest, recent, webhooks] = await Promise.all([
        pool.query(
          `SELECT DISTINCT ON (kind, status) * FROM operation_runs
           ORDER BY kind, status, finished_at DESC`,
        ),
        pool.query('SELECT * FROM operation_runs ORDER BY finished_at DESC LIMIT 20'),
        pool.query(
          `SELECT
             (SELECT COUNT(*) FROM webhook_endpoints WHERE status = 'active') AS active_endpoints,
             (SELECT COUNT(*) FROM webhook_endpoints WHERE status = 'disabled' AND disabled_reason = 'failing') AS failing_endpoints,
             (SELECT COUNT(*) FROM webhook_deliveries WHERE status IN ('pending', 'retrying', 'processing')) AS queued_deliveries,
             (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'dead_letter') AS dead_letter_deliveries`,
        ),
      ]);
      const now = Date.now();
      const checks = operationRunKinds.filter((kind) => kind.monitored).map(({ value, label }) => {
        const lastSuccess = latest.rows.find((row) => row.kind === value && row.status === 'succeeded');
        const lastFailure = latest.rows.find((row) => row.kind === value && row.status === 'failed');
        const maxAgeMs = value === 'database_backup' ? config.operations.backupMaxAgeHours * 3600000 : config.operations.restoreDrillMaxAgeDays * 86400000;
        const overdue = !lastSuccess || now - new Date(lastSuccess.finished_at).getTime() > maxAgeMs;
        const failingSinceSuccess = Boolean(lastFailure && (!lastSuccess || new Date(lastFailure.finished_at) > new Date(lastSuccess.finished_at)));
        return { kind: value, label, maxAgeHours: maxAgeMs / 3600000, overdue, failingSinceSuccess, lastSuccess: runDto(lastSuccess), lastFailure: runDto(lastFailure) };
      });
      const counts = webhooks.rows[0];
      return response.json({
        checks,
        recentRuns: recent.rows.map(runDto),
        webhooks: {
          activeEndpoints: Number(counts.active_endpoints),
          failingEndpoints: Number(counts.failing_endpoints),
          queuedDeliveries: Number(counts.queued_deliveries),
          deadLetterDeliveries: Number(counts.dead_letter_deliveries),
        },
      });
    } catch (error) {
      return next(error);
    }
  });
}
