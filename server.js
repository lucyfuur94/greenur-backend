const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { OpenAI } = require('openai');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const { SpeechClient } = require('@google-cloud/speech');
const fs = require('fs');
const path = require('path');

// Load environment variables from .env file
require('dotenv').config();

// Debug: Log environment variables (excluding sensitive data)
console.log('=== ENVIRONMENT VARIABLES ===');
for (const key in process.env) {
  if (key === 'OPENAI_API_KEY' || key === 'GEMINI_API_KEY' || key === 'GOOGLE_CREDENTIALS_JSON' || key === 'API_SECRET_KEY') {
    console.log(`${key}: [Present but value hidden]`);
  } else {
    console.log(`${key}: ${process.env[key]}`);
  }
}
console.log('============================');

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
    console.log('Processing Google credentials from environment variable...');
    
    // The credentials might be base64 encoded, try to decode first
    let credentialsJson = process.env.GOOGLE_CREDENTIALS_JSON;
    try {
      // Check if the value starts with characters that suggest base64 encoding
      if (/^[a-zA-Z0-9+/=]+$/.test(credentialsJson)) {
        const decodedCredentials = Buffer.from(credentialsJson, 'base64').toString('utf8');
        // Check if the decoded value is valid JSON
        JSON.parse(decodedCredentials);
        credentialsJson = decodedCredentials;
        console.log('Successfully decoded base64 credentials');
      }
    } catch (decodeError) {
      console.log('Credentials do not appear to be base64 encoded, using as is');
    }
    
    // Use credentials directly without writing to a file
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON = credentialsJson;
    console.log('Using Google credentials directly from environment variable');
    
  } catch (error) {
    console.error('Error setting up Google credentials:', error);
    
    // Only exit in production
    if (process.env.NODE_ENV === 'production') {
    process.exit(1);
    } else {
      console.log('Development environment detected - operations requiring Google credentials may fail');
    }
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log(`Using existing credentials file at ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
} else {
  // Production error in normal cases
  console.error('No Google credentials configured. GOOGLE_CREDENTIALS_JSON environment variable is missing.');
  
  // Development fallback for testing purposes
  if (process.env.NODE_ENV !== 'production') {
    console.log('Development environment detected - operations requiring Google credentials may fail');
  } else {
    process.exit(1);
  }
}

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Create WebSocket server with noServer option
const wss = new WebSocket.Server({ 
  noServer: true,
  perMessageDeflate: false  // Disable compression for better stability
});

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

// Initialize Google Speech-to-Text client with options for credentials
const speechClientOptions = {};
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    speechClientOptions.credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    console.log('Successfully initialized Speech-to-Text client with credentials');
  } catch (parseError) {
    console.error('Error parsing credentials for Speech-to-Text client:', parseError);
  }
}
const speechClient = new SpeechClient(speechClientOptions);

// Initialize Google Text-to-Speech client with options for credentials
const ttsClientOptions = {};
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    ttsClientOptions.credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
    console.log('Successfully initialized Text-to-Speech client with credentials');
  } catch (parseError) {
    console.error('Error parsing credentials for Text-to-Speech client:', parseError);
  }
}
const ttsClient = new TextToSpeechClient(ttsClientOptions);

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

// Enable JSON parsing for HTTP endpoints
app.use(express.json());

// Authentication middleware for API endpoints
const authenticateRequest = (req, res, next) => {
  // Get API key from request headers or query parameters
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  console.log('Authenticating request:', req.path);
  console.log('API Key provided:', apiKey ? 'Yes' : 'No');

  // Check if API key is valid
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    console.log('Authentication failed: Invalid or missing API key');
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
  }

  console.log('Authentication successful');
  // API key is valid, proceed
  next();
};

// Define HTTP API endpoints
app.get('/', (req, res) => {
  res.send('Botanist AI Voice Service is running');
});

// API endpoint to check health (no auth required)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Botanist AI Voice Service is healthy' });
});

// Apply authentication to protected endpoints
app.post('/api/chat', authenticateRequest, async (req, res) => {
  try {
    const { message, sessionId, modelId, modelType, voice } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Create or get session
    let session = activeConnections.get(sessionId);
    if (!session) {
      const newSessionId = sessionId || uuidv4();
      session = {
        id: newSessionId,
        conversationContext: [],
        modelId: modelId || 'gpt-4o-mini',
        modelType: modelType || 'openai',
        voiceConfig: {
          languageCode: 'en-IN',
          ssmlGender: 'MALE',
          name: 'en-IN-Chirp3-HD-Orus'
        },
        isResponseInterrupted: false
      };
      activeConnections.set(newSessionId, session);
    } else {
      if (modelId) {
        session.modelId = modelId;
      }
      if (modelType) {
        session.modelType = modelType;
      }
    }
    
    // Handle voice configuration if provided
    if (voice) {
      if (typeof voice === 'object') {
        session.voiceConfig = {
          languageCode: voice.languageCode || 'en-IN',
          ssmlGender: voice.ssmlGender || 'MALE',
          name: voice.name || 'en-IN-Chirp3-HD-Orus'
        };
      } else if (typeof voice === 'string') {
        // Extract language code from voice name (e.g., en-IN from en-IN-Chirp3-HD-Orus)
        const langCodeMatch = voice.match(/^([a-z]{2}-[A-Z]{2})/);
        
        session.voiceConfig = {
          languageCode: langCodeMatch ? langCodeMatch[1] : 'en-IN',
          ssmlGender: voice.includes('Orus') ? 'MALE' : 'FEMALE',
          name: voice
        };
      }
    }
    
    // Process message
    const response = await processUserMessage(session, message);
    
    // Generate audio response if requested
    let audioResponse = null;
    if (req.query.include_audio === 'true') {
      audioResponse = await textToSpeech(response, session.voiceConfig);
    }
    
    // Prepare response
    const responseData = {
      sessionId: session.id,
      message: response,
      model: {
        id: session.modelId,
        type: session.modelType
      }
    };
    
    // Include audio if generated
    if (audioResponse) {
      responseData.audio = audioResponse.toString('base64');
      responseData.audioFormat = 'mp3';
      responseData.voice = session.voiceConfig.name;
    }
    
    // Return response
    res.json(responseData);
  } catch (error) {
    console.error('Error processing chat message:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
});

// WebSocket authentication function
const authenticateWebSocket = (request) => {
  // Extract API key from URL query parameter
  const url = new URL(request.url, `http://${request.headers.host}`);
  const apiKey = url.searchParams.get('api_key');
  
  // Check if API key is valid
  if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
    return false;
  }
  
  return true;
};

