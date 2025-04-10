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
- Koyeb account for deployment

## Deploying to Koyeb

### Option 1: Deploying via Koyeb Dashboard

1. Login to the [Koyeb dashboard](https://app.koyeb.com/)
2. Create a new app by clicking "Create App"
3. Choose "GitHub" as the deployment method
4. Select this repository and the main branch
5. Add the following environment variables:
   - `OPENAI_API_KEY`: Your OpenAI API key
   - (Optional) `GEMINI_API_KEY`: Your Gemini API key if using Gemini instead of OpenAI
   - `GOOGLE_CREDENTIALS_JSON`: The entire JSON content of your Google Cloud service account key file
   - `LOG_LEVEL`: Set to `info` (or `debug` for troubleshooting)
6. Deploy the application

### Option 2: Using Koyeb CLI

1. Install the [Koyeb CLI](https://www.koyeb.com/docs/cli/installation)
2. Login to your Koyeb account:
   ```
   koyeb login
   ```
3. Deploy the application:
   ```
   koyeb app create greenur-botanist \
     --git github.com/lucyfuur94/greenur-backend \
     --git-branch main \
     --ports 8080:http \
     --env OPENAI_API_KEY=your-openai-api-key \
     --env GOOGLE_CREDENTIALS_JSON='{"type":"service_account",...}' \
     --env LOG_LEVEL=info
   ```

## API Documentation

### WebSocket API

Connect to the WebSocket endpoint at `wss://your-koyeb-app-name.koyeb.app/`

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

2. **Chat**
   - `POST /api/chat`
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

Update your frontend configuration to use the WebSocket URL provided by Koyeb:

```typescript
// In src/services/botanistService.ts
const wsUrl = import.meta.env.VITE_BOTANIST_WS_URL || 'wss://your-koyeb-app-name.koyeb.app';
const apiUrl = import.meta.env.VITE_BOTANIST_API_URL || 'https://your-koyeb-app-name.koyeb.app/api';
```

## Monitoring and Logs

1. Access the Koyeb dashboard
2. Select your deployed application
3. Navigate to the "Logs" tab to view real-time logs
4. Check the "Metrics" tab to monitor performance

## Troubleshooting

If you encounter issues with the deployment:

1. Verify that all environment variables are set correctly
2. Check the logs for any error messages
3. Ensure your Google Cloud service account has the necessary permissions
4. Verify that your OpenAI API key is valid
