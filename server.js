const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const cors = require('cors');
const path = require('path');
const XLSX = require('xlsx');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory data storage (Vercel serverless - this will reset on each cold start)
// For production, you'd want to use a database like MongoDB or PostgreSQL
let eventData = {
  eventName: '',
  eventLocation: { lat: null, lng: null },
  radius: 50,
  accessCode: '',
  isEventActive: false,
  attendees: [],
  deviceFingerprints: [],
  pollQuestion: '',
  pollOptions: [],
  isPollActive: false,
  votes: {},
  approvedMembers: []
};

// Configure multer for memory storage (since Vercel doesn't have persistent file system)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const ADMIN_PASSWORD = 'FratAdmin2024';

// Parse Excel file from buffer
function parseExcelFromBuffer(buffer) {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);
    
    const members = [];
    
    data.forEach(row => {
      // Get phone number - normalize it to 10 digits only
      let phone = row['Cell Phone'] || row['Phone'] || row['cell phone'] || row['phone'] || '';
      
      // Remove all non-digit characters
      phone = phone.toString().replace(/\D/g, '');
      
      // Get name
      const firstName = row['First'] || row['first'] || row['First Name'] || '';
      const lastName = row['Last'] || row['last'] || row['Last Name'] || '';
      const fullName = `${firstName} ${lastName}`.trim();
      
      // Get roll number
      const rollNumber = row['Roll Number'] || row['roll number'] || '';
      
      if (phone && phone.length === 10) {
        members.push({
          name: fullName,
          phone: phone,
          rollNumber: rollNumber,
          firstName: firstName,
          lastName: lastName
        });
      }
    });
    
    return members;
  } catch (error) {
    throw new Error('Failed to parse Excel file: ' + error.message);
  }
}

