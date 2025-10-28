import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { config, embedColors } from '../config.js';
import { getCurrentStreamingStatus } from '../utils/streamingAudioProcessor.js';
import { stopStreamingSession } from '../utils/streamingAudioProcessor.js';
import { generateMeetingSummary } from '../utils/summarizer.js';

/**
 * Stop Command - Stops streaming recording and processes transcription/summary
 */

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop the current recording and generate meeting summary')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function execute(interaction) {
  // Log interaction metadata immediately to help debug timing / unknown interaction issues
  try {
    const now = Date.now();
    console.log(`⚡ [INTERACTION META] id=${interaction.id} token=${interaction.token} created=${interaction.createdTimestamp} age=${now - interaction.createdTimestamp}ms`);
  } catch (metaErr) {
    console.warn('⚠️ [STOP] Could not read interaction metadata:', metaErr);
  }

  // Defer reply IMMEDIATELY to prevent timeout
  try {
    await interaction.deferReply({ flags: [] });
  } catch (error) {
    console.error('❌ [STOP] Failed to defer reply:', error);
    // If we can't defer, the interaction has likely timed out
    return;
  }

  try {
    console.log(`⏹️ [STOP] Stop command executed by ${interaction.user.tag} in ${interaction.guild.name}`);
    
    // Permission check
    if (!hasPermission(interaction)) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('❌ Permission Denied', 'You need "Manage Channels" permission or the required role to use this command.')]
      });
    }
    
    // Check if bot is recording
    const recordingStatus = getCurrentStreamingStatus();
    if (!recordingStatus) {
      return await interaction.editReply({
        embeds: [createErrorEmbed('⚠️ Not Recording', 'Bot is not currently recording. Use `/join` to start a recording first.')]
      });
    }
    // Track processing errors and results
    let processingError = null;
    let finalTranscript = null;
    let meetingSummary = null;
    
    // Send initial processing message
    const processingEmbed = new EmbedBuilder()
      .setColor(embedColors.warning)
      .setTitle('⏹️ Recording Stopped')
      .setDescription('Processing streaming transcription and generating summary...')
      .addFields(
        { name: '📊 Recording Stats', value: `Duration: ${formatDuration(recordingStatus.duration)}
Participants: ${recordingStatus.participants}`, inline: true },
  { name: '🔄 Processing Status', value: `• Stopping streaming transcription...\n• Compiling final transcript...\n• Generating AI summary...`, inline: false }
      )
      .setFooter({ text: 'Streaming transcription - processing is much faster!' })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [processingEmbed] });
    
    try {
      // Step 2: Stop streaming transcription and generate summary
      console.log('🔄 [STOP] Step 2: Stopping transcription and generating summary...');

      try {
        await updateProcessingProgress(interaction, 'Stopping transcription', '• Stopping streaming transcription...');
      } catch (e) {
        // non-fatal if progress update fails
        console.warn('⚠️ [STOP] Could not update progress before stopping transcription:', e.message);
      }

      try {
        // Stop the streaming session and gather the final transcript
        finalTranscript = await stopStreamingSession(recordingStatus.sessionId);
        console.log('✅ [STOP] Streaming transcription stopped, transcript collected');
      } catch (stopErr) {
        console.error('❌ [STOP] Error stopping streaming session:', stopErr);
        processingError = stopErr && stopErr.message ? stopErr.message : String(stopErr);
      }

      try {
        if (finalTranscript) {
          await updateProcessingProgress(interaction, 'Generating summary', '• Generating AI summary...');
          meetingSummary = await generateMeetingSummary(finalTranscript, { duration: recordingStatus.duration, startTime: recordingStatus.startTime, endTime: Date.now() });
          console.log('✅ [STOP] Meeting summary generated');
        } else {
          console.warn('⚠️ [STOP] No final transcript available; skipping AI summary generation');
        }
      } catch (genErr) {
        console.error('❌ [STOP] Error generating meeting summary:', genErr);
        processingError = processingError || (genErr && genErr.message ? genErr.message : String(genErr));
      }

      // Step 3: Post results to summary channel (use explicit target channel)
      console.log('🔄 [STOP] Step 3: Posting results...');

  // Always post summaries to the canonical summary channel ID requested
  const targetChannelId = '1431024855385374802';
  const summaryChannel = await interaction.client.channels.fetch(targetChannelId);
  const transcriptChannelId = config.discord.transcriptChannelId || '1432537458993528923';
  const transcriptChannel = await interaction.client.channels.fetch(transcriptChannelId);
      if (!summaryChannel) throw new Error(`Summary channel not found: ${targetChannelId}`);
    if (!transcriptChannel) console.warn(`⚠️ Transcript channel not found: ${transcriptChannelId} - will attempt to send to summary channel instead`);

      // Reset presence to idle (best-effort)
      try {
        const { setBotState } = await import('../utils/presence.js');
        await setBotState(interaction.client, 'idle', interaction.guild.id);
      } catch (e) {
        console.warn('⚠️ [STOP] Could not reset presence:', e.message);
      }

      // Helper: split long text into chunks under Discord limit (2000 chars)
      function splitTextIntoChunks(text, maxLen = 2000) {
        if (!text) return [];
        const paragraphs = text.split('\n\n');
        const chunks = [];
        let current = '';
        for (const para of paragraphs) {
          const candidate = current ? (current + '\n\n' + para) : para;
          if (candidate.length > maxLen) {
            if (current) {
              chunks.push(current);
              current = '';
            }
            if (para.length > maxLen) {
              for (let i = 0; i < para.length; i += maxLen) {
                chunks.push(para.slice(i, i + maxLen));
              }
            } else {
              current = para;
            }
          } else {
            current = candidate;
          }
        }
        if (current) chunks.push(current);
        return chunks;
      }

      async function sendLongMessage(channel, text) {
        const chunks = splitTextIntoChunks(text, 2000);
        if (chunks.length === 0) return null;
        let last = null;
        for (const c of chunks) {
          last = await channel.send({ content: c });
        }
        return last;
      }

      // Try to send the summary as a single "post" (single message). If too large, send the first post
      // then subsequent continuation posts. Use paragraph-aware splitting to avoid breaking numbering.
      async function sendAsPostThenContinue(channel, text) {
        if (!text) return null;

        // Use embed-friendly chunk size (embed description limit is 4096)
        const MAX_EMBED_DESC = 3800;
        const chunks = splitTextIntoChunks(text, MAX_EMBED_DESC);
        if (chunks.length === 0) return null;

        // Prepare metadata for embed footers
        const speakerCount = recordingStatus?.participants ?? (finalTranscript && Array.isArray(finalTranscript.participants) ? finalTranscript.participants.length : (finalTranscript?.statistics?.participantCount ?? 0));
        const durationStr = recordingStatus?.duration ? formatDuration(recordingStatus.duration) : (finalTranscript?.duration ? formatDuration(finalTranscript.duration) : 'Unknown');
        const startDate = recordingStatus?.startTime ? new Date(recordingStatus.startTime) : new Date();
        const dateStr = startDate.toLocaleDateString('en-US');

        // Send first chunk as an embed (styled post)
        const totalPages = chunks.length;
        const firstEmbed = new EmbedBuilder()
          .setColor(embedColors.summary || embedColors.success)
          .setDescription(chunks[0])
          .setFooter({ text: `${speakerCount} speakers • ${durationStr} • ${dateStr} • Page 1 of ${totalPages}` })
          .setTimestamp();

        let first = await channel.send({ embeds: [firstEmbed] });

        // Send remaining chunks as continuation embeds with footer page info
        for (let i = 1; i < chunks.length; i++) {
          const contEmbed = new EmbedBuilder()
            .setColor(embedColors.summary || embedColors.success)
            .setDescription(chunks[i])
            .setFooter({ text: `${speakerCount} speakers • ${durationStr} • ${dateStr} • Page ${i + 1} of ${totalPages}` })
            .setTimestamp();
          await channel.send({ embeds: [contEmbed] });
        }

        return first;
      }

      // Build summary content from the structured JSON returned by the summarizer
      let contentToPost = '';
      const rawSummary = typeof meetingSummary !== 'undefined' ? meetingSummary : null;

      // Try to obtain a structured object. If the model returned a JSON string, parse it.
      let summaryObj = null;
      if (!rawSummary) {
        contentToPost = 'No summary available.';
      } else if (typeof rawSummary === 'object') {
        summaryObj = rawSummary;
      } else if (typeof rawSummary === 'string') {
        try {
          summaryObj = JSON.parse(rawSummary);
        } catch (e) {
          // If parsing fails, fall back to using the raw string as a short summary
          contentToPost = rawSummary.trim().slice(0, 3800) || 'No summary available.';
        }
      }

      // If we have a structured object, render only the fields present in the JSON schema.
      if (summaryObj) {
        const parts = [];

        if (summaryObj.briefOverview && typeof summaryObj.briefOverview === 'string' && summaryObj.briefOverview.trim()) {
          parts.push(summaryObj.briefOverview.trim());
        }

        if (Array.isArray(summaryObj.chronologicalSections) && summaryObj.chronologicalSections.length > 0) {
          // Add a single section header (inline bold) before chronological bullets
          parts.push('Chronological Sections:');
          for (const sec of summaryObj.chronologicalSections) {
            const heading = sec.heading || sec.title || sec.timestamp || sec.speaker || null;
            if (heading) parts.push(`**${heading}**`);
            if (Array.isArray(sec.points) && sec.points.length > 0) {
              for (const p of sec.points) {
                if (p && String(p).trim()) parts.push(`• ${String(p).trim()}`);
              }
            } else if (sec.content && String(sec.content).trim()) {
              parts.push(`• ${String(sec.content).trim()}`);
            }
            // blank line between sections
            parts.push('');
          }
        }

        if (Array.isArray(summaryObj.actionItems) && summaryObj.actionItems.length > 0) {
          parts.push('Action Items:');
          for (const ai of summaryObj.actionItems) {
            if (typeof ai === 'string') {
              if (ai.trim()) parts.push(`• ${ai.trim()}`);
            } else if (ai && typeof ai === 'object') {
              const action = ai.action || ai.title || ai.task || '';
              const assignee = ai.assignee || ai.owner || ai.person || 'Unassigned';
              const due = ai.due || ai.dueDate || ai.due_at || null;
              const dueStr = due ? ` — Due: ${due}` : '';
              if (action) parts.push(`• ${action}${dueStr} — Assignee: ${assignee}`);
            }
          }
        }

        contentToPost = parts.join('\n');
        if (!contentToPost || contentToPost.trim().length === 0) contentToPost = 'No summary available.';
      }

      const firstSummaryMessage = await sendAsPostThenContinue(summaryChannel, contentToPost);
  try {
    if (firstSummaryMessage && typeof firstSummaryMessage.crosspost === 'function') {
      await firstSummaryMessage.crosspost();
      console.log(`✅ [STOP] Crossposted summary message in ${targetChannelId}`);
    }
  } catch (crossErr) {
    console.warn('⚠️ [STOP] Could not crosspost summary (channel may not be an Announcement channel or bot lacks permission):', crossErr.message);
  }

      // Attach raw transcript as a .txt file (safe for large text)
      try {
        const transcriptText = finalTranscript && finalTranscript.combinedText ? finalTranscript.combinedText : (typeof finalTranscript === 'string' ? finalTranscript : JSON.stringify(finalTranscript || {}, null, 2));
        const buffer = Buffer.from(transcriptText, 'utf-8');
        await summaryChannel.send({ files: [{ attachment: buffer, name: 'transcript.txt' }] });
      } catch (attachErr) {
        console.warn('⚠️ [STOP] Could not attach transcript file:', attachErr.message);
        // Fallback: send transcript as multiple messages (code blocks) capped to avoid spam
        try {
          const transcriptText = finalTranscript && finalTranscript.combinedText ? finalTranscript.combinedText : (typeof finalTranscript === 'string' ? finalTranscript : JSON.stringify(finalTranscript || {}, null, 2));
          const CHUNK_MAX = 1990;
          const chunks = splitTextIntoChunks(transcriptText, CHUNK_MAX);
          const MAX_CHUNKS = 50;
          if (chunks.length === 0) {
            await summaryChannel.send({ content: '⚠️ Transcript was empty and could not be attached.' });
          } else if (chunks.length > MAX_CHUNKS) {
            await summaryChannel.send({ content: `⚠️ Transcript is very large (${chunks.length} parts). Sending first ${MAX_CHUNKS} parts; the rest is truncated. Consider configuring cloud storage for large transcripts.` });
            for (let i = 0; i < MAX_CHUNKS; i++) await summaryChannel.send({ content: '```\n' + chunks[i] + '\n```' });
            await summaryChannel.send({ content: `⚠️ Transcript truncated after ${MAX_CHUNKS} parts.` });
          } else {
            await summaryChannel.send({ content: `⚠️ Could not attach transcript as a file. Falling back to sending the transcript in ${chunks.length} message(s).` });
            for (const c of chunks) await summaryChannel.send({ content: '```\n' + c + '\n```' });
            await summaryChannel.send({ content: '✅ Full transcript sent (split across multiple messages).' });
          }
        } catch (sendErr) {
          console.error('❌ [STOP] Failed to send transcript fallback messages:', sendErr);
          await summaryChannel.send({ content: '⚠️ Could not attach or send the full transcript due to size or permission limits. Please check bot logs or configure external storage (S3/Drive) for large transcripts.' });
        }
      }

      // Send status to designated status channel (if configured)
      try {
        const statusChannel = await interaction.client.channels.fetch(config.discord.statusChannelId);
        if (statusChannel && statusChannel.id !== summaryChannel.id) {
          const statusEmbed = new EmbedBuilder()
            .setColor(processingError ? embedColors.warning : embedColors.success)
            .setTitle('📝 Recording Processed')
            .setDescription('Meeting recording completed and summary generated')
            .addFields(
              { name: '📊 Stats', value: `Duration: ${formatDuration(recordingStatus.duration)}\nParticipants: ${recordingStatus.participants}`, inline: true },
              { name: '📝 Summary', value: `Posted in <#${targetChannelId}>`, inline: true }
            )
            .setTimestamp();
          await statusChannel.send({ embeds: [statusEmbed] });
        }
      } catch (err) {
        console.warn('⚠️ [STOP] Could not send status message:', err.message);
      }

      // Send completion message back to the user
      const totalWordsSafe = finalTranscript?.statistics?.totalWords ?? finalTranscript?.wordCount ?? 0;
  // Prefer the live streaming session participant count (Discord voice) as the authoritative value
  const participantCountSafe = recordingStatus?.participants ?? finalTranscript?.statistics?.participantCount ?? (Array.isArray(finalTranscript?.participants) ? finalTranscript.participants.length : (finalTranscript?.rawParticipantsMap ? Object.keys(finalTranscript.rawParticipantsMap).length : 0));
      const avgConfidenceSafe = typeof finalTranscript?.statistics?.averageConfidence === 'number' ? finalTranscript.statistics.averageConfidence : 0;

      const completionEmbed = new EmbedBuilder()
        .setColor(processingError ? embedColors.warning : embedColors.success)
        .setTitle(processingError ? '⚠️ Processing Completed with Errors' : '✅ Processing Complete')
        .setDescription(processingError ? `Recording processed with errors. Summary posted in <#${targetChannelId}>` : `Meeting summary successfully posted in <#${targetChannelId}>`)
        .addFields(
          { name: '📊 Final Statistics', value: finalTranscript ? `**Words:** ${totalWordsSafe}\n**Participants:** ${participantCountSafe}\n**Confidence:** ${avgConfidenceSafe.toFixed(1)}%` : 'No transcript data available', inline: true },
          { name: '⏱️ Processing Time', value: `${Math.round((Date.now() - recordingStatus.startTime) / 1000)}s total\n(Real-time streaming!)`, inline: true }
        )
        .setFooter({ text: processingError ? `Error: ${processingError}` : 'Streaming transcription completed successfully' })
        .setTimestamp();

      await interaction.editReply({ embeds: [completionEmbed] });
      console.log('✅ [STOP] Stop command completed successfully');

    } catch (postError) {
      console.error('❌ [STOP] Failed to post results:', postError);

      // If we lack access to the configured summary channel, attempt to notify in the status channel instead
      if (postError && postError.code === 50001) {
        try {
          const statusChannel = await interaction.client.channels.fetch(config.discord.statusChannelId);
          const fallbackEmbed = new EmbedBuilder()
            .setColor(embedColors.warning)
            .setTitle('⚠️ Summary Post Failed - Missing Access')
            .setDescription(`I couldn't post the meeting summary to the configured summary channel because I don't have access. The summary may be attached here instead if available.`)
            .addFields(
              { name: 'Session', value: recordingStatus.sessionId, inline: true },
              { name: 'Error', value: postError.message, inline: true }
            )
            .setTimestamp();

          if (statusChannel) {
            await statusChannel.send({ embeds: [fallbackEmbed] });
          }
        } catch (fallbackErr) {
          console.error('❌ [STOP] Failed to post fallback summary to status channel:', fallbackErr);
        }
      }

      const errorDescription = postError && postError.message ? postError.message : String(postError);
      const errorEmbed = new EmbedBuilder()
        .setColor(embedColors.error)
        .setTitle('❌ Processing Failed')
        .setDescription(`Failed to process recording: ${errorDescription}`)
        .addFields(
          { name: 'Error Code', value: postError && postError.code ? String(postError.code) : 'N/A', inline: true },
          { name: 'Context', value: `Session: ${recordingStatus.sessionId}`, inline: true }
        )
        .setTimestamp();

      try {
        await interaction.editReply({ embeds: [errorEmbed] });
      } catch (editErr) {
        console.error('❌ [STOP] Failed to edit reply with error embed:', editErr);
      }
    }
    
  } catch (error) {
    console.error('❌ [STOP] Fatal error in stop command:', error);
    // Let the global error handler in index.js manage the interaction response
    throw error;
  }
}

