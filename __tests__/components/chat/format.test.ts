import { splitMessageText, stripHiddenUriSchemes } from '@/components/chat/format';

describe('splitMessageText', () => {
  it('returns the whole string as a single plain segment when there is no link', () => {
    expect(splitMessageText('hello world')).toEqual([{ text: 'hello world' }]);
  });

  it('extracts an http(s) link surrounded by text', () => {
    expect(splitMessageText('see https://example.com for info')).toEqual([
      { text: 'see ' },
      { text: 'https://example.com', uri: 'https://example.com' },
      { text: ' for info' },
    ]);
  });

  it('strips trailing sentence punctuation from a link', () => {
    expect(splitMessageText('check https://example.com/path.')).toEqual([
      { text: 'check ' },
      { text: 'https://example.com/path', uri: 'https://example.com/path' },
      { text: '.' },
    ]);
  });

  it('adds an https scheme when opening a bare www. link', () => {
    expect(splitMessageText('go to www.example.com now')).toEqual([
      { text: 'go to ' },
      { text: 'www.example.com', uri: 'https://www.example.com' },
      { text: ' now' },
    ]);
  });

  it('detects mailto and tel URIs but hides their scheme prefix from the display text', () => {
    expect(splitMessageText('mailto:a@b.com or tel:+15551234567')).toEqual([
      { text: 'a@b.com', uri: 'mailto:a@b.com' },
      { text: ' or ' },
      { text: '+15551234567', uri: 'tel:+15551234567' },
    ]);
  });

  it('detects multiple links in the same message', () => {
    expect(splitMessageText('https://a.com and https://b.com')).toEqual([
      { text: 'https://a.com', uri: 'https://a.com' },
      { text: ' and ' },
      { text: 'https://b.com', uri: 'https://b.com' },
    ]);
  });
});

describe('stripHiddenUriSchemes', () => {
  it('removes mailto: and tel: scheme prefixes, leaving the rest of the text untouched', () => {
    expect(stripHiddenUriSchemes('mailto:a@b.com or tel:+15551234567')).toBe(
      'a@b.com or +15551234567',
    );
  });

  it('leaves http(s) links untouched', () => {
    expect(stripHiddenUriSchemes('see https://example.com')).toBe('see https://example.com');
  });

  it('returns the text unchanged when there is nothing to hide', () => {
    expect(stripHiddenUriSchemes('hello world')).toBe('hello world');
  });
});