// Parse CSV from buffer
function parseCSVFromBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const members = [];
    const { Readable } = require('stream');
    
    const stream = Readable.from(buffer.toString());
    
    stream
      .pipe(csv())
      .on('data', (row) => {
        const name = row.name || row.Name || row.NAME || 
                     row.fullname || row['Full Name'] || row['full name'];
        const email = row.email || row.Email || row.EMAIL || '';
        const memberId = row.id || row.ID || row.memberid || row['Member ID'] || '';
        
        // Get phone number and normalize
        let phone = row.phone || row.Phone || row.PHONE || row['Cell Phone'] || '';
        phone = phone.toString().replace(/\D/g, ''); // Remove non-digits
        
        if (name || (phone && phone.length === 10)) {
          members.push({
            name: name ? name.trim() : '',
            email: email.trim(),
            memberId: memberId.trim(),
            phone: phone
          });
        }
      })
      .on('end', () => {
        resolve(members);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}

// API Routes

// Upload CSV roster
app.post('/api/upload-roster', upload.single('roster'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    
    let members;
    const fileName = req.file.originalname.toLowerCase();
    
    // Determine file type and parse accordingly
    if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
      members = parseExcelFromBuffer(req.file.buffer);
    } else if (fileName.endsWith('.csv')) {
      members = await parseCSVFromBuffer(req.file.buffer);
    } else {
      return res.status(400).json({ success: false, message: 'Invalid file type. Please upload .xlsx, .xls, or .csv file' });
    }
    
    eventData.approvedMembers = members;
    res.json({ 
      success: true, 
      message: `Loaded ${members.length} members`,
      members: members 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get approved members list
app.get('/api/members', (req, res) => {
  res.json({ members: eventData.approvedMembers });
});

// Admin: Start event
app.post('/api/admin/start-event', (req, res) => {
  const { eventName, eventLocation, radius, accessCode } = req.body;
  
  eventData.eventName = eventName;
  eventData.eventLocation = eventLocation;
  eventData.radius = radius;
  eventData.accessCode = accessCode;
  eventData.isEventActive = true;
  eventData.attendees = [];
  eventData.deviceFingerprints = [];
  
  res.json({ success: true, message: 'Event started' });
});

// Admin: End event
app.post('/api/admin/end-event', (req, res) => {
  eventData.isEventActive = false;
  res.json({ success: true, message: 'Event ended' });
});

// Admin: Start poll
app.post('/api/admin/start-poll', (req, res) => {
  const { pollQuestion, pollOptions } = req.body;
  
  eventData.pollQuestion = pollQuestion;
  eventData.pollOptions = pollOptions;
  eventData.isPollActive = true;
  eventData.votes = {};
  
  res.json({ success: true, message: 'Poll started' });
});

// Admin: End poll
app.post('/api/admin/end-poll', (req, res) => {
  eventData.isPollActive = false;
  res.json({ success: true, message: 'Poll ended' });
});

// Get event status
app.get('/api/event-status', (req, res) => {
  res.json({
    eventName: eventData.eventName,
    eventLocation: eventData.eventLocation,
    radius: eventData.radius,
    isEventActive: eventData.isEventActive,
    accessCode: eventData.accessCode,
    attendeeCount: eventData.attendees.length,
    pollQuestion: eventData.pollQuestion,
    pollOptions: eventData.pollOptions,
    isPollActive: eventData.isPollActive
  });
});

// Get attendees (admin only)
app.get('/api/attendees', (req, res) => {
  res.json({ attendees: eventData.attendees });
});

// Get vote results (admin only)
app.get('/api/votes', (req, res) => {
  const results = {};
  eventData.pollOptions.forEach(opt => {
    results[opt] = 0;
  });
  
  Object.values(eventData.votes).forEach(vote => {
    if (results.hasOwnProperty(vote)) {
      results[vote]++;
    }
  });
  
  res.json({ 
    results: results,
    totalVotes: Object.keys(eventData.votes).length 
  });
});

// Member: Check in
app.post('/api/checkin', (req, res) => {
  const { phone, fingerprint, location, distance } = req.body;
  
  if (!eventData.isEventActive) {
    return res.status(400).json({ success: false, message: 'No active event' });
  }
  
  // Normalize phone number (remove all non-digits)
  const normalizedPhone = phone.toString().replace(/\D/g, '');
  
  // Validate phone number format
  if (normalizedPhone.length !== 10) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid phone number. Please enter 10 digits.' 
    });
  }
  
  // Check if on roster (if roster exists)
  let memberInfo = null;
  if (eventData.approvedMembers.length > 0) {
    memberInfo = eventData.approvedMembers.find(
      member => member.phone === normalizedPhone
    );
    
    if (!memberInfo) {
      return res.status(403).json({ 
        success: false, 
        message: 'Phone number not found on roster' 
      });
    }
  } else {
    return res.status(400).json({ 
      success: false, 
      message: 'No roster uploaded. Please contact admin.' 
    });
  }
  
  // Check device fingerprint
  if (eventData.deviceFingerprints.includes(fingerprint)) {
    return res.status(400).json({ 
      success: false, 
      message: 'This device has already checked in' 
    });
  }
  
  // Check if phone already checked in
  if (eventData.attendees.some(a => a.phone === normalizedPhone)) {
    return res.status(400).json({ 
      success: false, 
      message: 'This phone number has already checked in' 
    });
  }
  
  // Check distance
  if (distance > eventData.radius) {
    return res.status(400).json({ 
      success: false, 
      message: `You are ${Math.round(distance)}m away. Must be within ${eventData.radius}m` 
    });
  }
  
  // Add attendee
  const attendee = {
    name: memberInfo.name,
    phone: normalizedPhone,
    checkInTime: new Date().toLocaleTimeString(),
    distance: Math.round(distance),
    fingerprint: fingerprint
  };
  
  eventData.attendees.push(attendee);
  eventData.deviceFingerprints.push(fingerprint);
  
  res.json({ 
    success: true, 
    message: 'Check-in successful',
    attendee: attendee 
  });
});

// Member: Vote
app.post('/api/vote', (req, res) => {
  const { fingerprint, option, distance } = req.body;
  
  if (!eventData.isPollActive) {
    return res.status(400).json({ success: false, message: 'No active poll' });
  }
  
  // Must be checked in
  const attendee = eventData.attendees.find(a => a.fingerprint === fingerprint);
  if (!attendee) {
    return res.status(403).json({ 
      success: false, 
      message: 'You must check in before voting' 
    });
  }
  
  // Check if already voted
  if (eventData.votes[fingerprint]) {
    return res.status(400).json({ 
      success: false, 
      message: 'You have already voted' 
    });
  }
  
  // Verify location again
  if (distance > eventData.radius) {
    return res.status(400).json({ 
      success: false, 
      message: `You must be within ${eventData.radius}m to vote` 
    });
  }
  
  // Record vote
  eventData.votes[fingerprint] = option;
  
  res.json({ success: true, message: 'Vote recorded' });
});

// Download attendance report
app.get('/api/download-attendance', (req, res) => {
  let csvContent = 'Name,Phone Number,Check-in Time,Distance (m)\n';
  
  eventData.attendees.forEach(attendee => {
    // Format phone number back to readable format
    const phone = attendee.phone;
    const formattedPhone = phone ? `(${phone.substr(0,3)}) ${phone.substr(3,3)}-${phone.substr(6,4)}` : '';
    csvContent += `${attendee.name},${formattedPhone},${attendee.checkInTime},${attendee.distance}\n`;
  });
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=attendance.csv');
  res.send(csvContent);
});

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server - Railway sets PORT automatically
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
