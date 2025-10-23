import { Transform } from 'stream';
import { config } from '../config.js';
import { WebSocket } from 'ws';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Prism from 'prism-media';

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

    // Optionally prepare recording to disk
    const saveToDisk = options.saveToDisk || config.recording.saveToDisk || false;
    if (saveToDisk) {
      // Ensure recordings directory exists
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const recordingsDir = config.files && config.files.recordingsDir ? config.files.recordingsDir : join(__dirname, '..', 'recordings');
      try {
        await fsp.mkdir(recordingsDir, { recursive: true });
      } catch (err) {
        console.warn('⚠️ [STREAMING] Could not create recordings directory:', recordingsDir, err.message);
      }

      const rawPath = join(recordingsDir, `${sessionId}.pcm`);
      const wavPath = join(recordingsDir, `${sessionId}.wav`);
      const writeStream = fs.createWriteStream(rawPath, { flags: 'a' });
      transcriptionData.recording = {
        enabled: true,
        rawPath,
        wavPath,
        writeStream
      };
      console.log(`💾 [STREAMING] Recording enabled for session ${sessionId} -> ${rawPath}`);
    }

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
    
    // Create audio transform stream (stereo -> mono)
    const audioTransform = createAudioTransformStream(userId);

    // Many Discord voice receiver streams emit Opus packets, not raw PCM.
    // Decode Opus -> PCM using prism-media before transforming to mono.
    const opusDecoder = new Prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: data.sampleRate || 48000
    });

    // Pipe: opus (from Discord) -> opusDecoder (PCM stereo s16le) -> audioTransform (stereo->mono)
    audioStream.pipe(opusDecoder).pipe(audioTransform);

    // Create a chunking transform that accumulates PCM bytes until target duration is reached
    const chunkMs = 200; // default target chunk duration in milliseconds (between 50 and 1000)
    const sampleRate = data.sampleRate || 48000; // fallback if not provided
    const bytesPerSample = 2; // pcm_s16le -> 16-bit = 2 bytes per sample
    const bytesPerMs = Math.floor((sampleRate / 1000) * bytesPerSample);
    const targetBytes = Math.max( Math.round(bytesPerMs * 50), Math.min(Math.round(bytesPerMs * chunkMs), Math.round(bytesPerMs * 1000)) );

    const chunkBuffer = [];
    let bufferedBytes = 0;

    // Pipe audio through the mono transform, then handle buffering here
    audioStream.pipe(audioTransform);

    audioTransform.on('data', (chunk) => {
      try {
        // Accumulate chunk
        chunkBuffer.push(chunk);
        bufferedBytes += chunk.length;

        // If we've reached targetBytes (>=50ms worth), flush as one frame
        if (bufferedBytes >= targetBytes) {
          const frame = Buffer.concat(chunkBuffer, bufferedBytes);

          if (data.isConnected && websocket.readyState === WebSocket.OPEN) {
            websocket.send(frame, { binary: true });
            // Also write to disk if recording enabled
            try {
              if (data.recording && data.recording.enabled && data.recording.writeStream) {
                data.recording.writeStream.write(frame);
              }
            } catch (writeErr) {
              console.warn('⚠️ [STREAMING] Failed to write audio frame to disk:', writeErr.message);
            }
            console.log(`🔊 [STREAMING] Sent audio frame for ${userId}: ${bufferedBytes} bytes (~${(bufferedBytes/bytesPerMs).toFixed(1)} ms)`);
          } else {
            console.warn(`⚠️ [STREAMING] Skipping audio chunk - connection closed for ${userId}`);
          }

          // reset buffer
          chunkBuffer.length = 0;
          bufferedBytes = 0;
        }
      } catch (error) {
        console.error(`❌ [STREAMING] Error sending audio for ${userId}:`, error);
        // Reset buffer on error to avoid growing indefinitely
        chunkBuffer.length = 0;
        bufferedBytes = 0;
      }
    });

    audioTransform.on('end', () => {
      // Flush any remaining buffered audio (if within allowed duration)
      try {
        if (bufferedBytes > 0) {
          const frame = Buffer.concat(chunkBuffer, bufferedBytes);
          if (data.isConnected && websocket.readyState === WebSocket.OPEN) {
            websocket.send(frame, { binary: true });
            // write final to disk if enabled
            try {
              if (data.recording && data.recording.enabled && data.recording.writeStream) {
                data.recording.writeStream.write(frame);
              }
            } catch (writeErr) {
              console.warn('⚠️ [STREAMING] Failed to write final audio frame to disk:', writeErr.message);
            }
            console.log(`🔊 [STREAMING] Sent final audio frame for ${userId}: ${bufferedBytes} bytes (~${(bufferedBytes/bytesPerMs).toFixed(1)} ms)`);
          } else {
            console.warn(`⚠️ [STREAMING] Skipping final audio chunk - connection closed for ${userId}`);
          }
        }
      } catch (error) {
        console.error(`❌ [STREAMING] Error flushing final audio for ${userId}:`, error);
      }

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

    // If recording was enabled, finalize the raw PCM to WAV
    if (data.recording && data.recording.enabled) {
      try {
        // Close the raw write stream first
        if (data.recording.writeStream && typeof data.recording.writeStream.end === 'function') {
          data.recording.writeStream.end();
        }

        // Create WAV file from raw PCM
        await finalizeWavFile(data.recording.rawPath, data.recording.wavPath, /*channels*/1, /*sampleRate*/(data.sampleRate || 48000), /*bitDepth*/16);
        console.log(`💾 [STREAMING] Finalized WAV: ${data.recording.wavPath}`);
      } catch (recErr) {
        console.error('❌ [STREAMING] Error finalizing recording to WAV:', recErr);
      }
    }

    // Remove from active transcribers
    activeTranscribers.delete(sessionId);

    const combinedText = data.transcripts.map(t => t.text).join(' ').trim();
    const wordCount = data.transcripts.reduce((count, t) => count + (t.words?.length || 0), 0);
    const participantCount = data.participants ? data.participants.size : 0;

    // Compute average confidence if available
    const confidences = data.transcripts.map(t => t.confidence).filter(c => typeof c === 'number');
    const averageConfidence = confidences.length > 0 ? (confidences.reduce((a,b) => a+b, 0) / confidences.length) : 0;

    console.log(`✅ [STREAMING] Transcription completed for session: ${sessionId}`);
    console.log(`📊 [STREAMING] Final stats: ${wordCount} words, ${participantCount} participants`);

    // Build participants array (try to convert Map values to array)
    const participantsArray = [];
    if (data.participants && typeof data.participants.forEach === 'function') {
      data.participants.forEach((value, key) => {
        // value may be an object with name/metadata; normalize
        if (typeof value === 'string') {
          participantsArray.push({ id: key, name: value });
        } else if (value && typeof value === 'object') {
          participantsArray.push(Object.assign({ id: key }, value));
        } else {
          participantsArray.push({ id: key });
        }
      });
    }

    const finalTranscriptObject = {
      combinedText,
      transcripts: data.transcripts,
      participants: participantsArray,
      statistics: {
        totalWords: wordCount,
        participantCount,
        averageConfidence
      }
    };

    return {
      sessionId,
      transcripts: data.transcripts,
      participants: data.participants,
      combinedText,
      finalTranscript: finalTranscriptObject,
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
 * Finalize a raw PCM file into a WAV file (RIFF header + PCM data)
 * @param {string} rawPath - path to raw PCM file
 * @param {string} wavPath - destination WAV file path
 * @param {number} channels
 * @param {number} sampleRate
 * @param {number} bitDepth
 */
export async function finalizeWavFile(rawPath, wavPath, channels = 1, sampleRate = 48000, bitDepth = 16) {
  // Read raw file size
  try {
    const stat = await fsp.stat(rawPath);
    const dataSize = stat.size;

    const bytesPerSample = bitDepth / 8;
    const byteRate = sampleRate * channels * bytesPerSample;
    const blockAlign = channels * bytesPerSample;

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    // Create write stream for WAV and pipe raw data
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(wavPath);
      out.on('error', reject);
      out.on('finish', resolve);
      out.write(header);
      const readStream = fs.createReadStream(rawPath);
      readStream.on('error', reject);
      readStream.pipe(out);
    });
  } catch (error) {
    console.error('❌ [STREAMING] finalizeWavFile error:', error);
    throw error;
  }
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