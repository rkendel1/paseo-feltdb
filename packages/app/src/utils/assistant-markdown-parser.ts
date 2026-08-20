import MarkdownIt from "markdown-it";

interface MarkdownParseProfileSample {
  sourceChars: number;
  durationMs: number;
  tokens: number;
}

declare global {
  var __PASEO_MARKDOWN_PARSE_PROFILE__: MarkdownParseProfileSample[] | undefined;
}

export function createAssistantMarkdownParser(): MarkdownIt {
  const parser = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
  });
  const defaultValidateLink = parser.validateLink.bind(parser);

  parser.validateLink = (url: string) =>
    url.trim().toLowerCase().startsWith("file://") || defaultValidateLink(url);

  const profile = globalThis.__PASEO_MARKDOWN_PARSE_PROFILE__;
  if (!profile) {
    return parser;
  }

  const defaultParse = parser.parse.bind(parser);
  parser.parse = (source: string, env: unknown) => {
    const startedAt = performance.now();
    const tokens = defaultParse(source, env);
    profile.push({
      sourceChars: source.length,
      durationMs: performance.now() - startedAt,
      tokens: tokens.length,
    });
    return tokens;
  };
  return parser;
}
