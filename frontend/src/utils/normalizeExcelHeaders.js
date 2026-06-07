export function normalizeExcelHeaders(obj) {
  if (!obj || typeof obj !== 'object') return {};

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const nk = k == null ? '' : String(k).trim().toLowerCase();
    out[nk] = v;
  }
  return out;
}

