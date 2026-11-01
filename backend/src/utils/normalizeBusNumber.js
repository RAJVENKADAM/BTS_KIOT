function normalizeBusNumber(value) {
  if (value === null || value === undefined) return value;

  const normalized = String(value).trim().toUpperCase();
  return /^\d+$/.test(normalized)
    ? normalized.replace(/^0+(?=\d)/, "")
    : normalized;
}

module.exports = normalizeBusNumber;
