import { Transform } from 'stream';
import { config } from '../config.js';
import { WebSocket } from 'ws';

/**
 * AssemblyAI Streaming Transcription Service - Direct WebSocket Implementation
 * Following AssemblyAI's streaming API documentation
 */

// Track active connections
let activeTranscribers = new Map();

/**
 * Initialize streaming client (now using direct WebSocket)
 */
export function initializeStreamingClient() {
  console.log('✅ [STREAMING] Direct WebSocket client ready');
}

/**
 * Creates a streaming transcriber using direct WebSocket connection
 * @param {string} sessionId - Unique session identifier
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} WebSocket connection and data
 */
export async function createStreamingTranscriber(sessionId, options = {}) {
  try {
    console.log(`🎯 [STREAMING] Creating WebSocket transcriber for session: ${sessionId}`);
    
    // Build WebSocket URL with required query parameters
    const wsUrl = new URL('wss://streaming.assemblyai.com/v3/ws');
    wsUrl.searchParams.set('sample_rate', '48000'); // Discord's sample rate
    wsUrl.searchParams.set('encoding', 'pcm_s16le'); // Discord's audio format
    wsUrl.searchParams.set('format_turns', 'true');
    
    // Add optional parameters
    if (options.end_of_turn_confidence_threshold) {
      wsUrl.searchParams.set('end_of_turn_confidence_threshold', options.end_of_turn_confidence_threshold.toString());
    }
    
    console.log(`🔗 [STREAMING] Connecting to: ${wsUrl.toString()}`);
    
    // Create WebSocket with Authorization header
    const ws = new WebSocket(wsUrl.toString(), {
      headers: {
        'Authorization': config.apis.assemblyAI
      }
    });
    
    // Initialize session data
    const transcriptionData = {
      sessionId,
      transcripts: [],
      participants: new Map(),
      isConnected: false,
      startTime: Date.now(),
      lastActivity: Date.now(),
      websocket: ws,
      assemblySessionId: null,
      expiresAt: null
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 10000);

      ws.on('open', () => {
        console.log(`✅ [STREAMING] WebSocket opened for session: ${sessionId}`);
        transcriptionData.isConnected = true;
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log(`📨 [STREAMING] Message type: ${message.type} for ${sessionId}`);
          
          switch (message.type) {
            case 'Begin':
              console.log(`🚀 [STREAMING] Session began: ${message.id}`);
              transcriptionData.assemblySessionId = message.id;
              transcriptionData.expiresAt = message.expires_at;
              
              // Store the transcriber and resolve the promise
              activeTranscribers.set(sessionId, {
                websocket: ws,
                data: transcriptionData
              });
              
              clearTimeout(timeout);
              resolve({ websocket: ws, data: transcriptionData });
              break;
              
            case 'Turn':
              if (message.transcript && message.transcript.trim() !== '') {
                console.log(`💬 [STREAMING] Turn: "${message.transcript}"`);
                
                const transcriptEntry = {
                  text: message.transcript,
                  timestamp: Date.now(),
                  turnOrder: message.turn_order,
                  isFormatted: message.turn_is_formatted,
                  endOfTurn: message.end_of_turn,
                  confidence: message.end_of_turn_confidence,
                  words: message.words || []
                };
                
                transcriptionData.transcripts.push(transcriptEntry);
                transcriptionData.lastActivity = Date.now();
              }
              break;
              
            case 'Termination':
              console.log(`🔚 [STREAMING] Session terminated for ${sessionId}`);
              transcriptionData.isConnected = false;
              break;
              
            default:
              console.log(`📋 [STREAMING] Unknown message: ${message.type}`);
          }
        } catch (error) {
          console.error(`❌ [STREAMING] Message parse error for ${sessionId}:`, error);
        }
      });

      ws.on('error', (error) => {
        console.error(`❌ [STREAMING] WebSocket error for ${sessionId}:`, error);
        transcriptionData.isConnected = false;
        clearTimeout(timeout);
        reject(error);
      });

      ws.on('close', (code, reason) => {
        console.log(`🔒 [STREAMING] WebSocket closed for ${sessionId}: ${code} - ${reason}`);
        transcriptionData.isConnected = false;
      });
    });

  } catch (error) {
    console.error(`❌ [STREAMING] Failed to create WebSocket transcriber:`, error);
    throw error;
  }
}

/**
 * Connects audio stream to AssemblyAI WebSocket
 * @param {string} sessionId - Session identifier
 * @param {Stream} audioStream - Discord audio stream
 * @param {string} userId - User ID for the stream
 * @returns {Promise<void>}
 */
