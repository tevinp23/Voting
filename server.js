const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for CSV uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, 'roster.csv');
  }
});

const upload = multer({ storage: storage });

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// In-memory data storage (in production, use a real database)
let eventData = {
  eventName: '',
  eventLocation: { lat: null, lng: null },
  radius: 50,
  accessCode: '',
  isEventActive: false,
  attendees: [],
  deviceFingerprints: new Set(),
  pollQuestion: '',
  pollOptions: [],
  isPollActive: false,
  votes: {},
  approvedMembers: []
};

// Load roster from CSV
function loadRoster() {
  const rosterPath = path.join(__dirname, 'uploads', 'roster.csv');
  
  if (!fs.existsSync(rosterPath)) {
    return [];
  }

  const members = [];
  
  return new Promise((resolve, reject) => {
    fs.createReadStream(rosterPath)
      .pipe(csv())
      .on('data', (row) => {
        // Support different CSV formats
        const name = row.name || row.Name || row.NAME || 
                     row.fullname || row['Full Name'] || row['full name'];
        const email = row.email || row.Email || row.EMAIL || '';
        const memberId = row.id || row.ID || row.memberid || row['Member ID'] || '';
        
        if (name) {
          members.push({
            name: name.trim(),
            email: email.trim(),
            memberId: memberId.trim()
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
    const members = await loadRoster();
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
  eventData.deviceFingerprints = new Set();
  
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
  const { name, fingerprint, location, distance } = req.body;
  
  if (!eventData.isEventActive) {
    return res.status(400).json({ success: false, message: 'No active event' });
  }
  
  // Check if on roster (if roster exists)
  if (eventData.approvedMembers.length > 0) {
    const isApproved = eventData.approvedMembers.some(
      member => member.name.toLowerCase() === name.toLowerCase()
    );
    
    if (!isApproved) {
      return res.status(403).json({ 
        success: false, 
        message: 'You are not on the approved member roster' 
      });
    }
  }
  
  // Check device fingerprint
  if (eventData.deviceFingerprints.has(fingerprint)) {
    return res.status(400).json({ 
      success: false, 
      message: 'This device has already checked in' 
    });
  }
  
  // Check if name already checked in
  if (eventData.attendees.some(a => a.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ 
      success: false, 
      message: 'You have already checked in' 
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
    name: name,
    checkInTime: new Date().toLocaleTimeString(),
    distance: Math.round(distance),
    fingerprint: fingerprint
  };
  
  eventData.attendees.push(attendee);
  eventData.deviceFingerprints.add(fingerprint);
  
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
  let csvContent = 'Name,Check-in Time,Distance (m)\n';
  
  eventData.attendees.forEach(attendee => {
    csvContent += `${attendee.name},${attendee.checkInTime},${attendee.distance}\n`;
  });
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=attendance.csv');
  res.send(csvContent);
});

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
