import { createWriteStream, createReadStream, promises as fs } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
import path from 'path';
import prism from 'prism-media';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { config, audioConfig } from '../config.js';
import { ensureDirectoryExists, getFileSizeInMB } from './cleanup.js';

const pipelineAsync = promisify(pipeline);

/**
 * Audio Processing Utilities for Discord Voice Recording
 * Handles voice connection management, audio stream processing, and file conversion
 */

// Global state for active recordings
export const activeRecordings = new Map();

/**
 * Creates a unique filename for user audio recordings
 * @param {string} userId - Discord user ID
 * @param {string} extension - File extension (pcm, wav)
 * @returns {string} Formatted filename
 */
export function createAudioFilename(userId, extension = 'pcm') {
  const timestamp = Date.now();
  return `${userId}_${timestamp}.${extension}`;
}

/**
 * Gets the full file path for audio files in temp directory
 * @param {string} filename - The filename
 * @returns {string} Full file path
 */
export function getAudioFilePath(filename) {
  return path.join(config.files.tempDir, filename);
}

/**
 * Creates and configures an audio stream for recording a user's voice
 * @param {Object} connection - Discord voice connection
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username for logging
 * @returns {Promise<Object>} Recording stream information
 */
export async function createUserAudioStream(connection, userId, username) {
  try {
    console.log(`🎤 Starting audio stream for user: ${username} (${userId})`);
    
    // Ensure temp directory exists
    await ensureDirectoryExists(config.files.tempDir);
    
    // Create unique filename for this user's recording
    const filename = createAudioFilename(userId, 'pcm');
    const filePath = getAudioFilePath(filename);
    
    // Subscribe to user's audio stream
    const audioStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: 'manual'
      }
    });
    
    // Add debugging for Discord voice policy
    let dataReceived = false;
    audioStream.on('data', (chunk) => {
      if (!dataReceived) {
        console.log(`🔊 First audio data received from ${username} (${chunk.length} bytes)`);
        dataReceived = true;
      }
    });
    
    // Timeout to check if we're receiving audio data
    setTimeout(() => {
      if (!dataReceived) {
        console.warn(`⚠️ No audio data received from ${username} after 10 seconds. This may be due to:`);
        console.warn(`   - User not speaking actively`);
        console.warn(`   - Discord privacy settings`);
        console.warn(`   - Voice channel permissions`);
        console.warn(`   - Bot voice connection issues`);
      }
    }, 10000);
    
    // Create opus decoder
    const opusDecoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: audioConfig.channels,
      rate: audioConfig.sampleRate
    });
    
    // Create write stream for PCM data
    const writeStream = createWriteStream(filePath);
    
    // Set up error handling for streams
    audioStream.on('error', (error) => {
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(`❌ Audio stream error for ${username}:`, error);
      }
    });
    
    opusDecoder.on('error', (error) => {
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(`❌ Opus decoder error for ${username}:`, error);
      }
    });
    
    writeStream.on('error', (error) => {
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(`❌ Write stream error for ${username}:`, error);
      }
    });
    
    // Pipeline: Discord Audio Stream -> Opus Decoder -> PCM File
    const streamPipeline = pipelineAsync(
      audioStream,
      opusDecoder,
      writeStream
    ).catch(error => {
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error(`❌ Stream pipeline error for ${username}:`, error);
      }
    });
    
    const streamInfo = {
      userId,
      username,
      filename,
      filePath,
      audioStream,
      opusDecoder,
      writeStream,
      pipeline: streamPipeline,
      startTime: Date.now(),
      active: true
    };
    
    // Store in active recordings
    activeRecordings.set(userId, streamInfo);
    
    console.log(`✅ Audio stream created for ${username}: ${filename}`);
    return streamInfo;
    
  } catch (error) {
    console.error(`❌ Failed to create audio stream for ${username}:`, error);
    throw error;
  }
}

/**
 * Stops recording for a specific user
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object|null>} Stream info if found, null otherwise
 */
