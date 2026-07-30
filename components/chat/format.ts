/** Compact HH:MM time label shared across chat timeline components. */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const URI_REGEX = /(https?:\/\/[^\s]+|ftp:\/\/[^\s]+|mailto:[^\s]+|tel:[^\s]+|www\.[^\s]+)/gi;
const TRAILING_PUNCTUATION_REGEX = /[).,;:!?\]}'"]+$/;
// `mailto:`/`tel:` are implementation detail, not content — always shown to
// the user as the bare email/number they wrap, never the scheme prefix.
const HIDDEN_SCHEME_REGEX = /\b(?:mailto|tel):/gi;

export interface MessageTextSegment {
  text: string;
  /** Present when this segment is a link; the URL to open on press. */
  uri?: string;
}

/** Strips `mailto:`/`tel:` scheme prefixes, which are never meant to be shown to the user. */
export function stripHiddenUriSchemes(text: string): string {
  return text.replace(HIDDEN_SCHEME_REGEX, '');
}

/** Splits message text into plain-text and link segments, for rendering tappable URIs. */
export function splitMessageText(text: string): MessageTextSegment[] {
  const segments: MessageTextSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URI_REGEX)) {
    const start = match.index ?? 0;
    let raw = match[0];
    const trailingMatch = raw.match(TRAILING_PUNCTUATION_REGEX);
    const trailingLength = trailingMatch ? trailingMatch[0].length : 0;
    raw = raw.slice(0, raw.length - trailingLength);
    if (!raw) continue;

    if (start > lastIndex) {
      segments.push({ text: text.slice(lastIndex, start) });
    }
    segments.push({
      text: stripHiddenUriSchemes(raw),
      uri: raw.toLowerCase().startsWith('www.') ? `https://${raw}` : raw,
    });
    lastIndex = start + raw.length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  return segments;
}
