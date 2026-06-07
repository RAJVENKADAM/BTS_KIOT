import XLSX from 'xlsx';

const EXCEL_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';


function guessSheetNames(workbook) {
  if (!workbook?.SheetNames?.length) return [];
  return workbook.SheetNames;
}

function normalizeHeader(header) {
  if (header === null || header === undefined) return '';
  return String(header).trim().toLowerCase();
}

function stripEmptyRows(rows) {
  // Keep rows that have at least one non-empty cell
  return rows.filter((r) => {
    if (!r) return false;
    return Object.values(r).some((v) => {
      if (v === null || v === undefined) return false;
      return String(v).trim() !== '';
    });
  });
}

function coerceDateYear(value) {
  // Requirement uses date_of_year.
  // We accept numbers like 1990 or strings like "1990".
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;

  // If it looks like a full date, try extracting year.
  const yearMatch = s.match(/(19|20)\\d{2}/);
  if (yearMatch) return parseInt(yearMatch[0], 10);

  const n = Number(s);
  if (Number.isFinite(n)) return n;
  return null;
}

async function readExcelFile(fileOrDocPickerAsset, options = {}) {
  const { encoding = 'base64' } = options;

  // Encoding option is kept for backward compatibility, but this implementation
  // only supports base64 pipeline.


  if (!fileOrDocPickerAsset) {
    throw new Error('No Excel file provided');
  }

  // DocumentPicker asset shape: { uri, name, type, ... }
  const uri = fileOrDocPickerAsset.uri || fileOrDocPickerAsset;
  const name = fileOrDocPickerAsset.name;

  if (!uri) throw new Error('Excel file uri missing');

  // Production-safe strategy:
  // - Use fetch(uri) to read file contents as base64 (no expo-file-system).
  // - XLSX can parse base64 directly.
  //
  // Note: On Android, DocumentPicker URIs are usually accessible via fetch.
  // If a device returns an unreadable scheme, this will throw clearly.
  if (encoding !== 'base64') {
    throw new Error('Only base64 encoding is supported by readExcelFile');
  }

  const resp = await fetch(uri);
  if (!resp.ok) {
    throw new Error(`Failed to read excel file from uri: ${uri} (status ${resp.status})`);
  }

  // Convert response to base64.
  // React Native lacks Buffer; implement minimal base64 conversion.
  const arrayBuffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }

  // btoa expects binary string.
  // Some RN runtimes may not provide btoa; attempt to polyfill via global.
  const b64 = global.btoa ? global.btoa(binary) : btoa(binary);

  const workbook = XLSX.read(b64, {
    type: 'base64',
  });

  return {
    workbook,
    sheetNames: guessSheetNames(workbook),
    fileName: name,
    sourceUri: uri,
  };
}


function convertSheetToJson(worksheet, options = {}) {
  const {
    // Provide mapping or exact expected headers.
    // If true, will normalize headers to lower-case keys.
    normalizeHeaders = true,
    // If true, converts using xlsx header row.
    // Default: xlsx.utils.sheet_to_json already uses header row.
    // We'll post-normalize.
    skipEmptyRows = true,
  } = options;

  const rows = XLSX.utils.sheet_to_json(worksheet, {
    defval: '',
  });

  if (!rows?.length) return [];

  if (!normalizeHeaders) {
    return skipEmptyRows ? stripEmptyRows(rows) : rows;
  }

  // Normalize keys to lower-case trimmed
  const normalized = rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row || {})) {
      const nk = normalizeHeader(k);
      // Keep original empty/undefined handling to v
      out[nk] = v;
    }
    return out;
  });

  return skipEmptyRows ? stripEmptyRows(normalized) : normalized;
}

function convertExcelToJson(workbookOrReadResult, options = {}) {
  const {
    // If specified, parse only this sheet name
    sheetName,
    // If true and sheetName is not provided, parse the first sheet
    useFirstSheetIfMissing = true,
    // For bus imports we may need all sheets
    includeAllSheets = false,
  } = options;

  const workbook = workbookOrReadResult?.workbook
    ? workbookOrReadResult.workbook
    : workbookOrReadResult;

  if (!workbook) throw new Error('Workbook missing for conversion');

  const sheetNames = workbook?.SheetNames || [];
  if (!sheetNames.length) return includeAllSheets ? {} : [];

  if (includeAllSheets) {
    const out = {};
    for (const sn of sheetNames) {
      const ws = workbook.Sheets[sn];
      out[sn] = convertSheetToJson(ws, options);
    }
    return out;
  }

  const target = sheetName || (useFirstSheetIfMissing ? sheetNames[0] : null);
  if (!target) return [];

  const worksheet = workbook.Sheets[target];
  if (!worksheet) return [];

  return convertSheetToJson(worksheet, options);
}

/**
 * Convert column-based Excel data to routesByPlan format.
 *
 * Expected Excel layout (single sheet):
 *   | Plan A          | Plan B      | Plan C          |
 *   | KIOT Campus     | KIOT Campus | KIOT Campus     |
 *   | Salem Bus Stand | Five Roads  | Market          |
 *   | Anna Nagar      | Market      | Town Hall       |
 *   | Junction        | Town Hall   | Railway Station |
 *   | Railway Station |             | College Road    |
 *
 * Each COLUMN HEADER = plan name
 * Each cell below header = stop name (row position = stop_order)
 * Empty cells are skipped (plan has fewer stops than others).
 *
 * Returns: { "Plan A": [{ stop_name, stop_order }, ...], "Plan B": [...], ... }
 */
function convertColumnsToPlans(rows) {
  if (!Array.isArray(rows) || !rows.length) return {};

  // Collect all unique column headers (plan names) from all rows
  const planNames = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      const trimmed = (key || '').trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        planNames.push(trimmed);
      }
    }
  }

  const routesByPlan = {};
  for (const plan of planNames) {
    const stops = [];
    let order = 1;
    for (const row of rows) {
      // Try exact match first, then case-insensitive
      let stopName = row[plan];
      if (stopName === undefined) {
        const lowerPlan = plan.toLowerCase();
        for (const [k, v] of Object.entries(row)) {
          if (k.toLowerCase() === lowerPlan) {
            stopName = v;
            break;
          }
        }
      }
      if (stopName !== undefined && stopName !== null && String(stopName).trim() !== '') {
        stops.push({
          stop_name: String(stopName).trim(),
          stop_order: order,
        });
        order += 1;
      }
    }
    if (stops.length > 0) {
      routesByPlan[plan] = stops;
    }
  }

  return routesByPlan;
}

export {
  readExcelFile,
  convertExcelToJson,
  convertColumnsToPlans,
  coerceDateYear,
  EXCEL_MIME,
};

