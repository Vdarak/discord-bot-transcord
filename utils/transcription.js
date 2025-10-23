import axios from 'axios';
import { promises as fs } from 'fs';
import { config } from '../config.js';

/**
 * AssemblyAI Transcription Service
 * Handles file uploads, transcription requests, and result polling
 */

// Rate limiting and request management
const activeTranscriptions = new Map();
let concurrentRequests = 0;

/**
 * Uploads an audio file to AssemblyAI
 * @param {string} filePath - Path to the WAV file
 * @returns {Promise<string>} Upload URL
 */
export async function uploadAudioFile(filePath) {
  try {
    console.log(`📤 Uploading audio file: ${filePath}`);
    
    // Check concurrent request limit
    if (concurrentRequests >= config.assemblyAI.maxConcurrent) {
      throw new Error(`Rate limit exceeded. Maximum ${config.assemblyAI.maxConcurrent} concurrent requests allowed.`);
    }
    
    concurrentRequests++;
    
    // Read file as buffer
    const audioData = await fs.readFile(filePath);
    console.log(`📊 File size: ${(audioData.length / 1024 / 1024).toFixed(2)} MB`);
    
    // Upload to AssemblyAI
    const uploadResponse = await axios.post(
      `${config.assemblyAI.baseUrl}${config.assemblyAI.uploadEndpoint}`,
      audioData,
      {
        headers: {
          'authorization': config.apis.assemblyAI,
          'content-type': 'application/octet-stream'
        },
        timeout: config.assemblyAI.timeout,
        maxContentLength: config.recording.maxFileSizeMB * 1024 * 1024
      }
    );
    
    const uploadUrl = uploadResponse.data.upload_url;
    console.log(`✅ File uploaded successfully. Upload URL: ${uploadUrl.substring(0, 50)}...`);
    
    return uploadUrl;
    
  } catch (error) {
    console.error('❌ File upload failed:', error.response?.data || error.message);
    throw new Error(`AssemblyAI upload failed: ${error.response?.data?.error || error.message}`);
  } finally {
    concurrentRequests--;
  }
}

/**
 * Creates a transcription request
 * @param {string} uploadUrl - AssemblyAI upload URL
 * @param {Object} options - Transcription options
 * @returns {Promise<string>} Transcript ID
 */
export async function createTranscriptionRequest(uploadUrl, options = {}) {
  try {
    console.log(`🎯 Creating transcription request for: ${uploadUrl.substring(0, 50)}...`);
    
    // Check concurrent request limit
    if (concurrentRequests >= config.assemblyAI.maxConcurrent) {
      throw new Error(`Rate limit exceeded. Maximum ${config.assemblyAI.maxConcurrent} concurrent requests allowed.`);
    }
    
    concurrentRequests++;
    
    const transcriptRequest = {
      audio_url: uploadUrl,
      speech_model: config.assemblyAI.speechModel,
      speaker_labels: true,
      auto_chapters: false,
      summarization: false,
      sentiment_analysis: false,
      entity_detection: false,
      ...options
    };
    
    const response = await axios.post(
      `${config.assemblyAI.baseUrl}${config.assemblyAI.transcriptEndpoint}`,
      transcriptRequest,
      {
        headers: {
          'authorization': config.apis.assemblyAI,
          'content-type': 'application/json'
        },
        timeout: config.assemblyAI.timeout
      }
    );
    
    const transcriptId = response.data.id;
    console.log(`✅ Transcription request created. ID: ${transcriptId}`);
    
    // Track the transcription
    activeTranscriptions.set(transcriptId, {
      id: transcriptId,
      status: 'queued',
      createdAt: Date.now(),
      uploadUrl
    });
    
    return transcriptId;
    
  } catch (error) {
    console.error('❌ Transcription request failed:', error.response?.data || error.message);
    throw new Error(`AssemblyAI transcription request failed: ${error.response?.data?.error || error.message}`);
  } finally {
    concurrentRequests--;
  }
}

/**
 * Polls for transcription completion
 * @param {string} transcriptId - Transcript ID
 * @returns {Promise<Object>} Transcription result
 */
