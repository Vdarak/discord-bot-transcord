import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { embedColors, config } from '../config.js';

/**
 * Help Command - Shows bot usage instructions and available commands
 */

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show bot usage instructions and available commands');

export async function execute(interaction) {
  try {
    console.log(`❓ Help command executed by ${interaction.user.tag}`);
    
    await interaction.deferReply({ ephemeral: true });
    
    const embed = new EmbedBuilder()
      .setColor(embedColors.info)
      .setTitle('🤖 Discord Voice Recording Bot - Help')
      .setDescription('This bot records voice channel meetings, transcribes them using AssemblyAI, and generates summaries with Google Gemini AI.')
      .addFields(
        {
          name: '📋 Available Commands',
          value: `\`/join\` - Join your voice channel and start recording\\n\`/stop\` - Stop recording and generate meeting summary\\n\`/recording-status\` - Check current recording status\\n\`/help\` - Show this help message`,
          inline: false
        },
        {
          name: '🔒 Permissions Required',
          value: config.discord.allowedRoleId 
            ? `• **Manage Channels** permission OR\\n• Role: <@&${config.discord.allowedRoleId}>`
            : '• **Manage Channels** permission',
          inline: false
        },
        {
          name: '🎤 How to Use',
          value: `1️⃣ Join a voice channel with other participants\\n2️⃣ Use \`/join\` to start recording\\n3️⃣ Conduct your meeting normally\\n4️⃣ Use \`/stop\` to end recording\\n5️⃣ Wait for transcription and summary\\n6️⃣ Check <#${config.discord.summaryChannelId}> for results`,
          inline: false
        },
        {
          name: '⚙️ Recording Features',
          value: `• **Per-user audio separation** - Each participant recorded individually\\n• **Automatic transcription** - Powered by AssemblyAI\\n• **AI-generated summaries** - Using Google Gemini\\n• **Automatic cleanup** - Temporary files removed after processing\\n• **Privacy indicators** - Bot shows 🔴 Recording status`,
          inline: false
        },
        {
          name: '📊 Limitations & Settings',
          value: `• **Max Duration:** ${config.recording.maxDurationHours} hours\\n• **Auto-stop:** After ${config.recording.silenceTimeoutMinutes} minutes of silence\\n• **Max File Size:** ${config.recording.maxFileSizeMB} MB per user\\n• **Concurrent Transcriptions:** ${config.assemblyAI.maxConcurrent} max`,
          inline: false
        },
        {
          name: '🔒 Privacy & Consent',
          value: `• Bot presence in voice channel indicates recording is active\\n• Bot nickname changes to "🔴 Recording" during sessions\\n• All participants are notified when recording starts\\n• Temporary audio files are automatically deleted after processing\\n• Only designated summary channel receives final results`,
          inline: false
        },
        {
          name: '⚠️ Important Notes',
          value: `• **Only one recording** can be active at a time\\n• **All participants** in the voice channel will be recorded\\n• **Bot must have** Connect and Speak permissions in voice channels\\n• **Recording continues** even if participants leave/join during session\\n• **Summary generation** may take several minutes for long recordings`,
          inline: false
        }
      )
      .setFooter({ 
        text: `Bot Version 1.0 | Powered by AssemblyAI & Google Gemini AI` 
      })
      .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
    
  } catch (error) {
    console.error('❌ Help command error:', error);
    
    const errorEmbed = new EmbedBuilder()
      .setColor(embedColors.error)
      .setTitle('❌ Help Command Failed')
      .setDescription('Could not display help information.')
      .setTimestamp();
    
    try {
      await interaction.editReply({ embeds: [errorEmbed] });
    } catch (replyError) {
      console.error('❌ Could not send error reply:', replyError);
    }
  }
}

export default {
  data,
  execute
};