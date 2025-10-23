import { AssemblyAI } from 'assemblyai';
import { Transform } from 'stream';
import { config } from '../config.js';

/**
 * AssemblyAI Streaming Transcription Service
 * Handles real-time voice transcription using streaming API
 */

// Initialize AssemblyAI client
let client;
let activeTranscribers = new Map();

/**
 * Initialize AssemblyAI streaming client
 */
export function initializeStreamingClient() {
  try {
    if (!config.apis.assemblyAI) {
      throw new Error('AssemblyAI API key not found in configuration');
    }
    
    client = new AssemblyAI({
      apiKey: config.apis.assemblyAI
    });
    
    console.log('✅ [STREAMING] AssemblyAI client initialized');
    return client;
    
  } catch (error) {
    console.error('❌ [STREAMING] Failed to initialize AssemblyAI client:', error);
    throw error;
  }
}

/**
 * Creates a streaming transcriber for a recording session
 * @param {string} sessionId - Unique session identifier
 * @param {Object} options - Transcription options
 * @returns {Promise<Object>} Transcriber instance and handlers
 */
export async function createStreamingTranscriber(sessionId, options = {}) {
  try {
    console.log(`🎯 [STREAMING] Creating transcriber for session: ${sessionId}`);
    
    // Ensure client is initialized
    if (!client) {
      initializeStreamingClient();
    }
    
    const CONNECTION_PARAMS = {
      sampleRate: 48000, // Discord's sample rate
      channels: 1,       // Mono audio
      formatTurns: true,
      punctuate: true,
      ...options
    };
    
    console.log(`🔧 [STREAMING] Connection params:`, CONNECTION_PARAMS);
    
    // Create streaming transcriber
    const transcriber = client.streaming.transcriber(CONNECTION_PARAMS);
    
    // Store transcription data
    const transcriptionData = {
      sessionId,
      transcripts: [],
      participants: new Map(),
      isConnected: false,
      startTime: Date.now(),
      lastActivity: Date.now()
    };
    
    // Set up event handlers
    transcriber.on('open', ({ id }) => {
      console.log(`✅ [STREAMING] Session opened: ${id} for ${sessionId}`);
      transcriptionData.isConnected = true;
      transcriptionData.assemblySessionId = id;
    });
    
    transcriber.on('error', (error) => {
      console.error(`❌ [STREAMING] Transcriber error for ${sessionId}:`, error);
      transcriptionData.isConnected = false;
    });
    
    transcriber.on('close', (code, reason) => {
      console.log(`🔒 [STREAMING] Session closed for ${sessionId}:`, code, reason);
      transcriptionData.isConnected = false;
    });
    
    transcriber.on('turn', (turn) => {
      if (!turn.transcript || turn.transcript.trim() === '') {
        return;
      }
      
      console.log(`💬 [STREAMING] Transcript received for ${sessionId}: "${turn.transcript}"`);
      
      // Store transcript with metadata
      const transcriptEntry = {
        text: turn.transcript,
        confidence: turn.confidence || 0,
        timestamp: Date.now(),
        duration: turn.duration || 0,
        speaker: turn.speaker || 'Unknown'
      };
      
      transcriptionData.transcripts.push(transcriptEntry);
      transcriptionData.lastActivity = Date.now();
      
      // Update participant tracking
      if (!transcriptionData.participants.has(turn.speaker)) {
        transcriptionData.participants.set(turn.speaker, {
          name: turn.speaker,
          wordCount: 0,
          transcriptCount: 0
        });
      }
      
      const participant = transcriptionData.participants.get(turn.speaker);
      participant.wordCount += turn.transcript.split(' ').length;
      participant.transcriptCount += 1;
    });
    
    // Store transcriber for session management
    activeTranscribers.set(sessionId, {
      transcriber,
      data: transcriptionData,
      createdAt: Date.now()
    });
    
    console.log(`✅ [STREAMING] Transcriber created for session: ${sessionId}`);
    
    return {
      transcriber,
      data: transcriptionData,
      connect: () => transcriber.connect(),
      close: () => transcriber.close(),
      getTranscripts: () => transcriptionData.transcripts,
      isConnected: () => transcriptionData.isConnected
    };
    
  } catch (error) {
    console.error(`❌ [STREAMING] Failed to create transcriber for ${sessionId}:`, error);
    throw error;
  }
}

