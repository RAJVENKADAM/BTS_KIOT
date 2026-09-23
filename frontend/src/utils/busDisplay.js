export const normalizeBusPreview = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return /^\d+$/.test(normalized) ? normalized : null;
};

export const getDisplayBusNumber = (valueOrItem) => {
  if (valueOrItem === null || valueOrItem === undefined) return "—";

  const preview =
    typeof valueOrItem === "string" || typeof valueOrItem === "number"
      ? valueOrItem
      : valueOrItem.previewNumber ??
        valueOrItem.preview_number ??
        valueOrItem.preview ??
        valueOrItem.busNo ??
        valueOrItem.bus_no ??
        valueOrItem.busNumber ??
        null;

  const normalizedPreview = normalizeBusPreview(preview);
  if (normalizedPreview) return normalizedPreview;

  const busNumber =
    typeof valueOrItem === "object"
      ? valueOrItem.busNo ?? valueOrItem.bus_no ?? valueOrItem.busNumber
      : null;
  return busNumber !== null && busNumber !== undefined && String(busNumber).trim()
    ? String(busNumber).trim()
    : "—";
};