export async function pollTranscriptionResult(transcriptId) {
  try {
    console.log(`⏳ Polling transcription result: ${transcriptId}`);
    
    const startTime = Date.now();
    const maxWaitTime = config.assemblyAI.timeout;
    
    while (Date.now() - startTime < maxWaitTime) {
      // Check concurrent request limit
      if (concurrentRequests >= config.assemblyAI.maxConcurrent) {
        console.log('⚠️ Rate limit reached, waiting before next poll...');
        await new Promise(resolve => setTimeout(resolve, config.assemblyAI.pollingInterval));
        continue;
      }
      
      concurrentRequests++;
      
      try {
        const response = await axios.get(
          `${config.assemblyAI.baseUrl}${config.assemblyAI.transcriptEndpoint}/${transcriptId}`,
          {
            headers: {
              'authorization': config.apis.assemblyAI
            },
            timeout: 30000 // 30 second timeout for individual requests
          }
        );
        
        const result = response.data;
        
        // Update tracking
        if (activeTranscriptions.has(transcriptId)) {
          activeTranscriptions.get(transcriptId).status = result.status;
        }
        
        console.log(`📊 Transcription ${transcriptId} status: ${result.status}`);
        
        if (result.status === 'completed') {
          console.log(`✅ Transcription completed: ${transcriptId}`);
          activeTranscriptions.delete(transcriptId);
          return result;
        }
        
        if (result.status === 'error') {
          const error = result.error || 'Unknown transcription error';
          console.error(`❌ Transcription failed: ${transcriptId} - ${error}`);
          activeTranscriptions.delete(transcriptId);
          throw new Error(`Transcription failed: ${error}`);
        }
        
        // Continue polling for 'queued' and 'processing' statuses
        
      } finally {
        concurrentRequests--;
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, config.assemblyAI.pollingInterval));
    }
    
    // Timeout reached
    activeTranscriptions.delete(transcriptId);
    throw new Error(`Transcription timeout: ${transcriptId} did not complete within ${maxWaitTime / 1000} seconds`);
    
  } catch (error) {
    console.error(`❌ Polling failed for ${transcriptId}:`, error.message);
    activeTranscriptions.delete(transcriptId);
    throw error;
  }
}

/**
 * Complete transcription workflow for a single file
 * @param {string} filePath - Path to WAV file
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @returns {Promise<Object>} Transcription result with metadata
 */
export async function transcribeAudioFile(filePath, userId, username) {
  try {
    console.log(`🎵 Starting transcription for ${username}: ${filePath}`);
    
    // Upload file
    const uploadUrl = await uploadAudioFile(filePath);
    
    // Create transcription request
    const transcriptId = await createTranscriptionRequest(uploadUrl);
    
    // Poll for results
    const result = await pollTranscriptionResult(transcriptId);
    
    // Format result with metadata
    const transcriptionResult = {
      userId,
      username,
      transcriptId,
      text: result.text || '',
      confidence: result.confidence || 0,
      audioUrl: result.audio_url,
      status: result.status,
      languageModel: result.language_model,
      acousticModel: result.acoustic_model,
      audioStartFrom: result.audio_start_from,
      audioEndAt: result.audio_end_at,
      audioDuration: result.audio_duration,
      punctuate: result.punctuate,
      formatText: result.format_text,
      words: result.words || [],
      utterances: result.utterances || [],
      speakerLabels: result.speaker_labels || false,
      filePath,
      processedAt: Date.now()
    };
    
    console.log(`✅ Transcription completed for ${username}: ${result.text?.length || 0} characters`);
    
    return transcriptionResult;
    
  } catch (error) {
    console.error(`❌ Transcription failed for ${username}:`, error.message);
    
    return {
      userId,
      username,
      transcriptId: null,
      text: '',
      confidence: 0,
      error: error.message,
      status: 'error',
      filePath,
      processedAt: Date.now()
    };
  }
}

/**
 * Transcribes multiple audio files concurrently
 * @param {Array} wavFiles - Array of WAV file information objects
 * @returns {Promise<Array>} Array of transcription results
 */
export async function transcribeMultipleFiles(wavFiles) {
  console.log(`🎵 Starting batch transcription for ${wavFiles.length} files`);
  
  const transcriptionPromises = wavFiles.map(wavFile => 
    transcribeAudioFile(wavFile.wavFilePath, wavFile.userId, wavFile.username)
  );
  
  // Process all transcriptions concurrently (limited by maxConcurrent)
  const results = await Promise.all(transcriptionPromises);
  
  // Separate successful and failed transcriptions
  const successful = results.filter(result => result.status !== 'error' && result.text);
  const failed = results.filter(result => result.status === 'error' || !result.text);
  
  console.log(`✅ Batch transcription completed: ${successful.length} successful, ${failed.length} failed`);
  
  if (failed.length > 0) {
    console.warn('⚠️ Failed transcriptions:');
    failed.forEach(result => {
      console.warn(`   - ${result.username}: ${result.error || 'No text generated'}`);
    });
  }
  
  return {
    successful,
    failed,
    total: results.length
  };
}

