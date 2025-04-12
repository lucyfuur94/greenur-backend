/**
 * Greenur Botanist AI Voice Service - Client Example
 * This example demonstrates how to connect to the Botanist AI service using WebSockets
 * and send/receive messages in both text and audio formats.
 */

// Configuration
const apiBaseUrl = 'https://greenur-backend.onrender.com'; // Replace with your actual server URL
const apiSecretKey = 'YOUR_API_KEY'; // Replace with your actual API key
const useAudio = true; // Set to true to enable audio input/output

// Model Configuration
const modelOptions = [
  { id: 'gemini-2.0-flash-lite', type: 'gemini', name: 'Gemini 2.0 Flash Lite' },
  { id: 'gemini-2.0-flash', type: 'gemini', name: 'Gemini 2.0 Flash' },
  { id: 'gpt-4o-mini', type: 'openai', name: 'GPT-4o Mini' }
];

// Default model
const defaultModel = modelOptions[1]; // Gemini 2.0 Flash

// WebSocket URL with authentication
const wsUrl = `${apiBaseUrl.replace('https://', 'wss://').replace('http://', 'ws://')}?api_key=${apiSecretKey}`;

// Connection state
let socket;
let connectionId;
let isConnected = false;
let isAssistantSpeaking = false;
let activeAudioPlayer = null;
let availableVoices = [];
let selectedVoice = 'en-US-Neural2-F'; // Default voice

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
    
    // Fetch available voices
    fetchAvailableVoices();
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

// Fetch available voices
async function fetchAvailableVoices() {
  try {
    const response = await fetch(`${apiBaseUrl}/api/list-voices?api_key=${apiSecretKey}`);
    if (!response.ok) throw new Error('Failed to fetch voices');
    
    const voices = await response.json();
    
    // Filter for Neural voices in English
    availableVoices = voices.filter(voice => 
      voice.name.startsWith('en-') && 
      (voice.name.includes('Neural') || voice.name.includes('Studio'))
    );
    
    console.log('Available voices:', availableVoices.map(v => v.name));
  } catch (error) {
    console.error('Error fetching voices:', error);
  }
}

// Preview a voice
async function previewVoice(voiceName) {
  try {
    const sampleText = "Hello, I'm your botanist assistant. How can I help with your plants today?";
    
    const response = await fetch(
      `${apiBaseUrl}/api/preview-voice?api_key=${apiSecretKey}&voiceName=${voiceName}&text=${encodeURIComponent(sampleText)}`
    );
    
    if (!response.ok) throw new Error('Failed to preview voice');
    
    const data = await response.json();
    
    // Play the preview
    const audio = new Audio(`data:audio/mp3;base64,${data.audio}`);
    audio.play();
    
    console.log('Previewing voice:', voiceName);
  } catch (error) {
    console.error('Error previewing voice:', error);
  }
}

// Send configuration to the server
function sendConfig() {
  if (!isConnected) return;
  
  const config = {
    type: 'config',
    modelId: defaultModel.id,
    modelType: defaultModel.type,
    audioSession: useAudio,
    voice: selectedVoice
  };
  
  socket.send(JSON.stringify(config));
  console.log('Configuration sent:', config);
}

// Send a text message to the Botanist AI
function sendTextMessage(message) {
  if (!isConnected) {
    console.error('Not connected to the server');
    return;
  }
  
  // If assistant is currently speaking, interrupt it first
  if (isAssistantSpeaking) {
    interruptAssistant();
  }
  
  const payload = {
    type: 'chat_message',
    message: message
  };
  
  socket.send(JSON.stringify(payload));
  console.log('Sent text message:', message);
}

// Interrupt the assistant if it's speaking
function interruptAssistant() {
  if (!isConnected || !isAssistantSpeaking) return;
  
  // Stop audio playback
  if (activeAudioPlayer) {
    activeAudioPlayer.pause();
    activeAudioPlayer = null;
  }
  
  // Send interrupt signal
  const interruptPayload = {
    type: 'interrupt'
  };
  
  socket.send(JSON.stringify(interruptPayload));
  console.log('Sent interrupt signal');
  
  isAssistantSpeaking = false;
}

