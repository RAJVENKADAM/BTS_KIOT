const fs = require('fs');
const FormData = require('form-data');
const axios = require('axios');

async function testUpload() {
  try {
    // First login to get token
    const loginResponse = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'rajvenkadam@gmail.com',
      password: 'Raj@210'
    });
    
    const token = loginResponse.data.token;
    console.log('Login successful, token received');
    
    // Create form data for upload
    const formData = new FormData();
    formData.append('busNo', 'BUS001');
    formData.append('file', fs.createReadStream('test-routes.xlsx'));
    
    // Upload bus routes
    const uploadResponse = await axios.post(
      'http://localhost:5000/api/bus/upload-bus-routes',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          ...formData.getHeaders()
        }
      }
    );
    
    console.log('Upload successful!');
    console.log(uploadResponse.data);
    
  } catch (error) {
    console.error('Error:', error.response ? error.response.data : error.message);
  }
}

testUpload();