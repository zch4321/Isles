import MarkdownIt from 'markdown-it';

// Raw HTML stays escaped and markdown-it's link validation rejects script/data URLs.
// Images are disabled so an Agent's message cannot make the browser fetch remote resources.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
md.disable('image');

md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index]!.attrSet('target', '_blank');
  tokens[index]!.attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, index, options);
};

// Fenced code gets a header with the language and a copy button; MarkdownContent handles the click.
md.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]!;
  const language = token.info.trim().split(/\s+/)[0] || 'text';
  return (
    `<div class="md-code"><div class="md-code-bar"><span>${md.utils.escapeHtml(language)}</span>` +
    `<button type="button" data-copy-code>复制</button></div>` +
    `<pre><code>${md.utils.escapeHtml(token.content)}</code></pre></div>`
  );
};

export const renderMarkdown = (source: string) => md.render(source);
