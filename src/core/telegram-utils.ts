/**
 * Shared Telegram utility functions.
 *
 * Raw REST API helpers that don't depend on grammY or any connection layer.
 * Safe to import from the scheduler daemon, the Telegram connection, or any
 * other code that needs to send Telegram messages without spinning up a full bot.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Telegram's hard cap on sendMessage text length. */
export const TELEGRAM_MAX_LENGTH = 4096;

// ── Message chunking ──────────────────────────────────────────────────────────

/**
 * Split a string into chunks that fit within Telegram's 4096-char limit.
 * Tries to split on newlines to avoid breaking words/sentences mid-chunk.
 * Falls back to a hard split at maxLen if no suitable newline is found.
 */
export function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let split = remaining.lastIndexOf("\n", maxLen);
    // Only use the newline split if it's at least halfway through the max length.
    // Otherwise we'd produce tiny chunks for text with early newlines.
    if (split < maxLen * 0.5) split = maxLen;

    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }

  return chunks;
}

// ── Raw API send ──────────────────────────────────────────────────────────────

/**
 * Send a Telegram message via the raw Bot API, chunking automatically if
 * the text exceeds the 4096-char limit.
 *
 * @param token   - Telegram bot token (e.g. "123456:ABC-DEF...")
 * @param chatId  - Target chat or user ID
 * @param text    - Message text (will be split into multiple messages if needed)
 * @throws        - On non-2xx API responses
 */
export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string
): Promise<void> {
  for (const chunk of splitMessage(text)) {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram API error ${res.status}: ${body}`);
    }
  }
}
