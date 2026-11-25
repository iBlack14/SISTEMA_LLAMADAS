// Admin changes override account copies with the same template ID.
// Keep tombstones in the merge so deleted shared templates cannot reappear.
export function mergeTemplateCatalog(personal, shared) {
  const catalog = new Map(personal.map(row => [String(row.id), row]));
  const latest = new Map();
  for (const row of shared) {
    if (!latest.has(String(row.id))) latest.set(String(row.id), row);
  }
  for (const [id, row] of latest) {
    if (row.is_deleted === true || Number(row.is_deleted) === 1) catalog.delete(id);
    else catalog.set(id, { ...row, shared: true });
  }
  return [...catalog.values()];
}
