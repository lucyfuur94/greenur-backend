const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const API_KEY = 'greenur_botanist_secret_734fd98a15e3b94c';

// Create WebSocket connection to local server
const socket = new WebSocket(`ws://localhost:8080?api_key=${API_KEY}`);

// Record start time for measuring connection duration
const startTime = Date.now();

// Connection opened
socket.on('open', function() {
  console.log(`[${(Date.now() - startTime)/1000}s] Connected to local server`);
  
  // Send configuration
  const config = {
    type: 'config',
    modelId: 'gemini-2.0-flash',
    modelType: 'gemini',
    audioSession: true,
    voice: 'en-IN-Chirp3-HD-Orus'
  };
  
  socket.send(JSON.stringify(config));
  console.log(`[${(Date.now() - startTime)/1000}s] Sent configuration`);
  
  // Send a text message after 2 seconds
  setTimeout(() => {
    const message = {
      type: 'chat_message',
      message: 'Tell me how to care for a rose plant'
    };
    
    socket.send(JSON.stringify(message));
    console.log(`[${(Date.now() - startTime)/1000}s] Sent message: ${message.message}`);
  }, 2000);
});

// Listen for messages
socket.on('message', function(data) {
  try {
    const message = JSON.parse(data);
    console.log(`[${(Date.now() - startTime)/1000}s] Received: ${message.type}`);
    
    if (message.type === 'transcript') {
      console.log(`Transcript: ${message.text}`);
    } else if (message.type === 'bot_message') {
      console.log(`Bot response: ${message.text.substring(0, 150)}${message.text.length > 150 ? '...' : ''}`);
    } else if (message.type === 'audio_message') {
      console.log(`Audio response received (${message.audio.length} bytes)`);
      
      // Save the audio to a file
      const audioBuffer = Buffer.from(message.audio, 'base64');
      fs.writeFileSync('response.mp3', audioBuffer);
      console.log(`Saved audio response to response.mp3`);
      
      // Test audio transcription by sending the audio back
      setTimeout(() => {
        console.log(`Testing audio transcription by sending audio back...`);
        const audio = message.audio;
        
        // Split the audio into chunks to simulate real-world conditions
        const chunkSize = 4000;
        const totalChunks = Math.ceil(audio.length / chunkSize);
        
        // Send the audio chunks with a delay
        for (let i = 0; i < totalChunks; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, audio.length);
          const chunk = audio.substring(start, end);
          
          setTimeout(() => {
            const audioMessage = {
              type: 'audio_data',
              audio: chunk,
              format: 'base64',
              mimeType: 'audio/mp3',
              isChunk: true,
              chunkNumber: i,
              isLastChunk: i === totalChunks - 1
            };
            
            socket.send(JSON.stringify(audioMessage));
            console.log(`[${(Date.now() - startTime)/1000}s] Sent audio chunk ${i+1}/${totalChunks}`);
          }, i * 100);
        }
      }, 2000);
    } else if (message.type === 'error') {
      console.error(`Error: ${message.error}`);
    }
  } catch (error) {
    console.log(`[${(Date.now() - startTime)/1000}s] Received non-JSON message:`, data);
  }
});

// Listen for errors
socket.on('error', function(error) {
  console.error(`[${(Date.now() - startTime)/1000}s] WebSocket error:`, error);
});

// Connection closed
socket.on('close', function(code, reason) {
  const duration = (Date.now() - startTime) / 1000;
  console.log(`Connection closed with code ${code}${reason ? ': ' + reason : ''}`);
  console.log(`Total connection duration: ${duration} seconds`);
});

// Keep the script running
console.log('Test started. Press Ctrl+C to exit.');
process.stdin.resume(); 