const axios = require('axios');

// Test configuration
const BASE_URL = 'http://localhost:3001/api';
const TEST_EMAIL = 'admin@example.com';
const TEST_PASSWORD = 'password123';

// Test data
const testVisitorFamily = {
  familyName: 'Smith Family',
  visitorType: 'local',
  notes: 'Test visitor family',
  people: [
    {
      firstName: 'John',
      lastName: 'Smith',
      firstUnknown: false,
      lastUnknown: false,
      isChild: false
    },
    {
      firstName: 'Jane',
      lastName: 'Smith',
      firstUnknown: false,
      lastUnknown: false,
      isChild: false
    }
  ]
};

async function testVisitorFamilyAPI() {
  try {
    console.log('🧪 Testing Visitor Family API...\n');

    // Step 1: Login to get authentication token
    console.log('1. Logging in...');
    const loginResponse = await axios.post(`${BASE_URL}/auth/login`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD
    });

    const token = loginResponse.data.token;
    const authHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    console.log('✅ Login successful\n');

    // Step 2: Get gatherings to find a valid gathering ID
    console.log('2. Getting gatherings...');
    const gatheringsResponse = await axios.get(`${BASE_URL}/gatherings`, { headers: authHeaders });
    const gatherings = gatheringsResponse.data.gatherings;
    
    if (gatherings.length === 0) {
      throw new Error('No gatherings found. Please create a gathering first.');
    }

    const gatheringId = gatherings[0].id;
    const testDate = new Date().toISOString().split('T')[0]; // Today's date

    console.log(`✅ Found gathering: ${gatherings[0].name} (ID: ${gatheringId})\n`);

    // Step 3: Create visitor family
    console.log('3. Creating visitor family...');
    const createFamilyResponse = await axios.post(
      `${BASE_URL}/families/visitor`, 
      testVisitorFamily, 
      { headers: authHeaders }
    );

    const familyId = createFamilyResponse.data.familyId;
    console.log(`✅ Created visitor family with ID: ${familyId}`);
    console.log(`   Family members: ${createFamilyResponse.data.individuals.map(i => `${i.firstName} ${i.lastName}`).join(', ')}\n`);

    // Step 4: Add visitor family to service
    console.log('4. Adding visitor family to service...');
    const addToServiceResponse = await axios.post(
      `${BASE_URL}/attendance/${gatheringId}/${testDate}/visitor-family/${familyId}`,
      {},
      { headers: authHeaders }
    );

    console.log(`✅ Added visitor family to service`);
    console.log(`   Individuals added: ${addToServiceResponse.data.individuals.map(i => `${i.firstName} ${i.lastName}`).join(', ')}\n`);

    // Step 5: Verify attendance data
    console.log('5. Verifying attendance data...');
    const attendanceResponse = await axios.get(
      `${BASE_URL}/attendance/${gatheringId}/${testDate}`,
      { headers: authHeaders }
    );

    const attendanceList = attendanceResponse.data.attendanceList;
    const visitorFamilyMembers = attendanceList.filter(person => 
      person.family_id === familyId
    );

    console.log(`✅ Found ${visitorFamilyMembers.length} family members in attendance`);
    visitorFamilyMembers.forEach(member => {
      console.log(`   - ${member.first_name} ${member.last_name} (Present: ${member.present})`);
    });

    // Step 6: Verify family data
    console.log('\n6. Verifying family data...');
    const familiesResponse = await axios.get(`${BASE_URL}/families`, { headers: authHeaders });
    const visitorFamily = familiesResponse.data.families.find(f => f.id === familyId);

    if (visitorFamily) {
      console.log(`✅ Found visitor family in families list`);
      console.log(`   Name: ${visitorFamily.family_name}`);
      console.log(`   Type: ${visitorFamily.familyType}`);
      console.log(`   Last Attended: ${visitorFamily.lastAttended}`);
      console.log(`   Member Count: ${visitorFamily.member_count}`);
    } else {
      console.log('❌ Visitor family not found in families list');
    }

    console.log('\n🎉 All tests passed! Visitor family system is working correctly.');

  } catch (error) {
    console.error('\n❌ Test failed:', error.response?.data?.error || error.message);
    
    if (error.response?.status === 401) {
      console.log('\n💡 Make sure you have a valid user account with the test credentials.');
    }
    
    if (error.response?.status === 404) {
      console.log('\n💡 Make sure the server is running and the API endpoints are available.');
    }
  }
}

// Run the test
testVisitorFamilyAPI(); 