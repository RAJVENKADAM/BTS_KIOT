function parsePositiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const requestedPage =
    query.page === undefined ? 1 : parsePositiveInteger(query.page);
  const requestedLimit =
    query.limit === undefined ? defaultLimit : parsePositiveInteger(query.limit);

  if (
    requestedPage === null ||
    requestedLimit === null
  ) {
    return { error: "Page and limit must be positive integers." };
  }

  const search = typeof query.search === "string" ? query.search.trim() : "";
  if (search.length > 100) {
    return { error: "Search must be 100 characters or fewer." };
  }

  const limit = Math.min(requestedLimit, maxLimit);
  const skip = (requestedPage - 1) * limit;
  if (!Number.isSafeInteger(skip) || skip > 1_000_000) {
    return { error: "Page is too large." };
  }
  return {
    page: requestedPage,
    limit,
    skip,
    search,
  };
}

function parseCursor(query = {}) {
  const hasCursor = query.cursor !== undefined;
  const cursorMode = query.cursorMode === "true" || hasCursor;
  if (
    (query.cursorMode !== undefined && query.cursorMode !== "true") ||
    (cursorMode && query.page !== undefined)
  ) {
    return { error: "Cursor pagination cannot be combined with page pagination." };
  }
  if (
    hasCursor &&
    (typeof query.cursor !== "string" ||
      !/^[a-f\d]{24}$/i.test(query.cursor))
  ) {
    return { error: "Cursor must be a valid user identifier." };
  }
  return {
    cursorMode,
    cursor: hasCursor ? query.cursor : null,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { escapeRegExp, parseCursor, parsePagination };