export async function stopUserRecording(userId) {
  const streamInfo = activeRecordings.get(userId);
  
  if (!streamInfo) {
    console.log(`⚠️ No active recording found for user: ${userId}`);
    return null;
  }
  
  try {
    console.log(`⏹️ Stopping recording for user: ${streamInfo.username}`);
    
    // Mark as inactive
    streamInfo.active = false;
    
    // End audio stream
    if (streamInfo.audioStream && !streamInfo.audioStream.destroyed) {
      streamInfo.audioStream.destroy();
    }
    
    // Close write stream
    if (streamInfo.writeStream && !streamInfo.writeStream.destroyed) {
      streamInfo.writeStream.end();
    }
    
    // Wait for pipeline to complete
    if (streamInfo.pipeline) {
      await streamInfo.pipeline;
    }
    
    // Calculate recording duration
    streamInfo.duration = Date.now() - streamInfo.startTime;
    streamInfo.endTime = Date.now();
    
    console.log(`✅ Recording stopped for ${streamInfo.username}. Duration: ${Math.round(streamInfo.duration / 1000)}s`);
    
    // Remove from active recordings
    activeRecordings.delete(userId);
    
    return streamInfo;
    
  } catch (error) {
    console.error(`❌ Error stopping recording for user ${userId}:`, error);
    // Still remove from active recordings even on error
    activeRecordings.delete(userId);
    return streamInfo;
  }
}

/**
 * Stops all active recordings
 * @returns {Promise<Array>} Array of stopped recording info
 */
export async function stopAllRecordings() {
  console.log(`⏹️ Stopping all active recordings (${activeRecordings.size} users)`);
  
  const stoppedRecordings = [];
  const stopPromises = [];
  
  for (const [userId] of activeRecordings) {
    stopPromises.push(
      stopUserRecording(userId).then(streamInfo => {
        if (streamInfo) {
          stoppedRecordings.push(streamInfo);
        }
      })
    );
  }
  
  await Promise.all(stopPromises);
  
  console.log(`✅ All recordings stopped. Total: ${stoppedRecordings.length} files`);
  return stoppedRecordings;
}

/**
 * Converts PCM file to WAV format for AssemblyAI compatibility
 * @param {string} pcmFilePath - Path to PCM file
 * @param {string} wavFilePath - Path for output WAV file
 * @returns {Promise<string>} Path to WAV file
 */
export async function convertPcmToWav(pcmFilePath, wavFilePath) {
  try {
    console.log(`🔄 Converting PCM to WAV: ${path.basename(pcmFilePath)}`);
    
    // Check if PCM file exists and has content
    const stats = await fs.stat(pcmFilePath);
    if (stats.size === 0) {
      throw new Error('PCM file is empty');
    }
    
    const fileSizeMB = getFileSizeInMB(stats.size);
    console.log(`📊 PCM file size: ${fileSizeMB.toFixed(2)} MB`);
    
    // Check file size limit
    if (fileSizeMB > config.recording.maxFileSizeMB) {
      throw new Error(`File size (${fileSizeMB.toFixed(2)} MB) exceeds limit (${config.recording.maxFileSizeMB} MB)`);
    }
    
    // Create FFmpeg transcoder with better error handling
    const transcoder = new prism.FFmpeg({
      args: [
        '-f', 's16le', // Input format: 16-bit little-endian PCM
        '-ar', audioConfig.sampleRate.toString(), // Sample rate
        '-ac', audioConfig.channels.toString(), // Channels
        '-i', 'pipe:0', // Input from stdin
        '-f', 'wav', // Output format: WAV
        '-acodec', 'pcm_s16le', // Audio codec
        '-y', // Overwrite output files
        wavFilePath // Output file
      ]
    });
    
    // Set up error handling for FFmpeg
    transcoder.on('error', (error) => {
      console.error(`❌ FFmpeg error:`, error);
    });
    
    // Create read stream from PCM file
    const readStream = createReadStream(pcmFilePath);
    
    // Pipeline: PCM File -> FFmpeg
    await pipelineAsync(
      readStream,
      transcoder
    );
    
    // Wait a bit for file system to sync
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify WAV file was created and has content
    let wavStats;
    try {
      wavStats = await fs.stat(wavFilePath);
      if (wavStats.size === 0) {
        throw new Error('WAV file is empty');
      }
    } catch (statError) {
      if (statError.code === 'ENOENT') {
        throw new Error('WAV file was not created by FFmpeg');
      }
      throw statError;
    }
    
    console.log(`✅ WAV conversion complete: ${path.basename(wavFilePath)} (${(wavStats.size / 1024 / 1024).toFixed(2)} MB)`);
    
    return wavFilePath;
    
  } catch (error) {
    console.error(`❌ PCM to WAV conversion failed:`, error);
    throw error;
  }
}

