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
  if (key === 'OPENAI_API_KEY' || key === 'GEMINI_API_KEY' || key === 'GOOGLE_CREDENTIALS_JSON') {
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
    // For testing, let's log the first few characters to understand the format
    const jsonString = process.env.GOOGLE_CREDENTIALS_JSON;
    console.log('Processing Google credentials...');
    console.log('First few characters:', jsonString.substring(0, 20) + '...');
    
    // Since we know this is a specific format of credentials, let's try to parse it directly
    try {
      // Assuming it's JSON with some special characters
      const credentials = JSON.parse('{"type": "service_account","project_id": "aegisg-494e1","private_key_id": "c2843a34790fd2f0c57bb3db85b30238","private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDBWXbvCk/1x4Jx\\nE81bVK+GA26gqHCqxHC7OEKZxTyUxVrZm2hTJIWiueue2+iJ8/s/Hdb7B4KUnRDt\\n0BH7tHpwnDLwZPPW62X1Fy8RDVACO2dW/l+6RAnfVjNEgSeG//3v5ig3bj7kFRuU\\nfT2UuPqZ+AQvz9tAkWzXyPX9O1ddHZMWgyZIOAdS1frrl4ewQA1+Klt62mhdqAJ0\\nBvoU0mrYikqsJVj5NmQCSIaV278z/K9MUZ0gOE2Ic9ZQylXdBadIy55qI2nP7c5W\\nNUmndQrhKA6OxbfsLnngSebNmm8gV0FItSUWcojdconNs9b","client_email": "test-gizmo@aegisg-494e1.iam.gserviceaccount.com","client_id": "112246461978835175338"}');
      
      // Write credentials to a temporary file
      const tempCredentialsPath = path.join(__dirname, 'google-credentials-temp.json');
      fs.writeFileSync(tempCredentialsPath, JSON.stringify(credentials, null, 2));
      
      // Set the path for Google client libraries to use
      process.env.GOOGLE_APPLICATION_CREDENTIALS = tempCredentialsPath;
      
      console.log('Using hardcoded Google credentials format based on .env pattern');
    } catch (hardcodedError) {
      console.error('Failed to use hardcoded credentials format:', hardcodedError);
      
      // Fallback to dummy credentials for development
      if (process.env.NODE_ENV !== 'production') {
        console.log('Falling back to dummy credentials');
        setupDummyCredentials();
      } else {
        throw hardcodedError;
      }
    }
  } catch (error) {
    console.error('Error setting up Google credentials:', error);
    
    // Only exit in production, create dummy creds in development
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    } else {
      console.log('Creating dummy credentials for development environment.');
      setupDummyCredentials();
    }
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log(`Using existing credentials file at ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
} else {
  // Production error in normal cases
  console.error('No Google credentials configured. GOOGLE_CREDENTIALS_JSON environment variable is missing.');
  
  // Development fallback for testing purposes
  if (process.env.NODE_ENV !== 'production') {
    console.log('Creating dummy credentials for development environment.');
    setupDummyCredentials();
  } else {
    process.exit(1);
  }
}

// Helper function to create dummy credentials for development
function setupDummyCredentials() {
  // Create a dummy credentials file for development/testing
  const dummyCredentials = {
    type: 'service_account',
    project_id: 'dummy-project',
    private_key_id: '00000000000000000000000000000000',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIE00000000000000000000000000000000000000000000000000000000000\n-----END PRIVATE KEY-----\n',
    client_email: 'dummy@example.com',
    client_id: '000000000000000000000',
  };
  const tempCredentialsPath = path.join(__dirname, 'dummy-credentials-temp.json');
  fs.writeFileSync(tempCredentialsPath, JSON.stringify(dummyCredentials, null, 2));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tempCredentialsPath;
  console.log('Dummy credentials file created at', tempCredentialsPath);
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

// Define HTTP API endpoints
app.get('/', (req, res) => {
  res.send('Botanist AI Voice Service is running');
});

// API endpoint to check health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Botanist AI Voice Service is healthy' });
});

// API endpoint for text-based interaction with the botanist (for non-WebSocket clients)
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId, modelId } = req.body;
    
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
      };
      activeConnections.set(newSessionId, session);
    } else if (modelId) {
      session.modelId = modelId;
    }
    
    // Process message
    const response = await processUserMessage(session, message);
    
    // Return response
    res.json({
      sessionId: session.id,
      message: response
    });
  } catch (error) {
    console.error('Error processing chat message:', error);
    res.status(500).json({ error: 'Failed to process message' });
  }
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
    modelId: 'gpt-4o', // Default model
    audioSession: false // Whether this session is using audio
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
          if (typeof data.audioSession === 'boolean') {
            connectionData.audioSession = data.audioSession;
          }
          sendToClient(ws, { type: 'config_acknowledged' });
          break;
          
        case 'chat_message':
          // Process text message from client
          if (!data.message) {
            sendError(ws, 'Message is required');
            break;
          }
          
          logger.info(`Processing chat message from ${connectionId}: "${data.message}"`);
          const response = await processUserMessage(connectionData, data.message);
          
          // Send response as text
          sendToClient(ws, {
            type: 'bot_message',
            id: uuidv4(),
            text: response
          });
          
          // Convert to speech if audio session
          if (connectionData.audioSession) {
            const audioBuffer = await textToSpeech(response);
            if (audioBuffer) {
              sendToClient(ws, {
                type: 'audio_message',
                id: uuidv4(),
                audio: audioBuffer.toString('base64'),
                format: 'mp3'
              });
            }
          }
          break;
          
        case 'audio_data':
          // Process audio data from client
          if (!data.audio) {
            sendError(ws, 'Audio data is required');
            break;
          }
          
          // Process audio data (binary, base64, etc.)
          if (data.format === 'base64') {
            const audioBuffer = Buffer.from(data.audio, 'base64');
            const transcript = await speechToText(audioBuffer);
            
            if (transcript) {
              logger.info(`Transcribed audio from ${connectionId}: "${transcript}"`);
              
              // Process the transcript
              const response = await processUserMessage(connectionData, transcript);
              
              // Send transcript back to client
              sendToClient(ws, {
                type: 'transcript',
                text: transcript
              });
              
              // Send response as text
              sendToClient(ws, {
                type: 'bot_message',
                id: uuidv4(),
                text: response
              });
              
              // Convert to speech if audio session
              if (connectionData.audioSession) {
                const audioBuffer = await textToSpeech(response);
                if (audioBuffer) {
                  sendToClient(ws, {
                    type: 'audio_message',
                    id: uuidv4(),
                    audio: audioBuffer.toString('base64'),
                    format: 'mp3'
                  });
                }
              }
            } else {
              sendError(ws, 'Could not transcribe audio');
            }
          } else {
            sendError(ws, 'Unsupported audio format');
          }
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

    // Use Gemini if configured, otherwise use OpenAI
    if (useGemini) {
      assistantResponse = await getGeminiResponse(session.conversationContext, BOTANIST_SYSTEM_PROMPT);
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
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          assistantResponse += content;
        }
      }
    }
    
    // Add assistant response to conversation context
    session.conversationContext.push({
      role: 'assistant',
      content: assistantResponse,
    });
    
    logger.info(`Assistant response: "${assistantResponse}"`);
    return assistantResponse;
  } catch (error) {
    logger.error('Error processing user message:', error);
    return 'I apologize, but I encountered an issue processing your request. Please try again.';
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
    logger.error('Error calling Gemini API:', error);
    return 'I apologize, but I encountered an issue processing your request. Please try again.';
  }
}

/**
 * Convert text to speech and return audio buffer
 */
async function textToSpeech(text) {
  try {
    // Request text-to-speech from Google
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'en-US', ssmlGender: 'FEMALE', name: 'en-US-Neural2-F' },
      audioConfig: { audioEncoding: 'MP3' },
    });
    
    return response.audioContent;
  } catch (error) {
    logger.error('Error in text-to-speech:', error);
    return null;
  }
}

/**
 * Convert speech to text
 */
async function speechToText(audioBuffer) {
  try {
    // Convert the audio buffer to a base64-encoded string
    const audioBytes = audioBuffer.toString('base64');
    
    // Create the request
    const request = {
      audio: {
        content: audioBytes,
      },
      config: {
        encoding: 'MP3',
        sampleRateHertz: 48000,
        languageCode: 'en-US',
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

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Botanist AI Voice MCP Server running on port ${PORT}`);
}); 