import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { config } from '../config.js';

/**
 * File Cleanup and Management Utilities
 * Handles temporary file creation, monitoring, and cleanup operations
 */

// Track all created files for cleanup
const trackedFiles = new Set();
const cleanupTasks = [];

/**
 * Ensures a directory exists, creates it if it doesn't
 * @param {string} dirPath - Directory path to ensure
 * @returns {Promise<void>}
 */
export async function ensureDirectoryExists(dirPath) {
  try {
    await fs.access(dirPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`📁 Creating directory: ${dirPath}`);
      await fs.mkdir(dirPath, { recursive: true });
    } else {
      throw error;
    }
  }
}

/**
 * Gets file size in MB
 * @param {number} bytes - Size in bytes
 * @returns {number} Size in MB
 */
export function getFileSizeInMB(bytes) {
  return bytes / (1024 * 1024);
}

/**
 * Checks if a file exists and gets its stats
 * @param {string} filePath - Path to file
 * @returns {Promise<Object|null>} File stats or null if doesn't exist
 */
export async function getFileInfo(filePath) {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    
    const stats = await fs.stat(filePath);
    return {
      path: filePath,
      size: stats.size,
      sizeMB: getFileSizeInMB(stats.size),
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime
    };
  } catch (error) {
    console.warn(`⚠️ Could not get file info for ${filePath}:`, error.message);
    return null;
  }
}

/**
 * Tracks a file for automatic cleanup
 * @param {string} filePath - Path to track
 * @param {Object} options - Tracking options
 */
export function trackFile(filePath, options = {}) {
  const fileInfo = {
    path: filePath,
    createdAt: Date.now(),
    tracked: true,
    category: options.category || 'temp',
    metadata: options.metadata || {}
  };
  
  trackedFiles.add(fileInfo);
  console.log(`📌 Tracking file: ${path.basename(filePath)} (${fileInfo.category})`);
}

/**
 * Removes a file and stops tracking it
 * @param {string} filePath - Path to file to remove
 * @param {boolean} force - Force removal even if not tracked
 * @returns {Promise<boolean>} True if removed successfully
 */
export async function removeFile(filePath, force = false) {
  try {
    // Check if file exists
    if (!existsSync(filePath)) {
      console.log(`📄 File already removed: ${path.basename(filePath)}`);
      removeFromTracking(filePath);
      return true;
    }
    
    // Get file info for logging
    const info = await getFileInfo(filePath);
    
    // Remove the file
    await fs.unlink(filePath);
    
    // Remove from tracking
    removeFromTracking(filePath);
    
    const sizeInfo = info ? ` (${info.sizeMB.toFixed(2)} MB)` : '';
    console.log(`🗑️ File removed: ${path.basename(filePath)}${sizeInfo}`);
    
    return true;
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File already doesn't exist
      removeFromTracking(filePath);
      return true;
    }
    
    console.error(`❌ Failed to remove file ${filePath}:`, error.message);
    return false;
  }
}

/**
 * Removes a file from tracking without deleting it
 * @param {string} filePath - Path to stop tracking
 */
function removeFromTracking(filePath) {
  for (const fileInfo of trackedFiles) {
    if (fileInfo.path === filePath) {
      trackedFiles.delete(fileInfo);
      break;
    }
  }
}

/**
 * Removes multiple files
 * @param {Array} filePaths - Array of file paths
 * @param {Object} options - Cleanup options
 * @returns {Promise<Object>} Cleanup results
 */
export async function removeFiles(filePaths, options = {}) {
  console.log(`🧹 Cleaning up ${filePaths.length} files...`);
  
  const results = {
    removed: [],
    failed: [],
    total: filePaths.length
  };
  
  const removePromises = filePaths.map(async (filePath) => {
    const success = await removeFile(filePath, options.force);
    if (success) {
      results.removed.push(filePath);
    } else {
      results.failed.push(filePath);
    }
  });
  
  await Promise.all(removePromises);
  
  console.log(`✅ Cleanup completed: ${results.removed.length} removed, ${results.failed.length} failed`);
  
  if (results.failed.length > 0 && options.logFailures) {
    console.warn('⚠️ Failed to remove files:');
    results.failed.forEach(filePath => console.warn(`   - ${filePath}`));
  }
  
  return results;
}

