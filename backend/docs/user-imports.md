# User import behavior

The primary user-import endpoint is `POST /api/superadmin/import-users-excel`.
The Add Users screen uploads the `.xlsx` file directly instead of expanding the
workbook into a client-side JSON array. `POST /api/superadmin/import-users`
remains available for existing JSON clients, and
`POST /api/organize/upload-excel-users` remains the legacy import path.

There is no application row-count ceiling for user imports. The primary
workbook route accepts files up to its configured 25 MiB Multer limit; the
legacy workbook route retains its 10 MiB limit, and the JSON route retains its
25 MiB request-body limit. These byte limits bound request buffering; they do
not guarantee that a compressed workbook will fit within the same amount of
memory after parsing.

SheetJS currently reads the complete workbook into memory. After parsing, user
rows are iterated lazily and persisted in sequential batches of 100. Import
admission allows at most two active requests per backend process; additional
requests receive HTTP 503 with `Retry-After: 5`. Password hashing uses the
shared bounded import hasher (four active operations and a 64-operation
waiting queue). No import creates one promise or database write per workbook
row in advance.

Each persisted batch commits independently; the workbook is not one
transaction. When MongoDB identifies individual failed operations, successful
operations remain committed, failed rows are reported, and later batches
continue. Earlier successful batches are not rolled back. A database error
whose affected rows cannot be identified stops subsequent processing and is
marked `partial` with `outcomeUnknown: true`; its upload record is retained so
the result is not mistaken for a confirmed failure. The response and saved
upload summary include aggregate counts and row-level safe failure reasons.
Retry the primary import using the same email identifiers (its writes are
email-keyed upserts), and verify an ambiguous outcome before relying on its
counts.

The legacy path also processes rows in bounded batches and reports partial
results. It performs an existing-user lookup before creating/updating users;
it does not use a workbook-wide transaction. It deactivates users absent from
the workbook only after all import work succeeds. Database-level uniqueness
and retry behavior should still be verified against a non-production MongoDB
instance.

The row iterator reduces additional row-array retention, but it does not make
XLSX parsing streaming. Workbook expansion, per-import duplicate tracking, and
row-level error reporting still consume memory proportional to workbook data.
Capacity should therefore be evaluated with representative workbooks and the
target runtime's memory limit; no tested capacity implies unlimited imports.
