# Greenur Botanist AI Voice Service

This backend provides real-time voice calling functionality for the Greenur app's Botanist AI assistant. It handles WebRTC connections, audio streaming, speech-to-text, language model processing, and text-to-speech capabilities.

## Architecture

The service functions as follows:
1. Acts as a WebSocket signaling server for WebRTC connections
2. Establishes server-side WebRTC connections with clients
3. Streams user audio to Google Speech-to-Text
4. Sends transcribed text to OpenAI's language models
5. Streams text responses from the LLM to Google Text-to-Speech
6. Streams the resulting AI audio back to the frontend via WebRTC

## Prerequisites

- OpenAI API key
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

## Updating the Frontend Configuration

Update your frontend configuration to use the WebSocket URL provided by Koyeb:

```typescript
// In src/services/webRTCService.ts
const wsUrl = import.meta.env.VITE_NETLIFY_WS_PORT 
  ? `ws://localhost:${import.meta.env.VITE_NETLIFY_WS_PORT}` 
  : 'wss://your-koyeb-app-name.koyeb.app/ws';
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