/**
 * Combines multiple transcription results into a single meeting transcript
 * @param {Array} transcriptionResults - Array of successful transcription results
 * @param {Object} meetingMetadata - Meeting metadata (start time, duration, etc.)
 * @returns {Object} Combined transcript with metadata
 */
export function combineTranscripts(transcriptionResults, meetingMetadata = {}) {
  console.log(`📝 Combining ${transcriptionResults.length} transcripts into meeting transcript`);
  
  if (transcriptionResults.length === 0) {
    return {
      combinedText: 'No transcriptions available.',
      participants: [],
      totalDuration: 0,
      totalWords: 0,
      averageConfidence: 0,
      meetingMetadata
    };
  }
  
  // Sort by user for consistent ordering
  const sortedResults = transcriptionResults.sort((a, b) => 
    a.username.localeCompare(b.username)
  );
  
  // Build combined transcript
  const transcriptSections = sortedResults.map(result => {
    const wordCount = result.words?.length || result.text.split(' ').length;
    const duration = result.audioDuration || 0;
    
    return {
      speaker: result.username,
      userId: result.userId,
      text: result.text.trim(),
      confidence: result.confidence,
      wordCount,
      duration
    };
  }).filter(section => section.text.length > 0);
  
  // Format combined text
  const combinedText = transcriptSections
    .map(section => `Speaker [${section.speaker}]: ${section.text}`)
    .join('\\n\\n');
  
  // Calculate statistics
  const totalWords = transcriptSections.reduce((sum, section) => sum + section.wordCount, 0);
  const totalDuration = transcriptSections.reduce((sum, section) => sum + section.duration, 0);
  const averageConfidence = transcriptSections.length > 0 
    ? transcriptSections.reduce((sum, section) => sum + section.confidence, 0) / transcriptSections.length
    : 0;
  
  const combinedTranscript = {
    combinedText,
    sections: transcriptSections,
    participants: sortedResults.map(result => ({
      userId: result.userId,
      username: result.username,
      wordCount: result.words?.length || result.text.split(' ').length,
      confidence: result.confidence,
      duration: result.audioDuration || 0
    })),
    statistics: {
      totalParticipants: transcriptSections.length,
      totalWords,
      totalDuration,
      averageConfidence: Math.round(averageConfidence * 100) / 100,
      longestSpeech: Math.max(...transcriptSections.map(s => s.wordCount), 0),
      shortestSpeech: Math.min(...transcriptSections.map(s => s.wordCount), 0)
    },
    meetingMetadata: {
      ...meetingMetadata,
      transcribedAt: Date.now(),
      processingTime: Date.now() - (meetingMetadata.startTime || Date.now())
    }
  };
  
  console.log(`✅ Combined transcript created: ${totalWords} total words, ${transcriptSections.length} speakers`);
  
  return combinedTranscript;
}

/**
 * Gets current transcription service statistics
 * @returns {Object} Service statistics
 */
export function getTranscriptionStats() {
  return {
    activeTranscriptions: activeTranscriptions.size,
    concurrentRequests,
    maxConcurrent: config.assemblyAI.maxConcurrent,
    pollingInterval: config.assemblyAI.pollingInterval,
    timeout: config.assemblyAI.timeout,
    activeIds: Array.from(activeTranscriptions.keys())
  };
}

/**
 * Cancels all active transcriptions (cleanup on shutdown)
 */
export function cancelAllTranscriptions() {
  console.log(`🛑 Cancelling ${activeTranscriptions.size} active transcriptions`);
  activeTranscriptions.clear();
  concurrentRequests = 0;
}

export default {
  uploadAudioFile,
  createTranscriptionRequest,
  pollTranscriptionResult,
  transcribeAudioFile,
  transcribeMultipleFiles,
  combineTranscripts,
  getTranscriptionStats,
  cancelAllTranscriptions
};