/**
 * Processes all recorded PCM files and converts them to WAV
 * @param {Array} recordingInfos - Array of recording information objects
 * @returns {Promise<Array>} Array of WAV file information
 */
export async function processAllRecordings(recordingInfos) {
  console.log(`🔄 Processing ${recordingInfos.length} recorded files`);
  
  const wavFiles = [];
  const conversionPromises = [];
  
  for (const recording of recordingInfos) {
    const wavFilename = recording.filename.replace('.pcm', '.wav');
    const wavFilePath = getAudioFilePath(wavFilename);
    
    const conversionPromise = convertPcmToWav(recording.filePath, wavFilePath)
      .then(() => {
        const wavInfo = {
          ...recording,
          wavFilename,
          wavFilePath,
          originalPcmPath: recording.filePath
        };
        wavFiles.push(wavInfo);
        return wavInfo;
      })
      .catch(error => {
        console.error(`❌ Failed to convert ${recording.filename}:`, error);
        // Return null for failed conversions
        return null;
      });
    
    conversionPromises.push(conversionPromise);
  }
  
  // Wait for all conversions to complete
  const results = await Promise.all(conversionPromises);
  
  // Filter out failed conversions
  const successfulConversions = results.filter(result => result !== null);
  
  console.log(`✅ Audio processing complete: ${successfulConversions.length}/${recordingInfos.length} files converted`);
  
  return successfulConversions;
}

/**
 * Validates audio stream configuration
 * @returns {boolean} True if configuration is valid
 */
export function validateAudioConfig() {
  const errors = [];
  
  if (audioConfig.sampleRate < 8000 || audioConfig.sampleRate > 48000) {
    errors.push('Sample rate must be between 8000 and 48000 Hz');
  }
  
  if (audioConfig.channels < 1 || audioConfig.channels > 2) {
    errors.push('Channels must be 1 (mono) or 2 (stereo)');
  }
  
  if (audioConfig.bitDepth !== 16) {
    errors.push('Bit depth must be 16 for compatibility');
  }
  
  if (errors.length > 0) {
    console.error('❌ Audio configuration validation failed:');
    errors.forEach(error => console.error(`   - ${error}`));
    return false;
  }
  
  return true;
}

/**
 * Gets current recording statistics
 * @returns {Object} Recording statistics
 */
export function getRecordingStats() {
  return {
    activeRecordings: activeRecordings.size,
    users: Array.from(activeRecordings.values()).map(recording => ({
      userId: recording.userId,
      username: recording.username,
      duration: Date.now() - recording.startTime,
      filename: recording.filename,
      active: recording.active
    }))
  };
}

/**
 * Monitors memory usage during recording
 * @returns {Object} Memory usage statistics
 */
export function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024), // MB
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
    external: Math.round(usage.external / 1024 / 1024), // MB
    activeRecordings: activeRecordings.size
  };
}

export default {
  createUserAudioStream,
  stopUserRecording,
  stopAllRecordings,
  convertPcmToWav,
  processAllRecordings,
  validateAudioConfig,
  getRecordingStats,
  getMemoryUsage,
  activeRecordings
};