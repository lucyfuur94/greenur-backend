const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { OpenAI } = require('openai');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { SpeechClient } = require('@google-cloud/speech');
const mediasoup = require('mediasoup'); // WebRTC SFU for Node.js
const fs = require('fs');
const path = require('path');

// Import fetch for Node.js versions that don't have it built-in
let fetch;
if (!globalThis.fetch) {
  fetch = require('node-fetch');
} else {
  fetch = globalThis.fetch;
}

// Set up Google credentials - either use file path or JSON content from env var
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  try {
    // Parse the JSON credentials from environment variable
    const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    
    // Write credentials to a temporary file
    const tempCredentialsPath = path.join(__dirname, 'google-credentials-temp.json');
    fs.writeFileSync(tempCredentialsPath, JSON.stringify(credentials, null, 2));
    
    // Set the path for Google client libraries to use
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tempCredentialsPath;
    
    console.log('Using Google credentials from environment variable JSON');
  } catch (error) {
    console.error('Error setting up Google credentials from JSON:', error);
    process.exit(1);
  }
} else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('No Google credentials configured. Set either GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CREDENTIALS_JSON environment variable');
  process.exit(1);
}

// Initialize Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Gemini API if key is provided
const useGemini = !!process.env.GEMINI_API_KEY;
let geminiApiUrl = null;
if (useGemini) {
  console.log('Gemini API key detected, will use Gemini for text generation');
  geminiApiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent';
}

// Initialize Google Speech-to-Text client
const speechClient = new SpeechClient();

// Initialize Google Text-to-Speech client
const ttsClient = new TextToSpeechClient();

// Set up logging
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logger = {
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args),
  info: (...args) => LOG_LEVEL !== 'error' && console.log(...args),
  debug: (...args) => LOG_LEVEL === 'debug' && console.log('[DEBUG]', ...args)
};

// Store active connections
const activeConnections = new Map();

// Store mediasoup objects
let mediasoupWorker = null;
let mediasoupRouter = null;

// System prompt for the botanist assistant
const BOTANIST_SYSTEM_PROMPT = `
You are Greenur's plant expert botanist assistant. Your role is to help users with their plant-related questions.

You should:
- Always answer in brief, concise responses for a natural conversation
- Provide accurate, helpful information about plants, gardening, plant care, and related topics
- Answer questions about plant identification, care requirements, troubleshooting plant problems, etc.
- Be friendly, supportive, and encouraging to gardeners of all experience levels
- Use scientific names when appropriate, but explain concepts in accessible language
- If you're unsure about something, acknowledge the limits of your knowledge
- ONLY answer questions related to plants, gardening, botany, and closely related topics
- For non-plant related questions, politely explain that you're a plant specialist and can only help with plant-related topics

DO NOT:
- Provide advice on non-plant topics
- Engage in discussions about politics, controversial topics, or anything unrelated to plants
- Generate harmful content of any kind
- Provide lengthy responses - keep them short and natural for a voice conversation
`;

// Mediasoup settings
const mediasoupSettings = {
  worker: {
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
    logLevel: 'warn',
    logTags: [
      'info',
      'ice',
      'dtls',
      'rtp',
      'srtp',
      'rtcp'
    ],
  },
  router: {
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      }
    ],
  },
  webRtcTransport: {
    listenIps: [
      { ip: '0.0.0.0', announcedIp: null } // Replace with your public IP in production
    ],
    initialAvailableOutgoingBitrate: 1000000,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    maxIncomingBitrate: 1500000,
  },
};

// Initialize mediasoup
async function initializeMediasoup() {
  try {
    // Create a mediasoup Worker
    mediasoupWorker = await mediasoup.createWorker(mediasoupSettings.worker);
    
    console.log('Mediasoup worker created');
    
    // Create a mediasoup Router
    mediasoupRouter = await mediasoupWorker.createRouter(mediasoupSettings.router);
    
    console.log('Mediasoup router created');
    
    // Handle worker close event
    mediasoupWorker.on('died', () => {
      console.error('Mediasoup worker died, exiting');
      process.exit(1);
    });
  } catch (error) {
    console.error('Failed to initialize mediasoup:', error);
    process.exit(1);
  }
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  const connectionId = uuidv4();
  console.log(`New connection established: ${connectionId}`);
  
  // Store connection and its associated data
  const connectionData = {
    ws,
    mediasoupTransport: null,
    mediasoupProducer: null,
    mediasoupConsumer: null,
    conversationContext: [],
    modelId: null,
  };
  
  activeConnections.set(connectionId, connectionData);
  
  // Handle WebSocket messages
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch(data.type) {
        case 'getRouterRtpCapabilities':
          await handleGetRouterRtpCapabilities(connectionId);
          break;
        case 'createWebRtcTransport':
          await handleCreateWebRtcTransport(connectionId, data.direction);
          break;
        case 'connectWebRtcTransport':
          await handleConnectWebRtcTransport(connectionId, data.dtlsParameters);
          break;
        case 'produce':
          await handleProduce(connectionId, data.kind, data.rtpParameters);
          break;
        case 'consume':
          await handleConsume(connectionId, data.producerId, data.rtpCapabilities);
          break;
        case 'config':
          // Handle configuration updates
          if (data.modelId) {
            connectionData.modelId = data.modelId;
          }
          break;
        default:
          console.warn(`Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendError(ws, 'Failed to process message');
    }
  });
  
  // Handle WebSocket disconnection
  ws.on('close', () => {
    console.log(`Connection closed: ${connectionId}`);
    cleanupConnection(connectionId);
    activeConnections.delete(connectionId);
  });
  
  // Handle WebSocket errors
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${connectionId}:`, error);
    cleanupConnection(connectionId);
    activeConnections.delete(connectionId);
  });
});

