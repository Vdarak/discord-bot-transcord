import { config, audioConfig } from '../config.js';
import { createStreamingTranscriber, connectAudioStream, stopStreamingTranscription, initializeStreamingClient } from './streamingTranscription.js';

/**
 * Streaming Audio Processing for Discord Voice Recording
 * Handles real-time audio capture and streaming transcription
 */

// Global state for active streaming sessions
export const activeStreamingSessions = new Map();

/**
 * Starts a streaming transcription session
 * @param {string} sessionId - Unique session identifier
 * @param {Object} connection - Discord voice connection
 * @param {Array} userIds - Array of user IDs to record
 * @returns {Promise<Object>} Session information
 */
export async function startStreamingSession(sessionId, connection, userIds) {
  try {
    console.log(`🎯 [STREAM-AUDIO] Starting streaming session: ${sessionId}`);
    console.log(`👥 [STREAM-AUDIO] Recording ${userIds.length} users`);
    
    // Initialize AssemblyAI client if needed
    initializeStreamingClient();
    
    // Create streaming transcriber
    const transcriber = await createStreamingTranscriber(sessionId, {
      sampleRate: audioConfig.sampleRate,
      channels: audioConfig.channels,
      formatTurns: true,
      punctuate: true,
      disfluencies: false,
      speakerLabels: true
    });
    
    // Connect transcriber
    await transcriber.connect();
    
    // Set up audio streams for each user
    const userStreams = new Map();
    
    for (const userId of userIds) {
      try {
        console.log(`🔗 [STREAM-AUDIO] Setting up stream for user: ${userId}`);
        
        // Subscribe to user's audio stream
        const audioStream = connection.receiver.subscribe(userId, {
          end: { behavior: 'manual' }
        });
        
        // Add debugging for audio data
        let dataReceived = false;
        audioStream.on('data', (chunk) => {
          if (!dataReceived) {
            console.log(`🔊 [STREAM-AUDIO] First audio data from ${userId}: ${chunk.length} bytes`);
            dataReceived = true;
          }
        });
        
        // Set up timeout to check for audio
        setTimeout(() => {
          if (!dataReceived) {
            console.warn(`⚠️ [STREAM-AUDIO] No audio from ${userId} after 10 seconds`);
          }
        }, 10000);
        
        // Connect audio stream to transcriber
        await connectAudioStream(sessionId, audioStream, userId);
        
        userStreams.set(userId, {
          audioStream,
          dataReceived: false,
          startTime: Date.now()
        });
        
        console.log(`✅ [STREAM-AUDIO] User ${userId} connected to streaming transcription`);
        
      } catch (error) {
        console.error(`❌ [STREAM-AUDIO] Failed to set up stream for user ${userId}:`, error);
      }
    }
    
    // Store session information
    const sessionInfo = {
      sessionId,
      connection,
      transcriber,
      userStreams,
      startTime: Date.now(),
      active: true
    };
    
    activeStreamingSessions.set(sessionId, sessionInfo);
    
    console.log(`✅ [STREAM-AUDIO] Streaming session started: ${sessionId} with ${userStreams.size} active streams`);
    
    return sessionInfo;
    
  } catch (error) {
    console.error(`❌ [STREAM-AUDIO] Failed to start streaming session ${sessionId}:`, error);
    throw error;
  }
}

/**
 * Stops a streaming transcription session and returns the transcript
 * @param {string} sessionId - Session identifier
 * @returns {Promise<Object>} Final transcript data
 */
export async function stopStreamingSession(sessionId) {
  try {
    console.log(`⏹️ [STREAM-AUDIO] Stopping streaming session: ${sessionId}`);
    
    const sessionInfo = activeStreamingSessions.get(sessionId);
    if (!sessionInfo) {
      console.warn(`⚠️ [STREAM-AUDIO] Session not found: ${sessionId}`);
      return null;
    }
    
    // Stop all user audio streams
    for (const [userId, streamInfo] of sessionInfo.userStreams) {
      try {
        streamInfo.audioStream.destroy();
        console.log(`✅ [STREAM-AUDIO] Stopped stream for user: ${userId}`);
      } catch (error) {
        console.error(`❌ [STREAM-AUDIO] Error stopping stream for ${userId}:`, error);
      }
    }
    
    // Stop the streaming transcription
    const finalTranscript = await stopStreamingTranscription(sessionId);
    
    // Mark session as inactive
    sessionInfo.active = false;
    
    // Remove from active sessions
    activeStreamingSessions.delete(sessionId);
    
    const duration = Date.now() - sessionInfo.startTime;
    console.log(`✅ [STREAM-AUDIO] Session ${sessionId} stopped. Duration: ${Math.round(duration/1000)}s`);
    
    return finalTranscript;
    
  } catch (error) {
    console.error(`❌ [STREAM-AUDIO] Failed to stop streaming session ${sessionId}:`, error);
    throw error;
  }
}

