require('dotenv').config();
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

async function testBrevoWithCurl() {
  console.log('🌐 Testing Brevo API with curl...\n');
  
  const apiKey = process.env.BREVO_API_KEY;
  
  // Test 1: Check if we can reach Brevo's API endpoint
  console.log('1. Testing connectivity to Brevo API...');
  try {
    const { stdout, stderr } = await execAsync('curl -s -o /dev/null -w "%{http_code}" https://api.brevo.com/v3/account');
    console.log(`   HTTP Status Code: ${stdout}`);
    if (stdout === '200') {
      console.log('   ✅ Can reach Brevo API endpoint');
    } else {
      console.log('   ❌ Cannot reach Brevo API endpoint');
    }
  } catch (error) {
    console.log('   ❌ Network error:', error.message);
  }
  console.log('');
  
  // Test 2: Test with API key
  console.log('2. Testing Brevo API with API key...');
  try {
    const curlCommand = `curl -s -H "api-key: ${apiKey}" https://api.brevo.com/v3/account`;
    const { stdout, stderr } = await execAsync(curlCommand);
    
    if (stdout.includes('"email"')) {
      console.log('   ✅ API key is valid!');
      console.log('   Response preview:', stdout.substring(0, 100) + '...');
    } else if (stdout.includes('"code"')) {
      console.log('   ❌ API key error:');
      console.log('   Response:', stdout);
    } else {
      console.log('   ❌ Unexpected response:');
      console.log('   Response:', stdout);
    }
  } catch (error) {
    console.log('   ❌ Curl error:', error.message);
  }
  console.log('');
  
  // Test 3: Check if it's a DNS issue
  console.log('3. Testing DNS resolution...');
  try {
    const { stdout, stderr } = await execAsync('nslookup api.brevo.com');
    console.log('   DNS resolution result:');
    console.log(stdout);
  } catch (error) {
    console.log('   ❌ DNS lookup failed:', error.message);
  }
}

testBrevoWithCurl().catch(console.error); 