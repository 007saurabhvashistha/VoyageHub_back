export function parseWith(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (result.success) return { data: result.data };
  return { error: result.error.issues[0]?.message ?? 'Check the submitted values and try again.' };
}