/**
 * Cleans up files by category
 * @param {string} category - Category to clean up ('temp', 'audio', 'all')
 * @returns {Promise<Object>} Cleanup results
 */
export async function cleanupByCategory(category = 'all') {
  console.log(`🧹 Cleaning up files by category: ${category}`);
  
  const filesToCleanup = [];
  
  for (const fileInfo of trackedFiles) {
    if (category === 'all' || fileInfo.category === category) {
      filesToCleanup.push(fileInfo.path);
    }
  }
  
  if (filesToCleanup.length === 0) {
    console.log('✅ No files to cleanup');
    return { removed: [], failed: [], total: 0 };
  }
  
  return await removeFiles(filesToCleanup, { logFailures: true });
}

/**
 * Cleans up all tracked temporary files
 * @returns {Promise<Object>} Cleanup results
 */
export async function cleanupTempFiles() {
  return await cleanupByCategory('temp');
}

/**
 * Cleans up all audio files (PCM and WAV)
 * @returns {Promise<Object>} Cleanup results
 */
export async function cleanupAudioFiles() {
  return await cleanupByCategory('audio');
}

/**
 * Cleans up all tracked files
 * @returns {Promise<Object>} Cleanup results
 */
export async function cleanupAllFiles() {
  return await cleanupByCategory('all');
}

/**
 * Cleans up files related to a specific recording session
 * @param {Array} recordingInfos - Array of recording information objects
 * @returns {Promise<Object>} Cleanup results
 */
export async function cleanupRecordingFiles(recordingInfos) {
  console.log(`🧹 Cleaning up recording files for ${recordingInfos.length} recordings`);
  
  const filesToCleanup = [];
  
  for (const recording of recordingInfos) {
    // Add PCM file if exists
    if (recording.filePath) {
      filesToCleanup.push(recording.filePath);
    }
    
    // Add WAV file if exists
    if (recording.wavFilePath) {
      filesToCleanup.push(recording.wavFilePath);
    }
    
    // Add original PCM path if different
    if (recording.originalPcmPath && recording.originalPcmPath !== recording.filePath) {
      filesToCleanup.push(recording.originalPcmPath);
    }
  }
  
  // Remove duplicates
  const uniqueFiles = [...new Set(filesToCleanup)];
  
  return await removeFiles(uniqueFiles, { force: true, logFailures: true });
}

/**
 * Schedules automatic cleanup after a delay
 * @param {Array} filePaths - Files to cleanup
 * @param {number} delayMs - Delay in milliseconds
 * @param {string} reason - Reason for cleanup (for logging)
 */
export function scheduleCleanup(filePaths, delayMs = 60000, reason = 'scheduled') {
  console.log(`⏰ Scheduling cleanup of ${filePaths.length} files in ${delayMs / 1000}s (${reason})`);
  
  const cleanupTask = {
    id: Date.now(),
    files: [...filePaths],
    scheduledFor: Date.now() + delayMs,
    reason
  };
  
  cleanupTasks.push(cleanupTask);
  
  setTimeout(async () => {
    console.log(`🕐 Executing scheduled cleanup: ${reason}`);
    await removeFiles(cleanupTask.files, { force: true });
    
    // Remove from cleanup tasks
    const index = cleanupTasks.findIndex(task => task.id === cleanupTask.id);
    if (index > -1) {
      cleanupTasks.splice(index, 1);
    }
  }, delayMs);
  
  return cleanupTask.id;
}

/**
 * Cancels a scheduled cleanup task
 * @param {number} taskId - Task ID to cancel
 * @returns {boolean} True if task was found and cancelled
 */
export function cancelScheduledCleanup(taskId) {
  const index = cleanupTasks.findIndex(task => task.id === taskId);
  if (index > -1) {
    const task = cleanupTasks[index];
    cleanupTasks.splice(index, 1);
    console.log(`❌ Cancelled scheduled cleanup: ${task.reason}`);
    return true;
  }
  return false;
}

