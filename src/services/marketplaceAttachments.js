export function attachmentDto(row) {
  return {
    id: row.id,
    filename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    scanStatus: row.scan_status,
    uploadedAt: row.created_at,
  };
}

// Live attachments grouped by offer_id or message_id; removed files are kept only as audit rows.
export async function loadAttachments(db, column, ids) {
  if (!ids.length) return new Map();
  const result = await db.query(
    `SELECT * FROM marketplace_attachments WHERE ${column === 'message' ? 'message_id' : 'offer_id'} = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY created_at`,
    [ids],
  );
  const grouped = new Map();
  for (const row of result.rows) {
    const key = column === 'message' ? row.message_id : row.offer_id;
    grouped.set(key, [...(grouped.get(key) ?? []), attachmentDto(row)]);
  }
  return grouped;
}