// Keep track of sockets that are being upgraded to prevent duplicate handling
const upgradingSocketsMap = new Map();

// WebSocket server upgrade with authentication
server.on('upgrade', (request, socket, head) => {
  const socketId = `${socket.remoteAddress}:${socket.remotePort}`;
  
  // Check if this socket is already being upgraded
  if (upgradingSocketsMap.has(socketId)) {
    logger.debug(`Ignoring duplicate upgrade request for socket ${socketId}`);
    return;
  }
  
  // Mark this socket as being upgraded
  upgradingSocketsMap.set(socketId, true);
  
  // Remove socket from map when it closes
  socket.on('close', () => {
    upgradingSocketsMap.delete(socketId);
  });
  
  // Authenticate the WebSocket connection
  if (!authenticateWebSocket(request)) {
    logger.info('WebSocket authentication failed');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    upgradingSocketsMap.delete(socketId);
    return;
  }
  
  // If authentication passes, upgrade the connection to WebSocket
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
    upgradingSocketsMap.delete(socketId);
  });
});

// WebSocket event handlers
wss.on('connection', (ws) => {
  const connectionId = uuidv4();
  logger.info(`New WebSocket connection established: ${connectionId}`);
  
  // Store connection data
  const connectionData = {
    id: connectionId,
    ws,
    conversationContext: [],
    modelId: 'gpt-4o-mini', // Default model
    modelType: 'openai', // Default model type
    audioSession: false, // Whether this session is using audio
    voiceConfig: {
      languageCode: 'en-IN',
      ssmlGender: 'MALE',
      name: 'en-IN-Chirp3-HD-Orus'
    }, // Default voice configuration
    isResponseInterrupted: false, // Track if response was interrupted
    audioChunks: [], // Store audio chunks
    lastChunkTime: Date.now() // Track when the last chunk was received
  };
  
  activeConnections.set(connectionId, connectionData);
  
  // Send connection confirmation
  sendToClient(ws, {
    type: 'connected',
    connectionId
  });
  
  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      logger.debug(`Received message from ${connectionId}:`, data.type);
      
      switch (data.type) {
        case 'config':
          // Handle configuration updates
          if (data.modelId) {
            connectionData.modelId = data.modelId;
          }
          if (data.modelType) {
            connectionData.modelType = data.modelType;
          }
          if (typeof data.audioSession === 'boolean') {
            connectionData.audioSession = data.audioSession;
          }
          // Add voice configuration handling
          if (data.voice) {
            // If a complete voice config object is provided
            if (typeof data.voice === 'object') {
              connectionData.voiceConfig = {
                languageCode: data.voice.languageCode || 'en-IN',
                ssmlGender: data.voice.ssmlGender || 'MALE',
                name: data.voice.name || 'en-IN-Chirp3-HD-Orus'
              };
              
              // Log the updated voice configuration
              logger.info(`Updated voice config from object: ${JSON.stringify(connectionData.voiceConfig)}`);
            } 
            // If just a voice name is provided
            else if (typeof data.voice === 'string') {
              connectionData.voiceConfig.name = data.voice;
              
              // Extract language code from voice name (e.g., en-IN from en-IN-Chirp3-HD-Orus)
              const langCodeMatch = data.voice.match(/^([a-z]{2}-[A-Z]{2})/);
              if (langCodeMatch) {
                connectionData.voiceConfig.languageCode = langCodeMatch[1];
                logger.info(`Updated voice language code to ${connectionData.voiceConfig.languageCode} from voice name ${data.voice}`);
              }
            }
          }
          
          // Reset interruption flag
          connectionData.isResponseInterrupted = false;
          
          sendToClient(ws, { 
            type: 'config_acknowledged',
            voice: connectionData.voiceConfig,
            model: {
              id: connectionData.modelId,
              type: connectionData.modelType
            }
          });
          break;
          
        case 'chat_message':
          // Process text message from client
          if (!data.message) {
            sendError(ws, 'Message is required');
            break;
          }
          
          // Reset interruption flag when new message is received
          connectionData.isResponseInterrupted = false;
          
          logger.info(`Processing chat message from ${connectionId}: "${data.message}"`);
          const response = await processUserMessage(connectionData, data.message);
          
          // Only send response if not interrupted during processing
          if (!connectionData.isResponseInterrupted) {
            // Send response as text
            sendToClient(ws, {
              type: 'bot_message',
              id: uuidv4(),
              text: response
            });
            
            // Convert to speech if audio session
            if (connectionData.audioSession) {
              const audioBuffer = await textToSpeech(response, connectionData.voiceConfig);
              if (audioBuffer && !connectionData.isResponseInterrupted) {
                sendToClient(ws, {
                  type: 'audio_message',
                  id: uuidv4(),
                  audio: audioBuffer.toString('base64'),
                  format: 'mp3',
                  voice: connectionData.voiceConfig.name // Include voice info in response
                });
              }
            }
          }
          break;
          
        case 'audio_data':
          // Process audio data from client
          if (!data.audio) {
            sendError(ws, 'Audio data is required');
            break;
          }
          
          // Reset interruption flag when new audio is received
          connectionData.isResponseInterrupted = false;
          
          // Process audio data (binary, base64, etc.)
          if (data.format === 'base64') {
            // Check if this is chunked audio
            if (data.isChunk) {
              logger.info(`Received audio chunk ${data.chunkNumber} from ${connectionId}`);
              
              // Handle the first chunk of a new audio stream
              if (data.chunkNumber === 0 || data.chunkNumber === 1) {
                // Clear previous chunks if this is the start of a new utterance
                connectionData.audioChunks = [];
                connectionData.audioBatchMimeType = data.mimeType || 'audio/mp3';
              }
              
              // Store this chunk
              connectionData.audioChunks.push(data.audio);
              connectionData.lastChunkTime = Date.now();
              
              // For FLAC files, we need the complete file before processing
              const isFlacAudio = (data.mimeType && data.mimeType.toLowerCase().includes('flac'));
              
              // If this appears to be the final chunk or we have enough chunks (and not FLAC), process the audio
              const isLastChunk = data.isLastChunk === true;
              const haveEnoughData = connectionData.audioChunks.length >= 10;
              
              if (isLastChunk || (haveEnoughData && !isFlacAudio)) {
                // Combine all chunks
                const combinedAudio = connectionData.audioChunks.join('');
                const audioBuffer = Buffer.from(combinedAudio, 'base64');
                
                // Process the complete audio
                await processAudioData(connectionData, audioBuffer, connectionData.audioBatchMimeType);
                
                // Clear the chunks
                connectionData.audioChunks = [];
              } else if (isFlacAudio && isLastChunk) {
                // For FLAC files, only process when we have the complete file
                logger.info(`Processing complete FLAC file from ${connectionId}`);
                const combinedAudio = connectionData.audioChunks.join('');
                const audioBuffer = Buffer.from(combinedAudio, 'base64');
                
                // Process the complete FLAC audio
                await processAudioData(connectionData, audioBuffer, connectionData.audioBatchMimeType);
                
                // Clear the chunks
                connectionData.audioChunks = [];
              } else {
                // If it's not the last chunk and we don't have enough data yet, just wait for more
                logger.debug(`Waiting for more audio chunks from ${connectionId} (have ${connectionData.audioChunks.length})`);
              }
            } else {
              // This is a complete audio sample (not chunked)
              const audioBuffer = Buffer.from(data.audio, 'base64');
              await processAudioData(connectionData, audioBuffer, data.mimeType || 'audio/mp3');
            }
          } else {
            sendError(ws, 'Unsupported audio format');
          }
          break;
          
        case 'interrupt':
          // Handle user interruption
          logger.info(`User interrupted assistant response for session ${connectionId}`);
          
          // Set flag to prevent sending further responses from in-flight requests
          connectionData.isResponseInterrupted = true;
          
          // Acknowledge the interruption
          sendToClient(ws, {
            type: 'interrupt_acknowledged'
          });
          break;
          
        default:
          logger.warn(`Unknown message type: ${data.type}`);
          sendError(ws, 'Unknown message type');
      }
    } catch (error) {
      logger.error('Error handling WebSocket message:', error);
      sendError(ws, 'Failed to process message');
    }
  });
  
  // Handle WebSocket disconnection
  ws.on('close', () => {
    logger.info(`WebSocket connection closed: ${connectionId}`);
    activeConnections.delete(connectionId);
  });
  
  // Handle WebSocket errors
  ws.on('error', (error) => {
    logger.error(`WebSocket error for ${connectionId}:`, error);
    activeConnections.delete(connectionId);
  });
});

