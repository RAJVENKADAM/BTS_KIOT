const axios = require('axios');

async function testGetCurrentPlan() {
  try {
    // Login first
    const loginResponse = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'rajvenkadam@gmail.com',
      password: 'Raj@210'
    });
    
    const token = loginResponse.data.token;
    console.log('Login successful');
    
    // Test getting current plan
    const planResponse = await axios.get(
      'http://localhost:5000/api/bus/current-plan/4',
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    console.log('Current plan response:', planResponse.data);
    
  } catch (error) {
    console.error('Error:', error.response ? error.response.data : error.message);
  }
}

testGetCurrentPlan();