/**
 * Handle getting router RTP capabilities
 */
async function handleGetRouterRtpCapabilities(connectionId) {
  const connectionData = activeConnections.get(connectionId);
  if (!connectionData) return;
  
  try {
    // Send router RTP capabilities to client
    sendToClient(connectionData.ws, {
      type: 'routerRtpCapabilities',
      rtpCapabilities: mediasoupRouter.rtpCapabilities,
    });
  } catch (error) {
    console.error('Error handling get router RTP capabilities:', error);
    sendError(connectionData.ws, 'Failed to process router capabilities request');
  }
}

/**
 * Handle creating WebRTC transport
 */
async function handleCreateWebRtcTransport(connectionId, direction) {
  const connectionData = activeConnections.get(connectionId);
  if (!connectionData) return;
  
  try {
    // Create a WebRTC transport
    const transport = await mediasoupRouter.createWebRtcTransport(
      mediasoupSettings.webRtcTransport
    );
    
    // Store transport based on direction
    if (direction === 'send') {
      connectionData.sendTransport = transport;
    } else if (direction === 'receive') {
      connectionData.receiveTransport = transport;
    }
    
    // Send transport parameters to client
    sendToClient(connectionData.ws, {
      type: 'webRtcTransportCreated',
      direction: direction,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    });
  } catch (error) {
    console.error('Error creating WebRTC transport:', error);
    sendError(connectionData.ws, 'Failed to create WebRTC transport');
  }
}

/**
 * Handle connecting WebRTC transport
 */
async function handleConnectWebRtcTransport(connectionId, dtlsParameters) {
  const connectionData = activeConnections.get(connectionId);
  if (!connectionData) return;
  
  try {
    // Connect the transport
    if (connectionData.sendTransport) {
      await connectionData.sendTransport.connect({ dtlsParameters });
    } else if (connectionData.receiveTransport) {
      await connectionData.receiveTransport.connect({ dtlsParameters });
    }
    
    // Send success response
    sendToClient(connectionData.ws, {
      type: 'webRtcTransportConnected',
    });
  } catch (error) {
    console.error('Error connecting WebRTC transport:', error);
    sendError(connectionData.ws, 'Failed to connect WebRTC transport');
  }
}

/**
 * Handle producing audio
 */
async function handleProduce(connectionId, kind, rtpParameters) {
  const connectionData = activeConnections.get(connectionId);
  if (!connectionData || !connectionData.sendTransport) return;
  
  try {
    // Create a producer
    const producer = await connectionData.sendTransport.produce({
      kind,
      rtpParameters,
    });
    
    connectionData.producer = producer;
    
    // Set up audio processing pipeline
    setupAudioProcessingPipeline(connectionId, producer);
    
    // Send producer ID to client
    sendToClient(connectionData.ws, {
      type: 'producerCreated',
      id: producer.id,
    });
  } catch (error) {
    console.error('Error producing:', error);
    sendError(connectionData.ws, 'Failed to produce media');
  }
}

/**
 * Handle consuming audio
 */
async function handleConsume(connectionId, producerId, rtpCapabilities) {
  const connectionData = activeConnections.get(connectionId);
  if (!connectionData || !connectionData.receiveTransport) return;
  
  try {
    // Check if consumer can consume the producer
    if (!mediasoupRouter.canConsume({
      producerId,
      rtpCapabilities,
    })) {
      throw new Error('Cannot consume this producer');
    }
    
    // Create a consumer
    const consumer = await connectionData.receiveTransport.consume({
      producerId,
      rtpCapabilities,
      paused: true, // Start paused
    });
    
    connectionData.consumer = consumer;
    
    // Send consumer parameters to client
    sendToClient(connectionData.ws, {
      type: 'consumerCreated',
      params: {
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      },
    });
    
    // Resume the consumer
    await consumer.resume();
  } catch (error) {
    console.error('Error consuming:', error);
    sendError(connectionData.ws, 'Failed to consume media');
  }
}

/**
 * Set up the audio processing pipeline
 */