/**
 * Adds a new user to an existing streaming session
 * @param {string} sessionId - Session identifier
 * @param {string} userId - User ID to add
 * @returns {Promise<boolean>} Success status
 */
export async function addUserToStreamingSession(sessionId, userId) {
  try {
    console.log(`➕ [STREAM-AUDIO] Adding user ${userId} to session ${sessionId}`);
    
    const sessionInfo = activeStreamingSessions.get(sessionId);
    if (!sessionInfo || !sessionInfo.active) {
      console.warn(`⚠️ [STREAM-AUDIO] No active session found: ${sessionId}`);
      return false;
    }
    
    // Check if user is already in session
    if (sessionInfo.userStreams.has(userId)) {
      console.log(`ℹ️ [STREAM-AUDIO] User ${userId} already in session`);
      return true;
    }
    
    // Subscribe to new user's audio stream
    const audioStream = sessionInfo.connection.receiver.subscribe(userId, {
      end: { behavior: 'manual' }
    });
    
    // Connect to transcriber
    await connectAudioStream(sessionId, audioStream, userId);
    
    // Add to session
    sessionInfo.userStreams.set(userId, {
      audioStream,
      dataReceived: false,
      startTime: Date.now()
    });
    
    console.log(`✅ [STREAM-AUDIO] User ${userId} added to session ${sessionId}`);
    return true;
    
  } catch (error) {
    console.error(`❌ [STREAM-AUDIO] Failed to add user ${userId} to session:`, error);
    return false;
  }
}

/**
 * Removes a user from a streaming session
 * @param {string} sessionId - Session identifier  
 * @param {string} userId - User ID to remove
 * @returns {Promise<boolean>} Success status
 */
export async function removeUserFromStreamingSession(sessionId, userId) {
  try {
    console.log(`➖ [STREAM-AUDIO] Removing user ${userId} from session ${sessionId}`);
    
    const sessionInfo = activeStreamingSessions.get(sessionId);
    if (!sessionInfo) {
      return false;
    }
    
    const streamInfo = sessionInfo.userStreams.get(userId);
    if (!streamInfo) {
      return false;
    }
    
    // Stop the user's audio stream
    streamInfo.audioStream.destroy();
    
    // Remove from session
    sessionInfo.userStreams.delete(userId);
    
    console.log(`✅ [STREAM-AUDIO] User ${userId} removed from session`);
    return true;
    
  } catch (error) {
    console.error(`❌ [STREAM-AUDIO] Failed to remove user ${userId}:`, error);
    return false;
  }
}

/**
 * Gets information about active streaming sessions
 * @returns {Object} Session statistics
 */
export function getStreamingSessionStats() {
  const sessions = Array.from(activeStreamingSessions.values());
  
  return {
    activeSessions: sessions.length,
    totalStreams: sessions.reduce((sum, session) => sum + session.userStreams.size, 0),
    sessions: sessions.map(session => ({
      sessionId: session.sessionId,
      userCount: session.userStreams.size,
      duration: Date.now() - session.startTime,
      active: session.active
    }))
  };
}

/**
 * Gets current recording status for streaming sessions
 * @returns {Object|null} Current recording status or null if not recording
 */
export function getCurrentStreamingStatus() {
  const activeSessions = Array.from(activeStreamingSessions.values()).filter(s => s.active);
  
  if (activeSessions.length === 0) {
    return null;
  }
  
  // Return info about the most recent session
  const currentSession = activeSessions[activeSessions.length - 1];
  
  return {
    sessionId: currentSession.sessionId,
    participants: currentSession.userStreams.size,
    duration: Date.now() - currentSession.startTime,
    active: currentSession.active,
    startTime: currentSession.startTime
  };
}

/**
 * Validates streaming audio configuration
 * @returns {boolean} True if configuration is valid
 */
export function validateStreamingConfig() {
  const errors = [];
  
  if (!config.apis.assemblyAI) {
    errors.push('AssemblyAI API key not configured');
  }
  
  if (!audioConfig.sampleRate || audioConfig.sampleRate < 16000) {
    errors.push('Invalid sample rate configuration');
  }
  
  if (errors.length > 0) {
    console.error('❌ [STREAM-AUDIO] Configuration errors:', errors);
    return false;
  }
  
  console.log('✅ [STREAM-AUDIO] Configuration validated');
  return true;
}