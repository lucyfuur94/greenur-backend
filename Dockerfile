FROM node:18-slim

WORKDIR /app

# Install system dependencies required for mediasoup
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    python3-pip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Check for credentials and set environment variable if found
RUN if [ -f .env ]; then \
    echo "Using credentials from .env file"; \
    grep -v '^#' .env > /tmp/env.txt; \
    export $(cat /tmp/env.txt | xargs); \
    rm /tmp/env.txt; \
    fi

# Expose port
EXPOSE 8080

# Start server
CMD ["node", "server.js"] 