async function setupAudioProcessingPipeline(connectionId, producer) {
  const connectionData = activeConnections.get(connectionId);
  if (!connectionData) return;
  
  // Create a recognizeStream from Google Speech-to-Text
  const recognizeStream = speechClient
    .streamingRecognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 48000,
        languageCode: 'en-US',
        model: 'default',
        useEnhanced: true,
        enableAutomaticPunctuation: true,
        enableSpokenPunctuation: true,
      },
      interimResults: false,
    })
    .on('error', (error) => {
      console.error('Speech recognition error:', error);
    })
    .on('data', async (data) => {
      if (data.results[0] && data.results[0].alternatives[0]) {
        const transcript = data.results[0].alternatives[0].transcript;
        console.log(`Transcribed: "${transcript}"`);
        
        // Process user message with OpenAI
        await processUserMessage(connectionId, transcript);
      }
    });
  
  // TODO: Connect producer to Google Speech-to-Text
  // This requires implementation of an RTP stream processor
  // For now, we'll simulate reception with a test message after 3 seconds
  setTimeout(() => {
    // Simulate a user message
    processUserMessage(connectionId, "Can you tell me how to care for a peace lily?");
  }, 3000);
}

/**
 * Process a user message using OpenAI and respond
 */
async function processUserMessage(connectionId, userMessage) {
  const connectionData = activeConnections.get(connectionId);
  if (!connectionData) return;
  
  try {
    // Add user message to conversation context
    connectionData.conversationContext.push({
      role: 'user',
      content: userMessage,
    });
    
    // Keep conversation context limited to last 10 messages
    if (connectionData.conversationContext.length > 10) {
      connectionData.conversationContext = connectionData.conversationContext.slice(-10);
    }
    
    let assistantResponse = '';

    // Use Gemini if configured, otherwise use OpenAI
    if (useGemini) {
      assistantResponse = await getGeminiResponse(connectionData.conversationContext, BOTANIST_SYSTEM_PROMPT);
    } else {
      // Prepare messages for OpenAI LLM
      const messages = [
        { role: 'system', content: BOTANIST_SYSTEM_PROMPT },
        ...connectionData.conversationContext,
      ];
      
      // Use the model passed from the client, don't default to anything
      const model = connectionData.modelId;
      
      // Get response from OpenAI with the specified model
      const response = await openai.chat.completions.create({
        model: model,
        messages,
        temperature: 0.3,
        max_tokens: 200,
        stream: true,
      });
      
      // Process streamed response
      for await (const chunk of response) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          assistantResponse += content;
        }
      }
    }
    
    // Add assistant response to conversation context
    connectionData.conversationContext.push({
      role: 'assistant',
      content: assistantResponse,
    });
    
    console.log(`Assistant response: "${assistantResponse}"`);
    
    // Send the response text to the client
    sendToClient(connectionData.ws, {
      type: 'bot-message',
      id: uuidv4(),
      text: assistantResponse,
    });
    
    // Convert text to speech
    await textToSpeech(connectionId, assistantResponse);
  } catch (error) {
    console.error('Error processing user message:', error);
    sendError(connectionData.ws, 'Failed to process your message');
  }
}

/**
 * Get response from Gemini API
 */
async function getGeminiResponse(conversationContext, systemPrompt) {
  try {
    // Create content parts with system prompt
    const parts = [
      { text: systemPrompt },
    ];
    
    // Add conversation history
    for (const message of conversationContext) {
      parts.push({ text: `${message.role}: ${message.content}` });
    }
    
    // Prepare request for Gemini API
    const requestBody = {
      contents: [
        {
          parts,
        }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 200,
      }
    };
    
    // Call Gemini API
    const response = await fetch(`${geminiApiUrl}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    
    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // Extract text from response
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
      return data.candidates[0].content.parts[0].text;
    }
    
    throw new Error('Unable to parse Gemini API response');
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    return 'I apologize, but I encountered an issue processing your request. Please try again.';
  }
}

/**
 * Convert text to speech and send to client
 */
async function textToSpeech(connectionId, text) {
  const connectionData = activeConnections.get(connectionId);
  if (!connectionData) return;
  
  try {
    // Request text-to-speech from Google
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', ssmlGender: 'FEMALE', name: 'en-US-Neural2-F' },
      audioConfig: { audioEncoding: 'MP3' },
    });
    
    // TODO: Implement sending audio back to client
    // This would require creating a producer for the audio output
    
    // For now, we'll simulate with a console message
    console.log('TTS audio generated and would be sent to client');
  } catch (error) {
    console.error('Error in text-to-speech:', error);
  }
}

/**
 * Send data to client
 */
function sendToClient(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * Send error to client
 */
function sendError(ws, errorMessage) {
  sendToClient(ws, {
    type: 'error',
    error: errorMessage,
  });
}

/**
 * Clean up connection resources
 */
function cleanupConnection(connectionId) {
  const connectionData = activeConnections.get(connectionId);
  if (!connectionData) return;
  
  // Close producer if exists
  if (connectionData.producer) {
    connectionData.producer.close();
  }
  
  // Close consumer if exists
  if (connectionData.consumer) {
    connectionData.consumer.close();
  }
  
  // Close send transport if exists
  if (connectionData.sendTransport) {
    connectionData.sendTransport.close();
  }
  
  // Close receive transport if exists
  if (connectionData.receiveTransport) {
    connectionData.receiveTransport.close();
  }
}

// Basic route for health check
app.get('/', (req, res) => {
  res.send('Botanist AI Voice Service is running');
});

// Initialize mediasoup and start server
(async () => {
  try {
    await initializeMediasoup();
    
    // Start the server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
})(); 