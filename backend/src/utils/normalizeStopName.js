function normalizeStopName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleUpperCase("en-US");
}

module.exports = normalizeStopName;