/**
 * Monitors disk space in temp directory
 * @returns {Promise<Object>} Disk space information
 */
export async function checkDiskSpace() {
  try {
    // Get temp directory stats
    const stats = await fs.stat(config.files.tempDir);
    
    // Count tracked files
    let totalTrackedSize = 0;
    let trackedFileCount = 0;
    
    for (const fileInfo of trackedFiles) {
      try {
        const info = await getFileInfo(fileInfo.path);
        if (info) {
          totalTrackedSize += info.size;
          trackedFileCount++;
        }
      } catch (error) {
        // File may have been removed
      }
    }
    
    return {
      tempDir: config.files.tempDir,
      trackedFiles: trackedFileCount,
      totalTrackedSize,
      totalTrackedSizeMB: getFileSizeInMB(totalTrackedSize),
      lastCheck: Date.now()
    };
    
  } catch (error) {
    console.warn('⚠️ Could not check disk space:', error.message);
    return {
      tempDir: config.files.tempDir,
      error: error.message,
      lastCheck: Date.now()
    };
  }
}

/**
 * Emergency cleanup - removes all files immediately
 * @returns {Promise<Object>} Cleanup results
 */
export async function emergencyCleanup() {
  console.log('🚨 EMERGENCY CLEANUP - Removing all tracked files immediately');
  
  const allFiles = Array.from(trackedFiles).map(fileInfo => fileInfo.path);
  
  // Cancel all scheduled cleanups
  cleanupTasks.splice(0, cleanupTasks.length);
  
  // Remove all files immediately
  const results = await removeFiles(allFiles, { force: true, logFailures: true });
  
  // Clear tracking
  trackedFiles.clear();
  
  console.log('🚨 Emergency cleanup completed');
  
  return results;
}

/**
 * Gets current cleanup statistics
 * @returns {Object} Cleanup statistics
 */
export function getCleanupStats() {
  return {
    trackedFiles: trackedFiles.size,
    scheduledTasks: cleanupTasks.length,
    categories: getTrackedFilesByCategory(),
    nextScheduledCleanup: cleanupTasks.length > 0 
      ? Math.min(...cleanupTasks.map(task => task.scheduledFor)) 
      : null
  };
}

/**
 * Gets tracked files grouped by category
 * @returns {Object} Files grouped by category
 */
function getTrackedFilesByCategory() {
  const categories = {};
  
  for (const fileInfo of trackedFiles) {
    const category = fileInfo.category || 'unknown';
    if (!categories[category]) {
      categories[category] = 0;
    }
    categories[category]++;
  }
  
  return categories;
}

/**
 * Sets up cleanup handlers for process termination
 */
export function setupCleanupHandlers() {
  const cleanup = async (signal) => {
    console.log(`\\n🛑 Received ${signal}, cleaning up files...`);
    await emergencyCleanup();
    process.exit(0);
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGUSR1', cleanup);
  process.on('SIGUSR2', cleanup);
  
  // Cleanup on uncaught exceptions
  process.on('uncaughtException', async (error) => {
    console.error('💥 Uncaught exception:', error);
    await emergencyCleanup();
    process.exit(1);
  });
  
  process.on('unhandledRejection', async (reason, promise) => {
    console.error('💥 Unhandled rejection at:', promise, 'reason:', reason);
    await emergencyCleanup();
    process.exit(1);
  });
  
  console.log('✅ Cleanup handlers registered');
}

export default {
  ensureDirectoryExists,
  getFileSizeInMB,
  getFileInfo,
  trackFile,
  removeFile,
  removeFiles,
  cleanupByCategory,
  cleanupTempFiles,
  cleanupAudioFiles,
  cleanupAllFiles,
  cleanupRecordingFiles,
  scheduleCleanup,
  cancelScheduledCleanup,
  checkDiskSpace,
  emergencyCleanup,
  getCleanupStats,
  setupCleanupHandlers
};