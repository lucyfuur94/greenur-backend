FROM node:18-slim

WORKDIR /app

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

# Make the startup script executable
RUN chmod +x start.sh

# Expose port
EXPOSE 8080

# Start using our custom script
CMD ["./start.sh"] 