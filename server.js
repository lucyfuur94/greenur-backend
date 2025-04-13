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

// Create WebSocket server (without attaching it to HTTP server directly)
const wss = new WebSocket.Server({ noServer: true });

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
        modelId: modelId || 'gpt-4o',
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

// WebSocket server upgrade with authentication - single handler approach
server.on('upgrade', (request, socket, head) => {
  // Authenticate the WebSocket connection
  if (!authenticateWebSocket(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  
  // If authentication passes, upgrade the connection to WebSocket
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// WebSocket event handlers
wss.on('connection', (ws) => {
  const connectionId = uuidv4();
  logger.info(`New WebSocket connection established: ${connectionId}`);
  
  // Set heartbeat interval
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
      logger.debug(`Sent ping to client: ${connectionId}`);
    } else {
      clearInterval(pingInterval);
    }
  }, 10000); // Send ping every 10 seconds

  // Handle pong response
  ws.on('pong', () => {
    logger.debug(`Received pong from client: ${connectionId}`);
  });
  
  // Store connection data
  const connectionData = {
    id: connectionId,
    ws,
    conversationContext: [],
    modelId: 'gpt-4o', // Default model
    modelType: 'openai', // Default model type
    audioSession: false, // Whether this session is using audio
    voiceConfig: {
      languageCode: 'en-IN',
      ssmlGender: 'MALE',
      name: 'en-IN-Chirp3-HD-Orus'
    }, // Default voice configuration
    isResponseInterrupted: false, // Track if response was interrupted
    pingInterval: pingInterval // Store interval for cleanup
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
        case 'ping':
          // Handle ping message from client
          logger.debug(`Received ping from client: ${connectionId}`);
          sendToClient(ws, { type: 'pong' });
          break;
        
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
            } 
            // If just a voice name is provided
            else if (typeof data.voice === 'string') {
              connectionData.voiceConfig.name = data.voice;
              
              // Extract language code from voice name (e.g., en-IN from en-IN-Chirp3-HD-Orus)
              const langCodeMatch = data.voice.match(/^([a-z]{2}-[A-Z]{2})/);
              if (langCodeMatch) {
                connectionData.voiceConfig.languageCode = langCodeMatch[1];
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
            const audioBuffer = Buffer.from(data.audio, 'base64');
            // Pass the language code from the current voice config
            const transcript = await speechToText(audioBuffer, connectionData.voiceConfig.languageCode);
            
            if (transcript) {
              logger.info(`Transcribed audio from ${connectionId}: "${transcript}"`);
              
              // Send transcript back to client
              sendToClient(ws, {
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
              }
            } else {
              sendError(ws, 'Could not transcribe audio');
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
    // Clean up ping interval
    const connection = activeConnections.get(connectionId);
    if (connection && connection.pingInterval) {
      clearInterval(connection.pingInterval);
    }
    activeConnections.delete(connectionId);
  });
  
  // Handle WebSocket errors
  ws.on('error', (error) => {
    logger.error(`WebSocket error for ${connectionId}:`, error);
    // Clean up ping interval
    const connection = activeConnections.get(connectionId);
    if (connection && connection.pingInterval) {
      clearInterval(connection.pingInterval);
    }
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
      const model = session.modelId || 'gpt-4o';
      
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
 * Convert speech to text
 */
async function speechToText(audioBuffer, languageCode = 'en-IN') {
  try {
    // Convert the audio buffer to a base64-encoded string
    const audioBytes = audioBuffer.toString('base64');
    
    // Determine language code based on the provided voice language
    let detectedLanguageCode = 'en-US'; // Default to US English
    
    if (languageCode) {
      // If a Hindi voice is being used, set to Hindi
      if (languageCode.startsWith('hi-')) {
        detectedLanguageCode = 'hi-IN';
      } 
      // If it's Indian English, use en-IN
      else if (languageCode === 'en-IN') {
        detectedLanguageCode = 'en-IN';
      }
      // Otherwise use the provided language code
      else {
        detectedLanguageCode = languageCode;
      }
    }
    
    logger.info(`Using speech recognition language: ${detectedLanguageCode}`);
    
    // Create the request
    const request = {
      audio: {
        content: audioBytes,
      },
      config: {
        encoding: 'MP3',
        sampleRateHertz: 48000,
        languageCode: detectedLanguageCode,
        model: 'default',
        useEnhanced: true,
        enableAutomaticPunctuation: true,
        enableSpokenPunctuation: true,
      },
    };
    
    // Perform the speech recognition
    const [response] = await speechClient.recognize(request);
    
    // Get the transcription from the response
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    
    return transcription;
  } catch (error) {
    logger.error('Error in speech-to-text:', error);
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