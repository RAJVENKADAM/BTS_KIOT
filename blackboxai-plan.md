# blackboxai-plan

## Information Gathered
- Crash occurs during user Excel upload with expo-file-system: `copyAsync` fails because the DocumentPicker cache URI is not readable.
- `AddUsersScreen.js` currently does:
  - `FileSystem.copyAsync({ from: file.uri, to: stablePath })`
  - then uploads `stablePath` using `FileSystem.uploadAsync`.
- `MultiExcelUpload.js` uses `DocumentPicker.getDocumentAsync(..., copyToCacheDirectory: true)` but the file URI may still not be readable at the moment `copyAsync` runs.
- `excelManagementApi` exists, but current upload in `AddUsersScreen.js` posts to `/api/organize/upload-excel-users`.

## Plan (must implement)
1. Update `frontend/src/screens/Organize/AddUsersScreen.js`:
   - Wrap the `copyAsync` + `getInfoAsync` in a guarded try/catch.
   - Use `FileSystem.getInfoAsync(uri)` to check existence.
   - If copy fails ("isn't readable"), fall back to uploading from the original `file.uri`.
   - Improve error logs to include `uri` and `file.name`.
2. Keep the UI behavior intact (loading spinner, alerts).

## Dependent Files to be edited
- `frontend/src/screens/Organize/AddUsersScreen.js`

## Followup steps
- Run a device test: upload a valid .xlsx from device storage.
- Confirm both flows:
  - Multi upload (MultiExcelUpload → handleFileUpload)
  - Single upload (ExcelUpload → handleUpload if used elsewhere)


