# Use official Node.js runtime as base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install system dependencies for audio processing
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    make \
    g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production --no-audit --no-fund --legacy-peer-deps

# Copy source code
COPY . .

# Create temp directory for audio files
RUN mkdir -p /tmp

# Expose health check port
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]