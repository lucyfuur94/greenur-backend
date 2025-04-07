#!/bin/bash

# Print debug info
echo "Starting setup script"
echo "HOME directory: $HOME"
echo "Current directory: $(pwd)"

# Create credentials folder
CREDENTIALS_DIR="$HOME/google-credentials"
mkdir -p $CREDENTIALS_DIR
echo "Created credentials directory: $CREDENTIALS_DIR"

# Check for credentials environment variable
if [ -n "$GOOGLE_CREDENTIALS_JSON" ]; then
  echo "Found GOOGLE_CREDENTIALS_JSON environment variable"
  
  # Create credentials file
  CREDENTIALS_FILE="$CREDENTIALS_DIR/credentials.json"
  echo "$GOOGLE_CREDENTIALS_JSON" > $CREDENTIALS_FILE
  echo "Created credentials file at $CREDENTIALS_FILE"
  
  # Set the environment variable to point to the file
  export GOOGLE_APPLICATION_CREDENTIALS=$CREDENTIALS_FILE
  echo "Set GOOGLE_APPLICATION_CREDENTIALS to $CREDENTIALS_FILE"
else
  echo "Warning: GOOGLE_CREDENTIALS_JSON not found in environment"
fi

# Start the server
echo "Starting server..."
node server.js 