/**
 * Updates the processing progress message
 * @param {Object} interaction - Discord interaction
 * @param {string} currentStep - Current step description
 * @param {string} statusText - Status text for the embed
 */
async function updateProcessingProgress(interaction, currentStep, statusText) {
  try {
    const progressEmbed = new EmbedBuilder()
      .setColor(embedColors.warning)
      .setTitle('⏹️ Recording Stopped')
      .setDescription(`Processing streaming transcription and generating summary...

**Current Step:** ${currentStep}`)
      .addFields(
        { name: '🔄 Processing Status', value: statusText, inline: false }
      )
      .setFooter({ text: 'Streaming transcription - much faster than file-based!' })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [progressEmbed] });
  } catch (error) {
    console.warn('⚠️ [STOP] Could not update progress:', error.message);
  }
}

/**
 * Creates an error embed
 * @param {string} title - Error title
 * @param {string} description - Error description
 * @returns {EmbedBuilder} Error embed
 */
function createErrorEmbed(title, description) {
  return new EmbedBuilder()
    .setColor(embedColors.error)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

/**
 * Checks if user has permission to use the command
 * @param {Object} interaction - Discord interaction
 * @returns {boolean} True if user has permission
 */
function hasPermission(interaction) {
  // Check for Manage Channels permission
  if (interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
    return true;
  }
  // Check for specific role if configured
  if (config.discord.allowedRoleId) {
    return interaction.member?.roles?.cache?.has(config.discord.allowedRoleId);
  }
  return false;
}

/**
 * Creates a summary embed for the completed transcription
 * @param {Object} summary - Generated summary
 * @param {Object} transcript - Final transcript
 * @param {Object} recordingInfo - Recording information
 * @param {string} error - Error message if any
 * @returns {EmbedBuilder} Summary embed
 */
async function createSummaryEmbed(summary, transcript, recordingInfo, error = null) {
  const embed = new EmbedBuilder()
    .setColor(error ? embedColors.warning : embedColors.success)
    .setTitle('📝 Meeting Summary')
    .setTimestamp();
  
  if (error) {
    embed.setDescription(`⚠️ **Processing completed with errors**

${error}`)
         .addFields(
           { name: '⚠️ Error Details', value: error, inline: false }
         );
  } else if (summary && transcript) {
    // Truncate summary if too long for Discord embed limits
    // Accept either a string summary or a structured summary object returned by generateMeetingSummary
    const maxSummaryLength = 3000;
    let summaryText = '';
    if (typeof summary === 'string') {
      summaryText = summary;
    } else if (summary && typeof summary === 'object') {
      // Render the structured summary object into readable, ordered text for embeds
      summaryText = formatSummaryObject(summary);
    } else {
      summaryText = String(summary || 'No summary available');
    }

    summaryText = summaryText.length > maxSummaryLength ? summaryText.substring(0, maxSummaryLength) + '\n\n*[Summary truncated for Discord embed limits]*' : summaryText;
      // Safely extract statistics (some runs may not populate every field)
      const words = transcript?.statistics?.totalWords ?? transcript?.wordCount ?? 0;
  const participantsCount = recordingInfo?.participants ?? transcript?.statistics?.participantCount ?? (Array.isArray(transcript?.participants) ? transcript.participants.length : (transcript?.rawParticipantsMap ? Object.keys(transcript.rawParticipantsMap).length : 0));
      const avgConf = typeof transcript?.statistics?.averageConfidence === 'number' ? transcript.statistics.averageConfidence : 0;
      const participantsList = (Array.isArray(transcript?.participants) && transcript.participants.length > 0)
        ? transcript.participants.map(p => `• ${p.name || p.username || 'Unknown'}`).slice(0, 10).join('\n')
        : 'No participants identified';

      embed.setDescription(summaryText)
           .addFields(
             { 
               name: '📊 Statistics', 
               value: `**Words:** ${words}\n**Participants:** ${participantsCount}\n**Confidence:** ${avgConf.toFixed(1)}%\n**Duration:** ${formatDuration(recordingInfo.duration)}`,
               inline: true 
             },
             { 
               name: '👥 Participants', 
               value: participantsList,
               inline: true 
             }
           );
  } else {
  embed.setDescription('❌ **No transcript or summary available**\n\nThe recording may not have captured any speech.');
  }
  
      // Attach raw transcript as a .txt file (safe for large text) to the transcript channel with metadata
      try {
  const transcriptText = transcript && transcript.combinedText ? transcript.combinedText : (typeof transcript === 'string' ? transcript : JSON.stringify(transcript || {}, null, 2));

  const startDate = recordingInfo?.startTime ? new Date(recordingInfo.startTime) : new Date();
        const endDate = new Date();
        const startCT = startDate.toLocaleString('en-US', { timeZone: 'America/Chicago' });
        const endCT = endDate.toLocaleString('en-US', { timeZone: 'America/Chicago' });
  const durationStr = recordingInfo?.duration ? formatDuration(recordingInfo.duration) : (transcript?.duration ? formatDuration(transcript.duration) : 'Unknown');
  const speakerCount = recordingInfo?.participants ?? (Array.isArray(transcript?.participants) ? transcript.participants.length : (transcript?.statistics?.participantCount ?? 0));

        const header = `Meeting Transcript\nStart (Central Time): ${startCT}\nEnd (Central Time): ${endCT}\nDuration: ${durationStr}\nSpeakers identified: ${speakerCount}\n\n--- RAW TRANSCRIPT BELOW ---\n\n`;
        const fileContent = header + transcriptText;
        const startIso = startDate.toISOString().slice(0,19).replace(/[:T]/g,'-');
        const filename = `transcript-${startIso}.txt`;

        const buffer = Buffer.from(fileContent, 'utf-8');
        if (transcriptChannel) {
          await transcriptChannel.send({ content: `📁 Transcript attached for session (started ${startCT} Central Time).`, files: [{ attachment: buffer, name: filename }] });
        } else {
          // If transcript channel missing, send to summary channel as fallback
          await summaryChannel.send({ content: `📁 Transcript attached for session (started ${startCT} Central Time).`, files: [{ attachment: buffer, name: filename }] });
        }
      } catch (attachErr) {
        console.warn('⚠️ [STOP] Could not attach transcript file to transcript channel:', attachErr.message);
        // Fallback: send transcript as multiple messages (code blocks) to transcript channel or summary channel if missing
        try {
          const transcriptText = transcript && transcript.combinedText ? transcript.combinedText : (typeof transcript === 'string' ? transcript : JSON.stringify(transcript || {}, null, 2));
          const CHUNK_MAX = 1990;
          const chunks = splitTextIntoChunks(transcriptText, CHUNK_MAX);
          const MAX_CHUNKS = 50;
          const outChannel = transcriptChannel || summaryChannel;

          if (chunks.length === 0) {
            await outChannel.send({ content: '⚠️ Transcript was empty and could not be attached.' });
          } else if (chunks.length > MAX_CHUNKS) {
            await outChannel.send({ content: `⚠️ Transcript is very large (${chunks.length} parts). Sending first ${MAX_CHUNKS} parts; the rest is truncated. Consider configuring cloud storage for large transcripts.` });
            for (let i = 0; i < MAX_CHUNKS; i++) await outChannel.send({ content: '```\n' + chunks[i] + '\n```' });
            await outChannel.send({ content: `⚠️ Transcript truncated after ${MAX_CHUNKS} parts.` });
          } else {
            await outChannel.send({ content: `⚠️ Could not attach transcript as a file. Falling back to sending the transcript in ${chunks.length} message(s).` });
            for (const c of chunks) await outChannel.send({ content: '```\n' + c + '\n```' });
            await outChannel.send({ content: '✅ Full transcript sent (split across multiple messages).' });
          }
        } catch (sendErr) {
          console.error('❌ [STOP] Failed to send transcript fallback messages:', sendErr);
          const outChannel = transcriptChannel || summaryChannel;
          await outChannel.send({ content: '⚠️ Could not attach or send the full transcript due to size or permission limits. Please check bot logs or configure external storage (S3/Drive) for large transcripts.' });
        }
      }
  
  return false;
}

/**
 * Formats duration in milliseconds to human readable format
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Formats a structured summary object into readable ordered text suitable for embed descriptions
 * @param {Object} summary - Structured summary object returned by the summarizer
 * @returns {string} Formatted text
 */
function formatSummaryObject(summary) {
  try {
    const parts = [];

    if (summary.title && typeof summary.title === 'string') {
      parts.push(`**${summary.title.trim()}**`);
    }

    if (summary.briefOverview && typeof summary.briefOverview === 'string' && summary.briefOverview.trim()) {
      parts.push(summary.briefOverview.trim());
    }

    // Chronological / chronologicalSections (ordered)
    if (Array.isArray(summary.chronologicalSections) && summary.chronologicalSections.length > 0) {
      parts.push('\n**Chronological Sections:**');
      for (const sec of summary.chronologicalSections) {
        const heading = sec.heading || sec.title || sec.timestamp || sec.speaker || null;
        if (heading) parts.push(`\n**${heading}**`);
        if (Array.isArray(sec.points) && sec.points.length > 0) {
          for (const p of sec.points) {
            if (p && String(p).trim()) parts.push(`• ${String(p).trim()}`);
          }
        } else if (sec.content && String(sec.content).trim()) {
          parts.push(`• ${String(sec.content).trim()}`);
        }
      }
    }

    // Action items
    if (Array.isArray(summary.actionItems) && summary.actionItems.length > 0) {
      parts.push('\n**Action Items:**');
      for (const ai of summary.actionItems) {
        if (typeof ai === 'string') {
          if (ai.trim()) parts.push(`• ${ai.trim()}`);
        } else if (ai && typeof ai === 'object') {
          const action = ai.action || ai.title || ai.task || '';
          const assignee = ai.assignee || ai.owner || ai.person || 'Unassigned';
          const due = ai.due || ai.dueDate || ai.due_at || null;
          const dueStr = due ? ` — Due: ${due}` : '';
          if (action) parts.push(`• ${action}${dueStr} — Assignee: ${assignee}`);
        }
      }
    }

    // Decisions
    if (Array.isArray(summary.decisionsMade) && summary.decisionsMade.length > 0) {
      parts.push('\n**Decisions Made:**');
      for (const d of summary.decisionsMade) {
        if (typeof d === 'string' && d.trim()) parts.push(`• ${d.trim()}`);
        else if (d && typeof d === 'object' && (d.title || d.decision)) parts.push(`• ${d.title || d.decision}`);
      }
    }

    // Next steps
    if (summary.nextSteps && typeof summary.nextSteps === 'string' && summary.nextSteps.trim()) {
      parts.push('\n**Next Steps:**');
      parts.push(summary.nextSteps.trim());
    }

    const out = parts.join('\n');
    // Ensure we don't return an empty string
    return out && out.trim() ? out : (summary.briefOverview || 'No summary available.');
  } catch (err) {
    console.warn('⚠️ [STOP] Failed to format structured summary for embed:', err.message || err);
    return summary.briefOverview || (typeof summary.rawSummary === 'string' ? summary.rawSummary : JSON.stringify(summary || {}, null, 2));
  }
}