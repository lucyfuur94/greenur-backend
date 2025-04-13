/**
 * Test WebSocket connection with FLAC file
 * 
 * This script tests sending a FLAC audio file to the local WebSocket server.
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Configuration
const PORT = 8080; // Use 8080 instead of 3000 to match .env configuration
const API_KEY = 'greenur_botanist_secret_734fd98a15e3b94c';
const WS_URL = `ws://localhost:${PORT}?api_key=${API_KEY}`;
const TEST_AUDIO_FILE = path.resolve(__dirname, 'test_files/test_voice.flac');

// Add option to specify audio format from command line
const audioFormat = process.argv[2] || 'flac';
console.log(`Using audio format: ${audioFormat}`);

// Connect to WebSocket
console.log(`Connecting to WebSocket server at ${WS_URL}...`);
const socket = new WebSocket(WS_URL);

// Connection opened
socket.addEventListener('open', (event) => {
  console.log('Connected to WebSocket server');
  
  // Send configuration message
  const configMessage = {
    type: 'config',
    modelId: 'gpt-4o-mini', // Choose model
    modelType: 'openai',
    audioSession: true, // We want audio responses
    voice: 'en-IN-Chirp3-HD-Orus' // Choose voice
  };
  
  socket.send(JSON.stringify(configMessage));
  console.log('Sent configuration message:', configMessage);
  
  // After a brief delay, send the audio file
  setTimeout(() => {
    sendAudioFile();
  }, 1000);
});

// Listen for messages
socket.addEventListener('message', (event) => {
  try {
    const data = JSON.parse(event.data);
    console.log('Received message:', data);
    
    // Log specific message types in a more focused way
    switch (data.type) {
      case 'connected':
        console.log(`Connection established with ID: ${data.connectionId}`);
        break;
      case 'config_acknowledged':
        console.log('Configuration acknowledged, using model:', data.model);
        console.log('Voice configuration:', data.voice);
        break;
      case 'transcript':
        console.log('Transcript:', data.text);
        break;
      case 'bot_message':
        console.log('Bot response:', data.text);
        break;
      case 'audio_message':
        const audioSize = (data.audio.length * 3) / 4; // Estimate size from base64
        console.log(`Received audio response (approx. ${Math.round(audioSize / 1024)}KB)`);
        
        // Optionally save the audio response
        const outputPath = path.resolve(__dirname, 'test_response.mp3');
        fs.writeFileSync(
          outputPath, 
          Buffer.from(data.audio, 'base64')
        );
        console.log(`Audio response saved to ${outputPath}`);
        break;
      case 'error':
        console.error('Server error:', data.error);
        break;
    }
  } catch (error) {
    console.error('Error parsing message:', error);
    console.log('Raw message:', event.data);
  }
});

// Connection closed
socket.addEventListener('close', (event) => {
  console.log(`Connection closed. Code: ${event.code}, Reason: ${event.reason}`);
});

// Connection error
socket.addEventListener('error', (error) => {
  console.error('WebSocket error:', error);
});

// Function to send the entire audio file at once (no chunking)
function sendAudioFile() {
  console.log(`Reading audio file from ${TEST_AUDIO_FILE}...`);
  
  // Check if file exists
  if (!fs.existsSync(TEST_AUDIO_FILE)) {
    console.error(`ERROR: File not found: ${TEST_AUDIO_FILE}`);
    socket.close();
    process.exit(1);
  }
  
  // Read the entire file
  const fileBuffer = fs.readFileSync(TEST_AUDIO_FILE);
  console.log(`File size: ${fileBuffer.length} bytes`);
  
  // Convert to base64
  const base64Audio = fileBuffer.toString('base64');
  
  // Determine MIME type based on command line argument
  let mimeType = 'audio/flac';
  if (audioFormat === 'webm-as-mp3') {
    // Simulate the problem scenario: WebM file labeled as MP3
    mimeType = 'audio/mp3';
    console.log('Testing scenario: WebM audio incorrectly labeled as MP3');
  } else if (audioFormat === 'webm') {
    mimeType = 'audio/webm';
  } else if (audioFormat === 'mp3') {
    mimeType = 'audio/mp3';
  }
  
  // Send as a single message with the correct MIME type
  const message = {
    type: 'audio_data',
    audio: base64Audio,
    format: 'base64',
    mimeType: mimeType
  };
  
  // Send the message
  socket.send(JSON.stringify(message));
  console.log(`Sent complete audio file as ${mimeType} (${fileBuffer.length} bytes)`);
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('Process interrupted, closing connection');
  socket.close();
  process.exit(0);
}); 