/**
 * Process a user message using AI (OpenAI or Gemini) and return response
 */
async function processUserMessage(session, userMessage) {
  try {
    // Add user message to conversation context
    session.conversationContext.push({
      role: 'user',
      content: userMessage,
    });
    
    // Keep conversation context limited to last 10 messages
    if (session.conversationContext.length > 10) {
      session.conversationContext = session.conversationContext.slice(-10);
    }
    
    let assistantResponse = '';

    // Check if the session was interrupted during processing
    if (session.isResponseInterrupted) {
      logger.info('Message processing interrupted - skipping LLM call');
      return '';
    }

    // Use Gemini if configured as model type, otherwise use OpenAI
    if (session.modelType === 'gemini') {
      assistantResponse = await getGeminiResponse(session.conversationContext, BOTANIST_SYSTEM_PROMPT, session.modelId);
    } else {
      // Prepare messages for OpenAI LLM
      const messages = [
        { role: 'system', content: BOTANIST_SYSTEM_PROMPT },
        ...session.conversationContext,
      ];
      
      // Use the model passed from the client
      const model = session.modelId || 'gpt-4o-mini';
      
      // Get response from OpenAI
      const response = await openai.chat.completions.create({
        model: model,
        messages,
        temperature: 0.3,
        max_tokens: 200,
        stream: true,
      });
      
      // Process streamed response
      for await (const chunk of response) {
        // Check if interrupted during streaming
        if (session.isResponseInterrupted) {
          logger.info('Response streaming interrupted');
          break;
        }
        
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          assistantResponse += content;
        }
      }
    }
    
    // Only add to conversation context if not interrupted
    if (!session.isResponseInterrupted) {
    // Add assistant response to conversation context
      session.conversationContext.push({
      role: 'assistant',
      content: assistantResponse,
    });
    
      logger.info(`Assistant response: "${assistantResponse}"`);
    }
    
    return assistantResponse;
  } catch (error) {
    logger.error('Error processing user message:', error);
    return 'I apologize, but I encountered an issue processing your request. Please try again.';
  }
}

