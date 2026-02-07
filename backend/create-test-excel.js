const fs = require('fs');

// Create a simple test Excel file
const testExcelContent = `Plan A,Plan B,Plan C
Stop 1,Stop A1,Stop B1
Stop 2,Stop A2,Stop B2
Stop 3,Stop A3,Stop B3`;

fs.writeFileSync('test-routes.xlsx', testExcelContent);

console.log('Created test Excel file: test-routes.xlsx');
console.log('You can now test the upload endpoint with this file.');