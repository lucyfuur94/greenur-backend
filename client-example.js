/**
 * Greenur Botanist AI Voice Service - Client Example
 * This example demonstrates how to connect to the Botanist AI service using WebSockets
 * and send/receive messages in both text and audio formats.
 */

// Configuration
const apiBaseUrl = 'https://your-render-app-name.onrender.com'; // Replace with your actual server URL
const apiSecretKey = 'YOUR_API_KEY'; // Replace with your actual API key
const useAudio = true; // Set to true to enable audio input/output
const preferredModel = 'gpt-4o'; // The language model to use

// WebSocket URL with authentication
const wsUrl = `${apiBaseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}?api_key=${apiSecretKey}`;

// Connection state
let socket;
let connectionId;
let isConnected = false;

// Connect to the WebSocket server
function connect() {
  console.log('Connecting to Botanist AI service...');
  
  socket = new WebSocket(wsUrl);
  
  // Connection opened
  socket.addEventListener('open', (event) => {
    console.log('Connected to Botanist AI service');
    isConnected = true;
    
    // Send configuration
    sendConfig();
  });
  
  // Listen for messages
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    console.log('Received:', data);
    
    handleServerMessage(data);
  });
  
  // Connection closed
  socket.addEventListener('close', (event) => {
    console.log('Disconnected from Botanist AI service');
    isConnected = false;
    
    // Attempt to reconnect after a delay
    setTimeout(() => {
      if (!isConnected) connect();
    }, 3000);
  });
  
  // Connection error
  socket.addEventListener('error', (error) => {
    console.error('WebSocket error:', error);
  });
}

// Send configuration to the server
function sendConfig() {
  if (!isConnected) return;
  
  const config = {
    type: 'config',
    modelId: preferredModel,
    audioSession: useAudio
  };
  
  socket.send(JSON.stringify(config));
}

// Send a text message to the Botanist AI
function sendTextMessage(message) {
  if (!isConnected) {
    console.error('Not connected to the server');
    return;
  }
  
  const payload = {
    type: 'chat_message',
    message: message
  };
  
  socket.send(JSON.stringify(payload));
  console.log('Sent text message:', message);
}

// Send audio data to the Botanist AI
function sendAudioData(audioBlob) {
  if (!isConnected || !useAudio) {
    console.error('Not connected to the server or audio is disabled');
    return;
  }
  
  // Convert audio blob to base64
  const reader = new FileReader();
  reader.readAsDataURL(audioBlob);
  reader.onloadend = function() {
    // Remove the data URL prefix (e.g., "data:audio/webm;base64,")
    const base64Data = reader.result.split(',')[1];
    
    const payload = {
      type: 'audio_data',
      audio: base64Data,
      format: 'base64'
    };
    
    socket.send(JSON.stringify(payload));
    console.log('Sent audio data:', audioBlob.size, 'bytes');
  };
}

// Handle messages received from the server
function handleServerMessage(data) {
  switch(data.type) {
    case 'connected':
      connectionId = data.connectionId;
      console.log('Connection established with ID:', connectionId);
      break;
      
    case 'bot_message':
      // Display the bot's text response
      console.log('Bot response:', data.text);
      // Example: updateChatUI(data.text, 'bot');
      break;
      
    case 'audio_message':
      if (useAudio) {
        // Convert the base64 audio to a blob and play it
        const audioData = atob(data.audio);
        const arrayBuffer = new ArrayBuffer(audioData.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        
        for (let i = 0; i < audioData.length; i++) {
          uint8Array[i] = audioData.charCodeAt(i);
        }
        
        const audioBlob = new Blob([arrayBuffer], { type: 'audio/mp3' });
        const audioUrl = URL.createObjectURL(audioBlob);
        
        const audio = new Audio(audioUrl);
        audio.play();
        
        console.log('Playing audio response');
      }
      break;
      
    case 'transcript':
      // Display the transcribed text
      console.log('Transcript:', data.text);
      // Example: updateChatUI(data.text, 'user');
      break;
      
    case 'error':
      console.error('Server error:', data.error);
      break;
      
    default:
      console.log('Unknown message type:', data.type);
  }
}

// Record audio from the microphone
async function startRecording() {
  if (!navigator.mediaDevices || !useAudio) {
    console.error('Media devices not available or audio is disabled');
    return;
  }
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaRecorder = new MediaRecorder(stream);
    const audioChunks = [];
    
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    });
    
    mediaRecorder.addEventListener('stop', () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      sendAudioData(audioBlob);
      
      // Stop all tracks
      stream.getTracks().forEach(track => track.stop());
    });
    
    // Start recording for 5 seconds
    mediaRecorder.start();
    console.log('Recording started...');
    
    setTimeout(() => {
      mediaRecorder.stop();
      console.log('Recording stopped');
    }, 5000);
    
  } catch (error) {
    console.error('Error accessing microphone:', error);
  }
}

// Usage example:
// 1. Connect to the server
connect();

// 2. Send a text message after connection is established
setTimeout(() => {
  sendTextMessage("What's the best way to care for a peace lily?");
}, 2000);

// 3. Start recording audio after a delay (for testing)
setTimeout(() => {
  startRecording();
}, 5000);

// Example of using REST API instead of WebSockets
async function sendRESTMessage(message) {
  const apiUrl = `${apiBaseUrl}/api/chat`;
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiSecretKey
      },
      body: JSON.stringify({
        message: message,
        modelId: preferredModel
      }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }
    
    const data = await response.json();
    console.log('REST API response:', data.message);
    
  } catch (error) {
    console.error('Error using REST API:', error);
  }
} 