/**
 * Creates a transform stream to convert Discord audio to AssemblyAI format
 * @param {string} userId - User ID for logging
 * @returns {Transform} Transform stream
 */
export function createAudioTransformStream(userId) {
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        // Discord sends Opus-decoded PCM data
        // AssemblyAI expects raw PCM, so we can pass it through
        // Note: Discord uses 48kHz, 16-bit, stereo -> mono conversion needed
        
        // Convert stereo to mono if needed (take left channel)
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
 * Connects audio stream to AssemblyAI transcriber
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
    
    const { transcriber } = sessionData;
    
    // Ensure transcriber is connected
    if (!sessionData.data.isConnected) {
      console.log(`🚀 [STREAMING] Connecting transcriber for session: ${sessionId}`);
      await transcriber.connect();
    }
    
    // Create audio transform stream
    const audioTransform = createAudioTransformStream(userId);
    
    // Connect audio pipeline: Discord Audio -> Transform -> AssemblyAI
    audioStream.pipe(audioTransform).pipe(transcriber.stream());
    
    console.log(`✅ [STREAMING] Audio stream connected for user ${userId}`);
    
  } catch (error) {
    console.error(`❌ [STREAMING] Failed to connect audio stream for ${userId}:`, error);
    throw error;
  }
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
      console.warn(`⚠️ [STREAMING] No active transcriber found for session: ${sessionId}`);
      return null;
    }
    
    const { transcriber, data } = sessionData;
    
    // Close the transcriber
    if (data.isConnected) {
      await transcriber.close();
    }
    
    // Compile final transcript
    const finalTranscript = {
      sessionId,
      combinedText: data.transcripts.map(t => t.text).join(' '),
      transcripts: data.transcripts,
      participants: Array.from(data.participants.values()),
      statistics: {
        totalTranscripts: data.transcripts.length,
        totalWords: data.transcripts.reduce((sum, t) => sum + t.text.split(' ').length, 0),
        averageConfidence: data.transcripts.length > 0 
          ? data.transcripts.reduce((sum, t) => sum + t.confidence, 0) / data.transcripts.length * 100
          : 0,
        duration: Date.now() - data.startTime,
        participantCount: data.participants.size
      },
      metadata: {
        startTime: data.startTime,
        endTime: Date.now(),
        assemblySessionId: data.assemblySessionId
      }
    };
    
    // Remove from active transcribers
    activeTranscribers.delete(sessionId);
    
    console.log(`✅ [STREAMING] Transcription completed for session: ${sessionId}`);
    console.log(`📊 [STREAMING] Final stats: ${finalTranscript.statistics.totalWords} words, ${finalTranscript.statistics.participantCount} participants`);
    
    return finalTranscript;
    
  } catch (error) {
    console.error(`❌ [STREAMING] Failed to stop transcription for ${sessionId}:`, error);
    throw error;
  }
}

/**
 * Get active transcription sessions
 * @returns {Array} Array of active session IDs
 */
export function getActiveTranscribers() {
  return Array.from(activeTranscribers.keys());
}

/**
 * Get transcription statistics for monitoring
 * @returns {Object} Statistics object
 */
export function getStreamingStats() {
  return {
    activeTranscribers: activeTranscribers.size,
    sessions: Array.from(activeTranscribers.entries()).map(([sessionId, data]) => ({
      sessionId,
      isConnected: data.data.isConnected,
      transcriptCount: data.data.transcripts.length,
      participantCount: data.data.participants.size,
      duration: Date.now() - data.data.startTime
    }))
  };
}