// Send audio data to the Botanist AI
function sendAudioData(audioBlob) {
  if (!isConnected || !useAudio) {
    console.error('Not connected to the server or audio is disabled');
    return;
  }
  
  // If assistant is currently speaking, interrupt it first
  if (isAssistantSpeaking) {
    interruptAssistant();
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
      
    case 'config_acknowledged':
      console.log('Configuration acknowledged:', data);
      break;
      
    case 'transcript':
      // Display the transcribed text
      console.log('Transcript:', data.text);
      // Example: updateChatUI(data.text, 'user');
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
        
        activeAudioPlayer = new Audio(audioUrl);
        
        // Set up event listeners for the audio player
        activeAudioPlayer.addEventListener('play', () => {
          isAssistantSpeaking = true;
          console.log('Assistant started speaking (voice:', data.voice || 'default', ')');
        });
        
        activeAudioPlayer.addEventListener('ended', () => {
          isAssistantSpeaking = false;
          activeAudioPlayer = null;
          console.log('Assistant finished speaking');
          
          // Clean up
          URL.revokeObjectURL(audioUrl);
        });
        
        activeAudioPlayer.addEventListener('pause', () => {
          if (isAssistantSpeaking) {
            isAssistantSpeaking = false;
            console.log('Audio playback paused');
          }
        });
        
        // Start playing
        activeAudioPlayer.play();
      }
      break;
      
    case 'interrupt_acknowledged':
      console.log('Interrupt acknowledged - assistant will stop responding');
      break;
      
    case 'error':
      console.error('Server error:', data.error);
      break;
      
    default:
      console.log('Unknown message type:', data.type);
  }
}

// Record audio from the microphone with voice activity detection
async function startRecording() {
  if (!navigator.mediaDevices || !useAudio) {
    console.error('Media devices not available or audio is disabled');
    return;
  }
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaRecorder = new MediaRecorder(stream);
    const audioChunks = [];
    
    console.log('Recording started...');
    
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
      
      console.log('Recording stopped, sending audio data');
    });
    
    // Start recording
    mediaRecorder.start();
    
    // Set up voice activity detection to auto-stop when silence is detected
    setupVoiceActivityDetection(stream, mediaRecorder);
    
    // Safety timeout - stop recording after 10 seconds max
    setTimeout(() => {
      if (mediaRecorder.state === 'recording') {
        console.log('Maximum recording time reached (10s)');
        mediaRecorder.stop();
      }
    }, 10000);
    
  } catch (error) {
    console.error('Error accessing microphone:', error);
  }
}

// Detect when user stops speaking to auto-stop recording
function setupVoiceActivityDetection(stream, mediaRecorder) {
  const audioContext = new AudioContext();
  const audioSource = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioSource.connect(analyser);
  
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  
  let silenceStart = performance.now();
  let isSpeaking = false;
  
  // Check audio levels regularly
  const checkAudioInterval = setInterval(() => {
    if (mediaRecorder.state !== 'recording') {
      clearInterval(checkAudioInterval);
      return;
    }
    
    analyser.getByteFrequencyData(dataArray);
    
    // Calculate average audio level
    const average = dataArray.reduce((sum, value) => sum + value, 0) / bufferLength;
    
    if (average > 10) { // Threshold for considering as speech
      isSpeaking = true;
      silenceStart = performance.now();
    } else if (isSpeaking && performance.now() - silenceStart > 1500) {
      // 1.5 seconds of silence - stop recording
      console.log('Silence detected, stopping recording');
      clearInterval(checkAudioInterval);
      mediaRecorder.stop();
    }
  }, 100);
}

// Change the voice
function changeVoice(voiceName) {
  selectedVoice = voiceName;
  
  // Update configuration if already connected
  if (isConnected) {
    socket.send(JSON.stringify({
      type: 'config',
      voice: voiceName
    }));
    
    console.log('Voice changed to:', voiceName);
  }
}

// Change the model
function changeModel(modelId, modelType) {
  // Update configuration if already connected
  if (isConnected) {
    socket.send(JSON.stringify({
      type: 'config',
      modelId: modelId,
      modelType: modelType
    }));
    
    console.log('Model changed to:', modelId, '(type:', modelType, ')');
  }
}

// Usage example:
// 1. Connect to the server
connect();

// 2. After connection, you can:
// - Start voice recording: startRecording()
// - Send a text message: sendTextMessage("What's the best way to care for a peace lily?")
// - Interrupt the assistant: interruptAssistant()
// - Change the voice: changeVoice("en-GB-Neural2-F")
// - Change the model: changeModel("gemini-2.0-flash", "gemini")
// - Preview a voice: previewVoice("en-US-Neural2-M")

// Example of using REST API instead of WebSockets
async function sendRESTMessage(message, options = {}) {
  const apiUrl = `${apiBaseUrl}/api/chat`;
  
  const modelId = options.modelId || defaultModel.id;
  const modelType = options.modelType || defaultModel.type;
  const voice = options.voice || selectedVoice;
  const includeAudio = options.includeAudio || false;
  
  try {
    const url = new URL(apiUrl);
    if (includeAudio) {
      url.searchParams.append('include_audio', 'true');
    }
    
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiSecretKey
      },
      body: JSON.stringify({
        message: message,
        modelId: modelId,
        modelType: modelType,
        voice: voice
      }),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }
    
    const data = await response.json();
    console.log('REST API response:', data.message);
    
    // Play audio if included
    if (data.audio) {
      const audio = new Audio(`data:audio/mp3;base64,${data.audio}`);
      audio.play();
    }
    
    return data;
  } catch (error) {
    console.error('Error using REST API:', error);
    return null;
  }
} 