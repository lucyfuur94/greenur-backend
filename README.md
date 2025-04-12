# Greenur Botanist AI Voice Service

This backend provides a microservice (MCP) for the Greenur app's Botanist AI assistant, enabling real-time communication through WebSockets. It handles audio processing, speech-to-text, language model processing, and text-to-speech capabilities.

## Architecture

The service functions as follows:
1. Acts as a WebSocket server for real-time bidirectional communication
2. Provides REST API endpoints for non-WebSocket clients
3. Processes audio data from clients using Google Speech-to-Text
4. Sends transcribed text to language models (OpenAI or Gemini)
5. Converts AI text responses to speech using Google Text-to-Speech
6. Streams all responses back to the client in real-time via WebSockets

## Prerequisites

- OpenAI API key (or Gemini API key)
- Google Cloud service account with Speech-to-Text and Text-to-Speech API access
- Render account for deployment

## Security

All API endpoints and WebSocket connections are protected with API key authentication. You must include the secret API key with every request:

- For REST API calls: Include the API key in the `X-API-Key` header or as an `api_key` query parameter
- For WebSocket connections: Include the API key as an `api_key` query parameter in the WebSocket URL

## Deploying to Render

### Option 1: Deploying via Render Dashboard

1. Login to the [Render dashboard](https://dashboard.render.com/)
2. Create a new Web Service
3. Connect your GitHub repository
4. Configure the service:
   - Name: `greenur-botanist`
   - Build Command: `npm install`
   - Start Command: `./start.sh`
5. Add the following environment variables:
   - `OPENAI_API_KEY`: Your OpenAI API key
   - (Optional) `GEMINI_API_KEY`: Your Gemini API key if using Gemini instead of OpenAI
   - `GOOGLE_CREDENTIALS_JSON`: The entire JSON content of your Google Cloud service account key file
   - `LOG_LEVEL`: Set to `info` (or `debug` for troubleshooting)
   - `API_SECRET_KEY`: A strong secret key for API authentication
6. Deploy the service

### Option 2: Using Render CLI

If using the Render CLI:

```bash
render create
```

Follow the interactive prompts to set up your service, making sure to include all the necessary environment variables.

## API Documentation

### Authentication

All API endpoints and WebSocket connections require authentication. Include your API key in one of the following ways:

- REST API: 
  - Header: `X-API-Key: your_api_key_here`
  - Query parameter: `?api_key=your_api_key_here`

- WebSocket:
  - Connect to: `wss://your-render-app.onrender.com?api_key=your_api_key_here`

### WebSocket API

Connect to the WebSocket endpoint at `wss://your-render-app.onrender.com?api_key=your_api_key_here`

#### Messages from Client to Server:

1. **Configuration Message**
   ```json
   {
     "type": "config",
     "modelId": "gpt-4o",
     "audioSession": true
   }
   ```

2. **Text Message**
   ```json
   {
     "type": "chat_message",
     "message": "How do I care for a peace lily?"
   }
   ```

3. **Audio Message**
   ```json
   {
     "type": "audio_data",
     "audio": "base64EncodedAudioData",
     "format": "base64"
   }
   ```

#### Messages from Server to Client:

1. **Connection Confirmation**
   ```json
   {
     "type": "connected",
     "connectionId": "uuid"
   }
   ```

2. **Text Response**
   ```json
   {
     "type": "bot_message",
     "id": "uuid",
     "text": "Peace lilies prefer indirect light and moist soil..."
   }
   ```

3. **Audio Response**
   ```json
   {
     "type": "audio_message",
     "id": "uuid",
     "audio": "base64EncodedAudioData",
     "format": "mp3"
   }
   ```

4. **Transcription**
   ```json
   {
     "type": "transcript",
     "text": "How do I care for a peace lily?"
   }
   ```

5. **Error**
   ```json
   {
     "type": "error",
     "error": "Error message"
   }
   ```

### REST API

The following REST endpoints are available:

1. **Health Check**
   - `GET /api/health`
   - Returns server health status
   - *No authentication required*

2. **Chat**
   - `POST /api/chat`
   - *Authentication required*
   - Request body:
     ```json
     {
       "message": "How do I care for a peace lily?",
       "sessionId": "optional-session-id",
       "modelId": "optional-model-id"
     }
     ```
   - Response:
     ```json
     {
       "sessionId": "uuid",
       "message": "Peace lilies prefer indirect light and moist soil..."
     }
     ```

## Updating the Frontend Configuration

Update your frontend configuration to use the WebSocket URL provided by Render:

```typescript
// In src/services/botanistService.ts
const apiKey = "your_api_key_here";
const wsUrl = `${import.meta.env.VITE_BOTANIST_WS_URL || 'wss://your-render-app.onrender.com'}?api_key=${apiKey}`;
const apiUrl = import.meta.env.VITE_BOTANIST_API_URL || 'https://your-render-app.onrender.com/api';

// For API calls
const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': apiKey
};
```

## Monitoring and Logs

1. Access the Render dashboard
2. Select your deployed application
3. Navigate to the "Logs" tab to view real-time logs
4. Check the "Metrics" tab to monitor performance

## Troubleshooting

If you encounter issues with the deployment:

1. Verify that all environment variables are set correctly
2. Check the logs for any error messages
3. Ensure your Google Cloud service account has the necessary permissions
4. Verify that your OpenAI API key is valid
5. Make sure you're including the correct API key in all requests
