const axios = require('axios');

async function testPlanChange() {
  try {
    // Login first
    const loginResponse = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'rajvenkadam@gmail.com',
      password: 'Raj@210'
    });
    
    const token = loginResponse.data.token;
    console.log('Login successful');
    
    // Test changing plan
    const planResponse = await axios.put(
      'http://localhost:5000/api/bus/change-plan/4',
      { newPlan: 'Plan A' },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('Plan change response:', planResponse.data);
    
  } catch (error) {
    console.error('Error:', error.response ? error.response.data : error.message);
  }
}

testPlanChange();