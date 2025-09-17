// Test script to verify the edit functionality
const axios = require('axios');

async function testEditFunctionality() {
  try {
    console.log('🧪 Testing headcount edit functionality...');
    
    // Test the new edit endpoint directly
    console.log('1. Testing edit endpoint...');
    const editResponse = await axios.post(
      'http://localhost:3001/api/attendance/headcount/update-user/6/2025-09-14/7',
      { headcount: 25 },
      {
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'jwt=test-token'
        }
      }
    );
    
    console.log('✅ Edit endpoint test successful:', editResponse.status);
    console.log('Response data:', editResponse.data);
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.status, error.response?.data || error.message);
    
    // Let's also test if the endpoint exists by checking the route
    console.log('2. Testing if endpoint exists...');
    try {
      const testResponse = await axios.get('http://localhost:3001/api/attendance/headcount/6/2025-09-14');
      console.log('✅ Headcount endpoint accessible:', testResponse.status);
    } catch (testError) {
      console.error('❌ Headcount endpoint test failed:', testError.response?.status);
    }
  }
}

testEditFunctionality();