/**
 * Get response from Gemini API
 */
async function getGeminiResponse(conversationContext, systemPrompt, modelId) {
  try {
    // Create content parts with system prompt
    const parts = [
      { text: systemPrompt },
    ];
    
    // Add conversation history
    for (const message of conversationContext) {
      parts.push({ text: `${message.role}: ${message.content}` });
    }
    
    // Use the specified model ID or default to gemini-1.5-pro
    const geminiModel = modelId || 'gemini-1.5-pro';
    const geminiApiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
    
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
    const response = await fetch(`${geminiApiEndpoint}?key=${process.env.GEMINI_API_KEY}`, {
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
    logger.error('Error calling Gemini API:', error);
    return 'I apologize, but I encountered an issue processing your request. Please try again.';
  }
}

/**
 * Convert text to speech
 */
async function textToSpeech(text, voiceConfig) {
  try {
    // Set default voice parameters if not provided
    const voice = {
      languageCode: voiceConfig?.languageCode || 'en-IN',
      ssmlGender: voiceConfig?.ssmlGender || 'MALE',
      name: voiceConfig?.name || 'en-IN-Chirp3-HD-Orus'
    };
    
    // Log the voice being used
    logger.info(`Converting text to speech using voice: ${voice.name} (${voice.languageCode})`);
    
    // Build the synthesis request
    const request = {
      input: { text },
      voice: voice,
      audioConfig: { audioEncoding: 'MP3' },
    };
    
    // Generate speech
    const [response] = await ttsClient.synthesizeSpeech(request);
    
    // Return the audio content as Buffer
    return Buffer.from(response.audioContent);
  } catch (error) {
    logger.error('Error in text-to-speech:', error);
    return null;
  }
}

/**
 * Process complete audio data for transcription and response
 */
async function processAudioData(connectionData, audioBuffer, mimeType) {
  try {
    // Log the current voice configuration for debugging
    logger.info(`Processing audio with voice config: ${JSON.stringify(connectionData.voiceConfig)}`);
    logger.info(`Audio buffer type: ${typeof audioBuffer}, size: ${audioBuffer.length} bytes, mime type: ${mimeType}`);
    
    // Debug check - verify the buffer is valid
    if (!audioBuffer || audioBuffer.length === 0) {
      logger.error('Audio buffer is empty or invalid');
      sendError(connectionData.ws, 'Invalid audio data received');
      return;
    }
    
    // Debug check for FLAC files
    if (mimeType && mimeType.toLowerCase().includes('flac')) {
      logger.info('Processing FLAC audio file');
      // Check for FLAC magic number (first 4 bytes should be "fLaC")
      if (audioBuffer.length >= 4) {
        const magicBytes = audioBuffer.slice(0, 4).toString('utf8');
        logger.info(`FLAC magic bytes: "${magicBytes}" (should be "fLaC")`);
        if (magicBytes !== 'fLaC') {
          logger.warn('Invalid FLAC file format - missing FLAC signature');
        }
      } else {
        logger.warn('FLAC file too small - insufficient data');
      }
    }
    
    // Pass the language code from the current voice config and the mime type
    const transcript = await speechToText(
      audioBuffer,
      connectionData.voiceConfig.languageCode,
      mimeType
    );
    
    if (transcript) {
      logger.info(`Transcribed audio from ${connectionData.id}: "${transcript}"`);
      
      // Send transcript back to client
      sendToClient(connectionData.ws, {
        type: 'transcript',
        text: transcript
      });
      
      // Only process if not interrupted
      if (!connectionData.isResponseInterrupted) {
        // Process the transcript
        const response = await processUserMessage(connectionData, transcript);
        
        // Only send response if not interrupted during processing
        if (!connectionData.isResponseInterrupted) {
          // Send response as text
          sendToClient(connectionData.ws, {
            type: 'bot_message',
            id: uuidv4(),
            text: response
          });
          
          // Convert to speech if audio session
          if (connectionData.audioSession) {
            const audioBuffer = await textToSpeech(response, connectionData.voiceConfig);
            if (audioBuffer && !connectionData.isResponseInterrupted) {
              sendToClient(connectionData.ws, {
                type: 'audio_message',
                id: uuidv4(),
                audio: audioBuffer.toString('base64'),
                format: 'mp3',
                voice: connectionData.voiceConfig.name // Include voice info in response
              });
            }
          }
        }
      }
    } else {
      logger.error('Failed to transcribe audio - null transcript returned');
      sendError(connectionData.ws, 'Could not transcribe audio');
    }
  } catch (error) {
    logger.error('Error processing audio data:', error);
    if (error.stack) {
      logger.error('Stack trace:', error.stack);
    }
    sendError(connectionData.ws, 'Failed to process audio data');
  }
}

/**
 * Convert speech to text
 */
async function speechToText(audioBuffer, languageCode = 'en-IN', mimeType = 'audio/mp3') {
  try {
    // Flag to track if WebM format is detected
    let webmDetected = false;
    
    // Convert the audio buffer to a base64-encoded string
    const audioBytes = audioBuffer.toString('base64');
    
    // Log the audio buffer size for debugging
    logger.info(`Audio buffer size: ${audioBuffer.length} bytes, mime type: ${mimeType}`);
    
    // More detailed buffer inspection - log more bytes to better identify the format
    const headerHex = audioBuffer.slice(0, 32).toString('hex');
    logger.info(`Buffer header (32 bytes): ${headerHex}`);
    
    // Determine language code based on the provided voice language
    let detectedLanguageCode = 'en-US'; // Default to US English
    
    if (languageCode) {
      // If a Hindi voice is being used, set to Hindi
      if (languageCode.startsWith('hi-')) {
        detectedLanguageCode = 'hi-IN';
        logger.info(`Hindi voice detected, using language code: ${detectedLanguageCode}`);
      } 
      // Use the provided language code as is for Indian English
      else if (languageCode === 'en-IN') {
        detectedLanguageCode = 'en-IN';
        logger.info(`Indian English voice detected, using language code: ${detectedLanguageCode}`);
      }
      // Otherwise use the provided language code
      else {
        detectedLanguageCode = languageCode;
        logger.info(`Using provided language code: ${detectedLanguageCode}`);
      }
    }
    
    // Determine encoding based on mime type - only use supported formats
    // SUPPORTED FORMATS: LINEAR16, FLAC, MULAW, AMR, AMR_WB, OGG_OPUS, SPEEX_WITH_HEADER_BYTE
    let encoding = 'LINEAR16'; // Default to LINEAR16
    let sampleRateHertz = 16000;
    
    // Check for WebM/EBML signature in the buffer first regardless of mime type
    // WebM/EBML files start with 0x1A 0x45 0xDF 0xA3 (hex)
    if (audioBuffer.length >= 4 && 
        audioBuffer[0] === 0x1A && 
        audioBuffer[1] === 0x45 && 
        audioBuffer[2] === 0xDF && 
        audioBuffer[3] === 0xA3) {
      // WebM can contain different audio codecs (OPUS, Vorbis)
      // Let's try different options if one doesn't work
      encoding = 'OGG_OPUS';  // First try OPUS since it's most common in WebM
      
      // For WebM with OPUS, we need to let Google Speech API detect the sample rate
      // This helps avoid the specific sample rate mismatch error
      logger.info('WebM/EBML signature detected in buffer, using OGG_OPUS encoding with automatic sample rate detection');
      sampleRateHertz = undefined;
      
      // WebM files often have 2 audio channels
      webmDetected = true;
    }
    // Check FLAC signature (fLaC)
    else if (audioBuffer.length >= 4 && 
             audioBuffer[0] === 0x66 && // 'f'
             audioBuffer[1] === 0x4C && // 'L'
             audioBuffer[2] === 0x61 && // 'a'
             audioBuffer[3] === 0x43) { // 'C'
      encoding = 'FLAC';
      logger.info('FLAC signature detected in buffer');
      // Let Google detect the sample rate from the FLAC header
      sampleRateHertz = undefined;
    }
    // Map MIME types to Google Speech API encoding values if no signature was detected
    else if (mimeType) {
      const lowercaseMimeType = mimeType.toLowerCase();
      
      if (lowercaseMimeType.includes('webm')) {
        encoding = 'OGG_OPUS';  // WebM typically contains Opus audio
        // For WebM, it's better to let Google detect the sample rate from the header
        sampleRateHertz = undefined;
        logger.info(`Using OGG_OPUS encoding with automatic sample rate detection for WebM`);
        webmDetected = true;
      }
      else if (lowercaseMimeType.includes('flac')) {
        encoding = 'FLAC';
        
        // Always set a sample rate for FLAC to avoid "bad sample rate hertz" error
        // For chunked FLAC files that might not have proper headers
        if (audioBuffer.length >= 4 && 
            audioBuffer[0] === 0x66 && // 'f'
            audioBuffer[1] === 0x4C && // 'L'
            audioBuffer[2] === 0x61 && // 'a'
            audioBuffer[3] === 0x43) { // 'C'
          // If it has a valid signature, let Google detect the rate from the header
          sampleRateHertz = undefined;
          logger.info(`Using FLAC encoding with automatic sample rate detection`);
        } else {
          sampleRateHertz = 16000; // Default to 16kHz
          logger.info(`Using FLAC encoding with explicit sample rate of ${sampleRateHertz}Hz because valid FLAC signature not found`);
        }
      }
      else if (lowercaseMimeType.includes('mulaw')) {
        encoding = 'MULAW';
        logger.info(`Using MULAW encoding`);
      }
      else if (lowercaseMimeType.includes('amr_wb') || lowercaseMimeType.includes('amr-wb')) {
        encoding = 'AMR_WB';
        logger.info(`Using AMR_WB encoding`);
      }
      else if (lowercaseMimeType.includes('amr')) {
        encoding = 'AMR';
        logger.info(`Using AMR encoding`);
      }
      else if (lowercaseMimeType.includes('opus') || lowercaseMimeType.includes('ogg')) {
        encoding = 'OGG_OPUS';
        // For Opus/OGG, let Google detect the sample rate
        sampleRateHertz = undefined;
        logger.info(`Using OGG_OPUS encoding with automatic sample rate detection`);
        // OGG/OPUS files may also have 2 channels
        webmDetected = true;
      }
      else if (lowercaseMimeType.includes('speex')) {
        encoding = 'SPEEX_WITH_HEADER_BYTE';
        logger.info(`Using SPEEX_WITH_HEADER_BYTE encoding`);
      }
      else if (lowercaseMimeType.includes('wav') || lowercaseMimeType.includes('linear') || lowercaseMimeType.includes('l16')) {
        encoding = 'LINEAR16';
        // Extract sample rate if provided
        const sampleRateMatch = mimeType.match(/rate=(\d+)/);
        if (sampleRateMatch && sampleRateMatch[1]) {
          sampleRateHertz = parseInt(sampleRateMatch[1], 10);
        }
        logger.info(`Using LINEAR16 encoding with sample rate ${sampleRateHertz}Hz`);
      }
      else {
        // Check binary data for format detection - looking for WebM/EBML or FLAC signatures
        if (audioBuffer.length >= 4) {
          // Check for WebM/EBML
          if (audioBuffer[0] === 0x1A && audioBuffer[1] === 0x45 && 
              audioBuffer[2] === 0xDF && audioBuffer[3] === 0xA3) {
            encoding = 'OGG_OPUS';
            sampleRateHertz = undefined; // Let Google detect
            logger.info(`WebM/EBML signature detected in file with mime type "${mimeType}", using OGG_OPUS encoding with automatic sample rate detection`);
            webmDetected = true;
          }
          // Check for FLAC
          else if (audioBuffer[0] === 0x66 && audioBuffer[1] === 0x4C && 
                  audioBuffer[2] === 0x61 && audioBuffer[3] === 0x43) {
            encoding = 'FLAC';
            sampleRateHertz = undefined; // Let Google detect
            logger.info(`FLAC signature detected in file with mime type "${mimeType}", using FLAC encoding with automatic sample rate detection`);
          }
          // For MP3, look for ID3 header or MP3 frame sync
          else if ((audioBuffer[0] === 0x49 && audioBuffer[1] === 0x44 && 
                   audioBuffer[2] === 0x33) || // "ID3"
                   ((audioBuffer[0] & 0xFF) === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0)) { // MP3 frame sync
            // Google Speech doesn't support MP3 directly, so we default to LINEAR16
            encoding = 'LINEAR16';
            logger.info(`MP3 signature detected in file with mime type "${mimeType}", using LINEAR16 encoding`);
          }
          else {
            // Unrecognized format
            encoding = 'LINEAR16';
            logger.info(`No known audio signature detected in "${mimeType}" file, defaulting to LINEAR16 encoding`);
          }
        } else {
          // Buffer too small to detect
          encoding = 'LINEAR16';
          logger.info(`Buffer too small to detect format in "${mimeType}" file, defaulting to LINEAR16 encoding`);
        }
      }
    }
    
    logger.info(`Speech recognition config: language=${detectedLanguageCode}, encoding=${encoding}, sample rate=${sampleRateHertz || 'auto'}`);
    
    // Create the request with correct parameter types
    const request = {
      audio: {
        content: audioBytes,
      },
      config: {
        encoding: encoding,
        languageCode: detectedLanguageCode,
        model: "latest_long", // Use the "latest_long" model for better quality, especially with OGG_OPUS
        useEnhanced: true,
        enableAutomaticPunctuation: true,
        profanityFilter: false, // Allow all words to improve recognition
        enableWordTimeOffsets: false,
        enableWordConfidence: true,
      },
    };
    
    // Set audio channel count based on detected format
    if (webmDetected) {
      // For WebM, either leave unspecified or use 2 channels as detected in the header
      logger.info('Using 2 audio channels for WebM/OPUS format');
      request.config.audioChannelCount = 2;
    } else {
      // For other formats, assume mono
      request.config.audioChannelCount = 1; // Assume mono for voice recording
    }
    
    // Add alternative language codes to help with mixed-language speech detection
    // This allows the API to automatically switch between English and Hindi
    if (detectedLanguageCode === 'hi-IN') {
      // For Hindi primary, add English as alternative
      request.config.alternativeLanguageCodes = ['en-US', 'en-IN'];
      logger.info('Added English as alternative language for Hindi speech recognition');
    } else if (detectedLanguageCode === 'en-IN' || detectedLanguageCode === 'en-US') {
      // For English primary, add Hindi as alternative
      request.config.alternativeLanguageCodes = ['hi-IN'];
      logger.info('Added Hindi as alternative language for English speech recognition');
    }
    
    // Only set sample rate if it's defined (needed for most formats but not for FLAC)
    if (sampleRateHertz !== undefined) {
      request.config.sampleRateHertz = sampleRateHertz;
    }
    
    // Add speech contexts to help with recognition
    if (detectedLanguageCode === 'hi-IN' || detectedLanguageCode === 'en-IN') {
      // Add common Indian English and Hindi phrases to help recognition
      request.config.speechContexts = [
        {
          phrases: [
            "hello", "hi", "namaste", "how are you", "kaise ho", "what are you doing",
            "kya kar rahe ho", "thank you", "dhanyavaad", "plant", "garden", "water",
            "fertilizer", "paudha", "bagichaa", "paani", "khaad"
          ],
          boost: 10
        }
      ];
      logger.info('Added speech context with common phrases for better recognition');
    }
    
    // Perform the speech recognition
    logger.info('Sending request to Google Speech-to-Text API...');
    const [response] = await speechClient.recognize(request);
    
    // Log response for debugging
    logger.info(`Speech recognition response: ${JSON.stringify(response, null, 2)}`);
    
    if (!response || !response.results || response.results.length === 0) {
      logger.warn('Speech recognition returned no results');
      
      // If no results with OGG_OPUS encoding for WebM, try with a different encoding
      if (webmDetected && encoding === 'OGG_OPUS') {
        logger.info('Trying alternative approach for WebM: using LINEAR16 encoding...');
        
        // Update the request to use LINEAR16 encoding
        request.config.encoding = 'LINEAR16';
        request.config.sampleRateHertz = 16000; // Standard rate for LINEAR16
        
        try {
          // Try recognition again with different encoding
          const [alternativeResponse] = await speechClient.recognize(request);
          logger.info(`Alternative speech recognition response: ${JSON.stringify(alternativeResponse, null, 2)}`);
          
          if (alternativeResponse && alternativeResponse.results && alternativeResponse.results.length > 0) {
            // Get the transcription from the response
            const alternativeTranscription = alternativeResponse.results
              .map(result => result.alternatives[0].transcript)
              .join('\n');
            
            logger.info(`Alternative speech recognition successful: "${alternativeTranscription}"`);
            return alternativeTranscription;
          }
        } catch (alternativeError) {
          logger.error('Error in alternative speech recognition approach:', alternativeError);
        }
      }
      
      return null;
    }
    
    // Detect actual language used in the recognition
    let detectedActualLanguage = null;
    if (response.results[0] && response.results[0].languageCode) {
      detectedActualLanguage = response.results[0].languageCode;
      logger.info(`Google detected actual speech language: ${detectedActualLanguage}`);
    }
    
    // Get the transcription from the response
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    
    logger.info(`Speech recognition successful: "${transcription}"`);
    return transcription;
  } catch (error) {
    logger.error('Error in speech-to-text:', error);
    // Log more details about the error
    if (error.details) {
      logger.error('Error details:', error.details);
    }
    if (error.code) {
      logger.error(`Error code: ${error.code}`);
    }
    return null;
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

// Add new API endpoints for voice management

// 1. List available voices
app.get('/api/list-voices', authenticateRequest, async (req, res) => {
  try {
    // Define the only voices we want to support
    const supportedVoices = [
      // English - Indian voices
      {
        name: 'en-IN-Chirp3-HD-Orus',
        languageCodes: ['en-IN'],
        ssmlGender: 'MALE'
      },
      {
        name: 'en-IN-Chirp3-HD-Zephyr',
        languageCodes: ['en-IN'],
        ssmlGender: 'FEMALE'
      },
      // Hindi voices
      {
        name: 'hi-IN-Chirp3-HD-Orus',
        languageCodes: ['hi-IN'],
        ssmlGender: 'MALE'
      },
      {
        name: 'hi-IN-Chirp3-HD-Zephyr',
        languageCodes: ['hi-IN'],
        ssmlGender: 'FEMALE'
      }
    ];
    
    // Simply return our fixed list of supported voices
    res.json(supportedVoices);
  } catch (error) {
    logger.error('Error listing voices:', error);
    res.status(500).json({ error: 'Failed to list voices' });
  }
});

// 2. Preview a voice
app.get('/api/preview-voice', authenticateRequest, async (req, res) => {
  try {
    const { voiceName, text } = req.query;
    
    if (!voiceName || !text) {
      return res.status(400).json({ error: 'Voice name and text are required' });
    }
    
    // Extract language code from voice name (e.g., en-US from en-US-Neural2-F)
    const langCodeMatch = voiceName.match(/^([a-z]{2}-[A-Z]{2})/);
    const languageCode = langCodeMatch ? langCodeMatch[1] : 'en-US';
    
    const voiceConfig = {
      languageCode: languageCode,
      name: voiceName
    };
    
    const audioBuffer = await textToSpeech(text, voiceConfig);
    
    if (audioBuffer) {
      res.json({
        audio: audioBuffer.toString('base64'),
        format: 'mp3'
      });
    } else {
      res.status(500).json({ error: 'Failed to generate audio' });
    }
  } catch (error) {
    logger.error('Error previewing voice:', error);
    res.status(500).json({ error: 'Failed to preview voice' });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Botanist AI Voice MCP Server running on port ${PORT}`);
});