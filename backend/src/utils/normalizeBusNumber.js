function normalizeBusNumber(value) {
  if (value === null || value === undefined) return value;

  const normalized = String(value).trim().toUpperCase();
  return /^0[1-9]$/.test(normalized)
    ? normalized.slice(1)
    : normalized;
}

module.exports = normalizeBusNumber;