export async function connectAudioStream(sessionId, audioStream, userId) {
  try {
    console.log(`🔗 [STREAMING] Connecting audio stream for user ${userId} in session ${sessionId}`);
    
    const sessionData = activeTranscribers.get(sessionId);
    if (!sessionData) {
      throw new Error(`No transcriber found for session: ${sessionId}`);
    }

    const { websocket, data } = sessionData;
    
    // Verify WebSocket is open
    if (!data.isConnected || websocket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection is not open');
    }
    
    // Create audio transform stream
    const audioTransform = createAudioTransformStream(userId);
    
    // Connect audio pipeline
    audioStream.pipe(audioTransform);
    
    // Handle transformed audio data
    audioTransform.on('data', (chunk) => {
      try {
        if (data.isConnected && websocket.readyState === WebSocket.OPEN) {
          // Convert audio chunk to base64 as required by AssemblyAI
          const base64Audio = chunk.toString('base64');
          
          // Send audio using the correct format from AssemblyAI docs
          websocket.send(base64Audio);
        } else {
          console.warn(`⚠️ [STREAMING] Skipping audio chunk - connection closed for ${userId}`);
        }
      } catch (error) {
        console.error(`❌ [STREAMING] Error sending audio for ${userId}:`, error);
      }
    });
    
    audioTransform.on('end', () => {
      console.log(`🔚 [STREAMING] Audio stream ended for user ${userId}`);
    });
    
    console.log(`✅ [STREAMING] Audio stream connected for user ${userId}`);
    
  } catch (error) {
    console.error(`❌ [STREAMING] Failed to connect audio stream for ${userId}:`, error);
    throw error;
  }
}

/**
 * Creates audio transform stream for Discord audio
 * @param {string} userId - User identifier
 * @returns {Transform} Transform stream
 */
export function createAudioTransformStream(userId) {
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        // Discord sends stereo PCM data, convert to mono
        // Each sample is 2 bytes (16-bit), stereo = 4 bytes per frame
        const monoChunk = Buffer.alloc(chunk.length / 2);
        for (let i = 0; i < chunk.length; i += 4) {
          // Take left channel (first 2 bytes of each 4-byte frame)
          monoChunk[i / 2] = chunk[i];
          monoChunk[i / 2 + 1] = chunk[i + 1];
        }
        
        callback(null, monoChunk);
      } catch (error) {
        console.error(`❌ [STREAMING] Audio transform error for ${userId}:`, error);
        callback(error);
      }
    }
  });
}

/**
 * Stops streaming transcription and returns final transcript
 * @param {string} sessionId - Session identifier
 * @returns {Promise<Object>} Final transcript data
 */
export async function stopStreamingTranscription(sessionId) {
  try {
    console.log(`⏹️ [STREAMING] Stopping transcription for session: ${sessionId}`);
    
    const sessionData = activeTranscribers.get(sessionId);
    if (!sessionData) {
      console.warn(`⚠️ [STREAMING] No session found for: ${sessionId}`);
      return { transcripts: [], participants: new Map() };
    }
    
    const { websocket, data } = sessionData;
    
    // Send termination message
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({
        type: "Terminate"
      }));
      
      // Wait a moment for final messages
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      websocket.close();
    }
    
    // Remove from active transcribers
    activeTranscribers.delete(sessionId);
    
    const finalTranscript = data.transcripts.map(t => t.text).join(' ').trim();
    const wordCount = data.transcripts.reduce((count, t) => count + (t.words?.length || 0), 0);
    
    console.log(`✅ [STREAMING] Transcription completed for session: ${sessionId}`);
    console.log(`📊 [STREAMING] Final stats: ${wordCount} words, ${data.participants.size} participants`);
    
    return {
      sessionId,
      transcripts: data.transcripts,
      participants: data.participants,
      finalTranscript,
      wordCount,
      duration: Date.now() - data.startTime
    };
    
  } catch (error) {
    console.error(`❌ [STREAMING] Error stopping transcription for ${sessionId}:`, error);
    throw error;
  }
}

/**
 * Gets streaming statistics for a session
 * @param {string} sessionId - Session identifier
 * @returns {Object} Current streaming stats
 */
export function getStreamingStats(sessionId) {
  const sessionData = activeTranscribers.get(sessionId);
  if (!sessionData) {
    return null;
  }
  
  const { data } = sessionData;
  return {
    sessionId: data.sessionId,
    isConnected: data.isConnected,
    transcriptCount: data.transcripts.length,
    participantCount: data.participants.size,
    duration: Date.now() - data.startTime,
    lastActivity: data.lastActivity,
    assemblySessionId: data.assemblySessionId
  };
}

/**
 * Validates streaming configuration
 * @returns {boolean} Whether configuration is valid
 */
export function validateStreamingConfig() {
  const errors = [];
  
  if (!config.apis.assemblyAI) {
    errors.push('AssemblyAI API key not configured');
  }
  
  if (errors.length > 0) {
    console.error('❌ [STREAMING] Configuration errors:', errors);
    return false;
  }
  
  console.log('✅ [STREAMING] Configuration validated');
  return true;
}