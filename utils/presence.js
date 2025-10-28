import { ActivityType } from 'discord.js';

// Manage bot presence and per-guild nickname to reflect recording states
// Default display name (nickname) used across guilds
const DEFAULT_NAME = 'transcord';

const STATE_MAP = {
  idle: { emoji: '⬡', text: 'transcord - idle', status: 'online', nickname: `${DEFAULT_NAME}` },
  looking: { emoji: '🔶', text: 'Looking for participants • /join', status: 'idle', nickname: `🔶 ${DEFAULT_NAME}` },
  recording: { emoji: '🟢', text: 'Recording', status: 'dnd', nickname: `🟢 Recording` },
  stopped: { emoji: '🔴', text: 'Recording stopped', status: 'online', nickname: `🔴 Stopped` }
};

/**
 * Set bot presence and optionally set nickname in a specific guild (or all guilds)
 * @param {import('discord.js').Client} client
 * @param {'idle'|'looking'|'recording'|'stopped'} state
 * @param {string|null} guildId - if provided, only set nickname in that guild; otherwise apply to all guilds
 */
export async function setBotState(client, state = 'idle', guildId = null) {
  if (!client || !client.user) return;
  const s = STATE_MAP[state] || STATE_MAP.idle;

  try {
    // Update global presence
    await client.user.setPresence({
      activities: [{ name: `${s.emoji} ${s.text}`, type: ActivityType.Watching }],
      status: s.status
    });
  } catch (err) {
    console.warn('⚠️ [PRESENCE] Could not set presence:', err.message);
  }

  // Try setting nickname in guild(s)
  try {
    const guilds = guildId ? [client.guilds.cache.get(guildId)].filter(Boolean) : Array.from(client.guilds.cache.values());
    for (const guild of guilds) {
      try {
        const member = await guild.members.fetch(client.user.id);
        if (!member) continue;
        // Attempt to set nickname; may fail if bot lacks permissions
        await member.setNickname(s.nickname).catch(err => {
          // swallow permission errors
          if (err.code !== 50013) console.warn('⚠️ [PRESENCE] Could not set nickname in', guild.name, err.message);
        });
      } catch (err) {
        // ignore per-guild failures
      }
    }
  } catch (err) {
    console.warn('⚠️ [PRESENCE] Error while setting nicknames:', err.message);
  }
}

export default { setBotState };
